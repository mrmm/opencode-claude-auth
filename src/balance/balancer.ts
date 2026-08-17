/**
 * Which account should serve the next request.
 *
 * Everything here is a pure function of (members, quota cache, config, now)
 * plus one explicit ejection map, so the whole policy is testable without a
 * Keychain, a network, or a clock. `index.ts` owns the side effects: it reads
 * the config fresh at each decision — which is what keeps the strategy and the
 * pools hot-reloadable — and calls `setActiveAccountSource()` with the answer.
 *
 * Health is *derived*, not stored. An account is spent when the quota cache
 * says so, and it becomes healthy again when the window's own `resetsAt`
 * passes. Anthropic hands us that timestamp, so there is nothing to persist
 * and nothing to expire by guesswork. The one exception is a rejection that
 * arrives without a usable reset time; that gets a bounded, backing-off entry
 * in the ejection map, which is per-process and deliberately not written to
 * disk (see `ejections` below).
 */

import type {
  BalanceStrategy,
  ClaudeAuthConfig,
  Pool,
  SwitchWindow,
} from "../config.ts"
import {
  type AccountQuota,
  type QuotaCache,
  type QuotaWindow,
  bindingWindow,
  quotaForAccount,
} from "./quota.ts"

/**
 * Whether an account's stored credentials can serve a request.
 *
 * Quota is not the only way an account can be unusable: one can hold plenty of
 * headroom and still have a token that expired days ago. `refreshable` is a
 * candidate rather than a fault — the credential path recovers those — but it is
 * ranked behind an account that needs no recovery at all.
 */
export type CredentialState = "ok" | "refreshable" | "unusable"

export type Member = {
  source: string
  label?: string
  credential?: CredentialState
}

export type Health = {
  source: string
  /** Utilisation on the configured window, or undefined when unknown. */
  utilization?: number
  /** Unix seconds the binding window resets, when known. */
  resetsAt?: number
  credential: CredentialState
  healthy: boolean
  /** Why it is unhealthy, for the log. "" when healthy. */
  reason: string
}

// ---------------------------------------------------------------------------
// Ejection: only for rejections we cannot date from a header
// ---------------------------------------------------------------------------

type Ejection = { until: number; count: number }

/**
 * Per-process, in-memory, and intentionally so.
 *
 * Two OpenCode windows share a Keychain and a quota cache but must be free to
 * sit on different accounts — that is the point of balancing. Persisting an
 * ejection would let one process's 429 move another process's account, which
 * is the same class of cross-process interference the per-account refresh lock
 * exists to prevent.
 */
const ejections = new Map<string, Ejection>()

/** Eject `source` for `ejectFor` x consecutive ejections, capped at an hour. */
export function eject(
  source: string,
  cfg: Pick<ClaudeAuthConfig, "ejectFor">,
  nowMs: number = Date.now(),
): Ejection {
  const prev = ejections.get(source)
  const count = (prev?.count ?? 0) + 1
  const base = cfg.ejectFor > 0 ? cfg.ejectFor : 0
  const until = nowMs + Math.min(base * count, 60 * 60_000)
  const next = { until, count }
  ejections.set(source, next)
  return next
}

/** Called when an account serves a request successfully. */
export function clearEjection(source: string): void {
  ejections.delete(source)
}

export function ejectedUntil(
  source: string,
  nowMs: number = Date.now(),
): number | undefined {
  const e = ejections.get(source)
  if (!e) return undefined
  if (e.until <= nowMs) {
    // Expired entries are dropped on read so the backoff count only survives
    // while the account keeps failing, not forever.
    ejections.delete(source)
    return undefined
  }
  return e.until
}

/** Test seam. */
export function resetEjections(): void {
  ejections.clear()
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function windowFor(
  q: AccountQuota,
  which: SwitchWindow,
): QuotaWindow | undefined {
  if (which === "5h") return q.fiveHour
  if (which === "7d") return q.sevenDay
  return bindingWindow(q)
}

/**
 * A window that has already reset is spent no longer: `resetsAt` in the past
 * means the utilisation figure describes a window that no longer exists.
 */
function effectiveUtilization(
  w: QuotaWindow | undefined,
  nowSec: number,
): number | undefined {
  if (!w) return undefined
  if (w.resetsAt !== undefined && w.resetsAt <= nowSec) return 0
  return w.utilization
}

export function assess(
  members: readonly Member[],
  cache: QuotaCache,
  cfg: Pick<ClaudeAuthConfig, "switchAt" | "switchWindow" | "quotaMaxAge">,
  nowMs: number = Date.now(),
): Health[] {
  const nowSec = Math.floor(nowMs / 1000)
  const maxAgeSeconds = Math.floor((cfg.quotaMaxAge ?? 0) / 1000) || undefined

  return members.map((m) => {
    const credential = m.credential ?? "ok"

    // Headroom is irrelevant if the account cannot authenticate at all.
    if (credential === "unusable") {
      return {
        source: m.source,
        credential,
        healthy: false,
        reason: "credentials expired and cannot be refreshed",
      }
    }

    const held = ejectedUntil(m.source, nowMs)
    if (held !== undefined) {
      return {
        source: m.source,
        credential,
        healthy: false,
        reason: `ejected for ${Math.ceil((held - nowMs) / 1000)}s`,
      }
    }

    const q = quotaForAccount(m.source, cache, nowSec, maxAgeSeconds)
    if (!q) {
      // No reading is not a fault. An unprobed account is assumed usable —
      // refusing it would strand a fresh install where nothing has been
      // measured yet — but `least-loaded` still ranks it behind any account
      // whose headroom is actually known.
      return { source: m.source, credential, healthy: true, reason: "" }
    }

    const w = windowFor(q, cfg.switchWindow)
    const util = effectiveUtilization(w, nowSec)

    if (w?.status === "rejected" && (w.resetsAt ?? 0) > nowSec) {
      return {
        source: m.source,
        utilization: util,
        resetsAt: w.resetsAt,
        credential,
        healthy: false,
        reason: "server rejected",
      }
    }
    if (util !== undefined && util >= cfg.switchAt) {
      return {
        source: m.source,
        utilization: util,
        resetsAt: w?.resetsAt,
        credential,
        healthy: false,
        reason: `at ${Math.round(util * 100)}% of ${cfg.switchWindow}`,
      }
    }
    return {
      source: m.source,
      utilization: util,
      resetsAt: w?.resetsAt,
      credential,
      healthy: true,
      reason: "",
    }
  })
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * The configured tiers, narrowed to accounts that actually exist.
 *
 * With no pools declared, everything collapses to a single implicit tier —
 * `accounts` when set, otherwise every member — so the common one-tier setup
 * needs no pool config at all. A configured account that matches nothing live
 * is dropped rather than honoured, and a pool left empty by that is dropped
 * too: a stale config must not be able to strand the plugin on no account.
 */
/**
 * Turn one account reference into a live Keychain source.
 *
 * A reference is either an exact source (`Claude Code-credentials-aaaa1111`) or
 * a case-insensitive fragment of the account's label (`Team B`). The fragment
 * form exists so a preset reads like the thing it is — "round-robin over Team A
 * and Team B" — rather than a row of hex suffixes nobody can check by eye.
 *
 * A fragment matching more than one account returns undefined rather than
 * guessing: silently picking one of two plausible accounts is worse than saying
 * the reference was no good.
 */
export function resolveRef(
  ref: string,
  members: readonly Member[],
): string | undefined {
  const exact = members.find((m) => m.source === ref)
  if (exact) return exact.source

  const needle = ref.trim().toLowerCase()
  if (!needle) return undefined
  const hits = members.filter((m) => m.label?.toLowerCase().includes(needle))
  return hits.length === 1 ? hits[0]!.source : undefined
}

/** Resolve a list of references, reporting the ones that went nowhere. */
export function resolveAccountRefs(
  refs: readonly string[],
  members: readonly Member[],
): { sources: string[]; unresolved: string[] } {
  const sources: string[] = []
  const unresolved: string[] = []
  for (const ref of refs) {
    const source = resolveRef(ref, members)
    if (!source) unresolved.push(ref)
    else if (!sources.includes(source)) sources.push(source)
  }
  return { sources, unresolved }
}

export function resolvePools(
  members: readonly Member[],
  cfg: Pick<ClaudeAuthConfig, "pools" | "accounts" | "strategy">,
): Pool[] {
  const keep = (refs: string[]) => resolveAccountRefs(refs, members).sources

  if (cfg.pools.length > 0) {
    return cfg.pools
      .map((p) => ({ ...p, accounts: keep(p.accounts) }))
      .filter((p) => p.accounts.length > 0)
  }

  const flat =
    cfg.accounts.length > 0 ? keep(cfg.accounts) : members.map((m) => m.source)
  if (flat.length === 0) return []
  return [{ name: "default", accounts: flat }]
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export type StrategyInput = {
  /** Healthy candidates, in pool order. Never empty. */
  candidates: Health[]
  /** The account serving requests right now, if any. */
  activeSource: string | null
  pool: Pool
  /** Requests served per account, for `least-used`. Empty when unknown. */
  usage: Record<string, { requests: number; lastUsedAt: number }>
  /** Injected so the randomised strategies can be asserted in a test. */
  rng: () => number
}

export type StrategyFn = (input: StrategyInput) => string

/** Round-robin and weighted need a cursor; it is per-pool and per-process. */
const cursors = new Map<string, number>()
const swrrState = new Map<string, Map<string, number>>()

export function resetCursors(): void {
  cursors.clear()
  swrrState.clear()
}

/**
 * Preference order: a credential that works, then known headroom.
 *
 * An account needing a token refresh is usable but not free — it costs a round
 * trip and can still fail — so it loses to any account that is ready now, no
 * matter how much emptier it looks.
 */
function credentialRank(h: Health): number {
  return h.credential === "refreshable" ? 1 : 0
}

function byHeadroom(a: Health, b: Health): number {
  const byCredential = credentialRank(a) - credentialRank(b)
  if (byCredential !== 0) return byCredential
  const au = a.utilization
  const bu = b.utilization
  if (au === undefined && bu === undefined) return 0
  if (au === undefined) return 1
  if (bu === undefined) return -1
  return au - bu
}

const leastLoaded: StrategyFn = ({ candidates }) =>
  [...candidates].sort(byHeadroom)[0]!.source

const priority: StrategyFn = ({ candidates, pool }) => {
  const order = new Map(pool.accounts.map((s, i) => [s, i]))
  return [...candidates].sort(
    (a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0),
  )[0]!.source
}

/**
 * Keep the current account while it is healthy and in this pool.
 *
 * This is the default because Anthropic's prompt cache is per-account: moving
 * accounts starts the new one's cache cold, so the cheapest correct answer is
 * to stay put until the account is actually spent, then take the emptiest one.
 */
const sticky: StrategyFn = (input) => {
  const held = input.candidates.find((c) => c.source === input.activeSource)
  if (held) return held.source
  return leastLoaded(input)
}

const roundRobin: StrategyFn = ({ candidates, pool }) => {
  const key = pool.name
  const order = new Map(pool.accounts.map((s, i) => [s, i]))
  const ring = [...candidates].sort(
    (a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0),
  )
  const next = (cursors.get(key) ?? 0) % ring.length
  cursors.set(key, next + 1)
  return ring[next]!.source
}

/**
 * Smooth weighted round-robin (the nginx algorithm): each pass adds every
 * candidate's weight to its running score, the highest score serves, and that
 * winner pays the total weight back. Spreads a 3:1 split as ABABAB-style
 * interleaving rather than AAAB bursts, and is deterministic, so it can be
 * asserted in a test.
 */
const weighted: StrategyFn = ({ candidates, pool }) => {
  const key = pool.name
  let state = swrrState.get(key)
  if (!state) {
    state = new Map()
    swrrState.set(key, state)
  }

  const weightOf = (s: string) => pool.weights?.[s] ?? 1
  const total = candidates.reduce((sum, c) => sum + weightOf(c.source), 0)

  let best = candidates[0]!.source
  let bestScore = Number.NEGATIVE_INFINITY
  for (const c of candidates) {
    const score = (state.get(c.source) ?? 0) + weightOf(c.source)
    state.set(c.source, score)
    if (score > bestScore) {
      bestScore = score
      best = c.source
    }
  }
  state.set(best, (state.get(best) ?? 0) - total)
  return best
}

/**
 * Fewest requests served, per the usage log; oldest last-used breaks a tie.
 *
 * Where `least-loaded` reads Anthropic's view of consumption, this reads ours.
 * The two disagree usefully: utilisation is weighted by how expensive the
 * requests were, request count is not, so this spreads *turns* evenly while
 * `least-loaded` spreads *spend*. With no usage history it degrades to
 * `least-loaded` rather than picking arbitrarily.
 */
const leastUsed: StrategyFn = (input) => {
  const { candidates, usage } = input
  if (Object.keys(usage).length === 0) return leastLoaded(input)
  const scored = [...candidates].sort((a, b) => {
    const ua = usage[a.source] ?? { requests: 0, lastUsedAt: 0 }
    const ub = usage[b.source] ?? { requests: 0, lastUsedAt: 0 }
    return ua.requests - ub.requests || ua.lastUsedAt - ub.lastUsedAt
  })
  return scored[0]!.source
}

/** Uniform choice. Cheap, stateless, and surprisingly even over many turns. */
const random: StrategyFn = ({ candidates, rng }) =>
  candidates[
    Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))
  ]!.source

/**
 * Power of two choices: sample two at random, keep the emptier.
 *
 * Gets most of `least-loaded`'s balance without always stampeding onto whichever
 * account currently looks emptiest — the classic fix for the herd effect when
 * several processes decide independently, which is exactly this plugin's
 * situation with several OpenCode windows open.
 */
const p2c: StrategyFn = (input) => {
  const { candidates, rng } = input
  if (candidates.length === 1) return candidates[0]!.source
  const i = Math.floor(rng() * candidates.length)
  let j = Math.floor(rng() * candidates.length)
  if (j === i) j = (i + 1) % candidates.length
  const a = candidates[Math.min(i, candidates.length - 1)]!
  const b = candidates[Math.min(j, candidates.length - 1)]!
  return byHeadroom(a, b) <= 0 ? a.source : b.source
}

/**
 * The registry. A new algorithm is one entry here plus one name in
 * `BalanceStrategy` — nothing else in the plugin has to know about it, and the
 * exhaustive Record makes forgetting the entry a compile error.
 */
export const STRATEGIES: Record<BalanceStrategy, StrategyFn> = {
  sticky,
  priority,
  "least-loaded": leastLoaded,
  "round-robin": roundRobin,
  weighted,
  "least-used": leastUsed,
  random,
  p2c,
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type Decision = {
  source: string
  pool: string
  strategy: BalanceStrategy
  /** True when this differs from the account serving requests now. */
  changed: boolean
  reason: string
}

/**
 * Walk the tiers in order and let the first one with a healthy member decide.
 *
 * When every tier is exhausted, the account whose window resets soonest is
 * returned rather than nothing: the request will probably be refused, but
 * refusing to choose would strand the session with no credentials at all, and
 * the caller can say when relief arrives.
 */
export type SelectOptions = {
  /** Requests served per account, for `least-used`. */
  usage?: Record<string, { requests: number; lastUsedAt: number }>
  /** Injected for the randomised strategies. */
  rng?: () => number
}

export function selectAccount(
  members: readonly Member[],
  cache: QuotaCache,
  cfg: ClaudeAuthConfig,
  activeSource: string | null,
  nowMs: number = Date.now(),
  opts: SelectOptions = {},
): Decision | undefined {
  const pools = resolvePools(members, cfg)
  if (pools.length === 0) return undefined

  const health = new Map(
    assess(members, cache, cfg, nowMs).map((h) => [h.source, h]),
  )

  for (const pool of pools) {
    const candidates = pool.accounts
      .map((s) => health.get(s))
      .filter((h): h is Health => !!h && h.healthy)
    if (candidates.length === 0) continue

    const strategy = pool.strategy ?? cfg.strategy
    const fn = STRATEGIES[strategy] ?? sticky
    const source = fn({
      candidates,
      activeSource,
      pool,
      usage: opts.usage ?? {},
      rng: opts.rng ?? Math.random,
    })
    return {
      source,
      pool: pool.name,
      strategy,
      changed: source !== activeSource,
      reason:
        source === activeSource
          ? "already active"
          : `${strategy} over ${candidates.length} healthy in ${pool.name}`,
    }
  }

  // Everything is spent. Prefer whoever frees up first.
  const all = pools.flatMap((p) => p.accounts)
  const soonest = all
    .map((s) => health.get(s))
    .filter((h): h is Health => !!h)
    .sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))[0]
  if (!soonest) return undefined

  return {
    source: soonest.source,
    pool: "exhausted",
    strategy: cfg.strategy,
    changed: soonest.source !== activeSource,
    reason: soonest.resetsAt
      ? `all accounts spent; earliest reset at ${new Date(soonest.resetsAt * 1000).toISOString()}`
      : "all accounts spent; no reset time known",
  }
}
