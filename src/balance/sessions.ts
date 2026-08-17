/**
 * Which account serves a given session.
 *
 * Without this, one OpenCode process has one active account and every session
 * and subagent inside it queues against the same subscription. Since subagents
 * arrive as their own sessions, binding per session lets N parallel subagents
 * run on N accounts — and it stops the prompt cache thrashing, because a session
 * keeps its account instead of following a global rotation.
 *
 * The map is per-process and deliberately not persisted: a session id means
 * nothing in a later process, and writing it would be state two OpenCode windows
 * could fight over.
 *
 * Bindings are decided by the same `selectAccount` the global path uses, so
 * pools, strategies, health and ejection all behave identically — a session is
 * simply a separate consumer of one decision function.
 */

import { type ClaudeAuthConfig, getConfig } from "../config.ts"
import {
  AUTO_SOURCE,
  PRESET_PREFIX,
  type ClaudeCredentials,
  listAccounts,
  loadPersistedAccountSource,
  refreshIfNeeded,
} from "../credentials.ts"
import { log } from "../logger.ts"
import { credentialState, resolveActiveConfig } from "./rotate.ts"
import { currentUsageIndex } from "./usage.ts"
import { type Health, type Member, assess, selectAccount } from "./balancer.ts"
import { type QuotaCache, readQuotaCache } from "./quota.ts"

type Binding = { source: string; boundAt: number; lastSeen: number }

const bindings = new Map<string, Binding>()

/**
 * Sessions outlive nothing in particular, so the map is swept rather than
 * grown forever. An hour idle is well past any live conversation.
 */
const IDLE_MS = 60 * 60_000
const MAX_SESSIONS = 500

export function boundSource(sessionId: string): string | undefined {
  return bindings.get(sessionId)?.source
}

export function bindSession(
  sessionId: string,
  source: string,
  nowMs: number = Date.now(),
): void {
  bindings.set(sessionId, {
    source,
    boundAt: bindings.get(sessionId)?.boundAt ?? nowMs,
    lastSeen: nowMs,
  })
  sweep(nowMs)
}

export function forgetSession(sessionId: string): void {
  bindings.delete(sessionId)
}

export function resetBindings(): void {
  bindings.clear()
}

/** Visible for the status tool: who is on what. */
export function listBindings(): Array<{ sessionId: string; source: string }> {
  return [...bindings.entries()].map(([sessionId, b]) => ({
    sessionId,
    source: b.source,
  }))
}

function sweep(nowMs: number): void {
  if (bindings.size <= MAX_SESSIONS) {
    for (const [id, b] of bindings) {
      if (nowMs - b.lastSeen > IDLE_MS) bindings.delete(id)
    }
    return
  }
  // Over the cap, drop the least recently seen rather than the oldest bound:
  // a long-running session is exactly the one worth keeping.
  const ordered = [...bindings.entries()].sort(
    (a, b) => a[1].lastSeen - b[1].lastSeen,
  )
  for (const [id] of ordered.slice(0, bindings.size - MAX_SESSIONS)) {
    bindings.delete(id)
  }
}

export type SessionDecision = {
  source: string
  /** True when this session was not already on that account. */
  changed: boolean
  reason: string
}

/**
 * The account this session should use for its next request.
 *
 * A session keeps its account while that account is usable, which is what makes
 * the binding worth having. It moves only when its own account is spent — and
 * then only that session moves, leaving every other session where it is.
 *
 * A new session is selected with `activeSource: null` on purpose: passing the
 * globally active account would make `sticky` hand every new session the same
 * one, and rotating strategies would never get to spread anything.
 */
export function resolveForSession(
  sessionId: string,
  members: readonly Member[],
  cache: QuotaCache,
  cfg: ClaudeAuthConfig,
  nowMs: number = Date.now(),
  opts: {
    usage?: Record<string, { requests: number; lastUsedAt: number }>
  } = {},
): SessionDecision | undefined {
  const current = boundSource(sessionId)

  if (current) {
    const health: Health | undefined = assess(
      members.filter((m) => m.source === current),
      cache,
      cfg,
      nowMs,
    )[0]
    if (health?.healthy) {
      bindSession(sessionId, current, nowMs)
      return { source: current, changed: false, reason: "already bound" }
    }
  }

  const decision = selectAccount(members, cache, cfg, null, nowMs, opts)
  if (!decision) return undefined

  bindSession(sessionId, decision.source, nowMs)
  return {
    source: decision.source,
    changed: decision.source !== current,
    reason: current
      ? `rebound from a spent account via ${decision.strategy}`
      : `bound via ${decision.strategy} in ${decision.pool}`,
  }
}

/**
 * Internal marker carrying the session id from `chat.headers` to the custom
 * fetch, which is the only bridge between the two — the provider is registered
 * once, for every session. Stripped before the request leaves.
 */
export const SESSION_HEADER = "x-claude-auth-session"

/**
 * Credentials for this session's own account.
 *
 * Returns null to mean "use the global path": with no binding possible, or a
 * pin in force, there is nothing per-session to resolve and the caller's
 * existing behaviour is correct.
 *
 * `refreshIfNeeded` is given the target account explicitly, so an expired token
 * is refreshed under that account's own lock without touching the globally
 * active account — mutating it here would let concurrent sessions hand each
 * other the wrong token.
 */
export function resolveSessionCredentials(
  sessionId: string,
): ClaudeCredentials | null {
  const cfg = getConfig()
  if (cfg.bindBy !== "session") return null

  // A pin is an instruction that every request use one account; per-session
  // choice would quietly contradict it.
  const persisted = loadPersistedAccountSource()
  const pinned =
    persisted &&
    persisted !== AUTO_SOURCE &&
    !persisted.startsWith(PRESET_PREFIX)
  if (pinned && cfg.pinBlocksRotation) return null

  const accounts = listAccounts()
  if (accounts.length <= 1) return null

  const { cfg: effective } = resolveActiveConfig(cfg, persisted)
  const members = accounts.map((a) => ({
    source: a.source,
    label: a.label,
    credential: credentialState(a),
  }))

  const wantsUsage =
    effective.strategy === "least-used" ||
    effective.pools.some((p) => p.strategy === "least-used")

  const decision = resolveForSession(
    sessionId,
    members,
    readQuotaCache(),
    effective,
    Date.now(),
    { usage: wantsUsage ? currentUsageIndex() : {} },
  )
  if (!decision) return null

  const account = accounts.find((a) => a.source === decision.source)
  if (!account) return null

  if (decision.changed) {
    log("session_bound", {
      sessionId,
      source: decision.source,
      reason: decision.reason,
    })
  }

  return refreshIfNeeded(account) ?? account.credentials
}
