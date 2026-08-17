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
} from "./config.ts"
import {
  type AccountQuota,
  type QuotaCache,
  type QuotaWindow,
  bindingWindow,
  quotaForAccount,
} from "./quota.ts"

export type Member = { source: string; label?: string }

export type Health = {
  source: string
  /** Utilisation on the configured window, or undefined when unknown. */
  utilization?: number
  /** Unix seconds the binding window resets, when known. */
  resetsAt?: number
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
    const held = ejectedUntil(m.source, nowMs)
    if (held !== undefined) {
      return {
        source: m.source,
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
      return { source: m.source, healthy: true, reason: "" }
    }

    const w = windowFor(q, cfg.switchWindow)
    const util = effectiveUtilization(w, nowSec)

    if (w?.status === "rejected" && (w.resetsAt ?? 0) > nowSec) {
      return {
        source: m.source,
        utilization: util,
        resetsAt: w.resetsAt,
        healthy: false,
        reason: "server rejected",
      }
    }
    if (util !== undefined && util >= cfg.switchAt) {
      return {
        source: m.source,
        utilization: util,
        resetsAt: w?.resetsAt,
        healthy: false,
        reason: `at ${Math.round(util * 100)}% of ${cfg.switchWindow}`,
      }
    }
    return {
      source: m.source,
      utilization: util,
      resetsAt: w?.resetsAt,
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
export function resolvePools(
  members: readonly Member[],
  cfg: Pick<ClaudeAuthConfig, "pools" | "accounts" | "strategy">,
): Pool[] {
  const live = new Set(members.map((m) => m.source))
  const keep = (sources: string[]) => sources.filter((s) => live.has(s))

  if (cfg.pools.length > 0) {
    return cfg.pools
      .map((p) => ({ ...p, accounts: keep(p.accounts) }))
      .filter((p) => p.accounts.length > 0)
  }

  const flat = cfg.accounts.length > 0 ? keep(cfg.accounts) : [...live]
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
}

export type StrategyFn = (input: StrategyInput) => string

/** Round-robin and weighted need a cursor; it is per-pool and per-process. */
const cursors = new Map<string, number>()
const swrrState = new Map<string, Map<string, number>>()

export function resetCursors(): void {
  cursors.clear()
  swrrState.clear()
}

/** Known headroom first; an unmeasured account ranks behind every measured one. */
function byHeadroom(a: Health, b: Health): number {
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
 * The registry. A new algorithm is one entry here plus one name in
 * `BalanceStrategy` — nothing else in the plugin has to know about it.
 */
export const STRATEGIES: Record<BalanceStrategy, StrategyFn> = {
  sticky,
  priority,
  "least-loaded": leastLoaded,
  "round-robin": roundRobin,
  weighted,
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
export function selectAccount(
  members: readonly Member[],
  cache: QuotaCache,
  cfg: ClaudeAuthConfig,
  activeSource: string | null,
  nowMs: number = Date.now(),
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
    const source = fn({ candidates, activeSource, pool })
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
