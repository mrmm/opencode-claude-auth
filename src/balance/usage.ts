/**
 * Per-account usage telemetry.
 *
 * Answers the questions the quota cache cannot: how much has each account
 * actually served, how often was it refused, how fast is it, when did it last
 * carry a request, and how often is the balancer moving. The quota cache holds
 * only the latest reading per account — a gauge. This is the history.
 *
 * Storage is append-only JSONL rather than the SQLite the token-optimizer plugin
 * uses, for two reasons that are specific to this plugin: it has zero runtime
 * dependencies and should keep them, and it is loaded by OpenCode, which ships
 * as a Bun binary, while its own tests run under `node --test`. A native SQLite
 * module risks failing to load in the first, and `bun:sqlite` would not exist in
 * the second. JSONL costs one append per request and reads back with no engine
 * at all. Field names follow the token-optimizer schema so the two are legible
 * side by side.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** One request served by one account. */
export type RequestEvent = {
  kind: "request"
  /** ISO 8601, for grepping the file by eye. */
  timestamp: string
  created_at: number
  account: string
  model: string
  status: number
  duration_ms: number
  /** Utilisation observed on this response, when the headers carried it. */
  utilization_5h?: number
  utilization_7d?: number
}

/** One move between accounts. */
export type RotationEvent = {
  kind: "rotation"
  timestamp: string
  created_at: number
  from_account: string | null
  to_account: string
  trigger: string
  strategy: string
  pool: string
}

export type UsageEvent = RequestEvent | RotationEvent

const MAX_BYTES = 2 * 1024 * 1024

export function usagePath(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "claude-auth-usage.jsonl",
  )
}

/**
 * Append one event. Never throws: telemetry runs on the credential path, where
 * a failed write must not become a failed request.
 */
export function record(event: UsageEvent, path: string = usagePath()): void {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // One generation back is enough: this is a rolling operational record, not
    // an audit trail, and an unbounded file on a developer machine is a bug.
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // no file yet, or the rename raced another process — either is fine
    }

    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8")
  } catch {
    // Non-fatal by design.
  }
}

export function recordRequest(
  e: Omit<RequestEvent, "kind" | "timestamp" | "created_at">,
  path?: string,
): void {
  const now = Date.now()
  record(
    {
      kind: "request",
      timestamp: new Date(now).toISOString(),
      created_at: now,
      ...e,
    },
    path,
  )
}

export function recordRotation(
  e: Omit<RotationEvent, "kind" | "timestamp" | "created_at">,
  path?: string,
): void {
  const now = Date.now()
  record(
    {
      kind: "rotation",
      timestamp: new Date(now).toISOString(),
      created_at: now,
      ...e,
    },
    path,
  )
}

/** Read events, newest generation last, skipping anything unparseable. */
export function readUsage(
  sinceMs = 0,
  path: string = usagePath(),
): UsageEvent[] {
  const out: UsageEvent[] = []
  for (const p of [`${path}.1`, path]) {
    let text: string
    try {
      text = readFileSync(p, "utf-8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as UsageEvent
        // A truncated final line from a crashed append is expected; a partial
        // record is dropped rather than allowed to skew a total.
        if (typeof e?.created_at !== "number") continue
        if (e.created_at >= sinceMs) out.push(e)
      } catch {
        continue
      }
    }
  }
  return out
}

export type AccountUsage = {
  account: string
  requests: number
  /** Responses Anthropic refused for rate limiting. */
  refusals: number
  /** Any other non-2xx. */
  errors: number
  /** Mean of `duration_ms` over successful requests. */
  avg_duration_ms: number
  last_used_at: number
  /** Most recent utilisation seen on a response from this account. */
  utilization_5h?: number
  utilization_7d?: number
}

export type UsageSummary = {
  since: number
  accounts: AccountUsage[]
  rotations: number
  /** Moves counted per trigger, e.g. { "quota-observed": 3, "429": 1 }. */
  by_trigger: Record<string, number>
}

export function summarize(
  events: readonly UsageEvent[],
  since = 0,
): UsageSummary {
  const acc = new Map<string, AccountUsage & { _okDurations: number[] }>()
  const by_trigger: Record<string, number> = {}
  let rotations = 0

  const of = (name: string) => {
    let a = acc.get(name)
    if (!a) {
      a = {
        account: name,
        requests: 0,
        refusals: 0,
        errors: 0,
        avg_duration_ms: 0,
        last_used_at: 0,
        _okDurations: [],
      }
      acc.set(name, a)
    }
    return a
  }

  for (const e of events) {
    if (e.kind === "rotation") {
      rotations++
      by_trigger[e.trigger] = (by_trigger[e.trigger] ?? 0) + 1
      continue
    }
    const a = of(e.account)
    a.requests++
    if (e.status === 429) a.refusals++
    else if (e.status < 200 || e.status >= 300) a.errors++
    else a._okDurations.push(e.duration_ms)
    if (e.created_at > a.last_used_at) {
      a.last_used_at = e.created_at
      // Utilisation is a gauge: the newest reading wins rather than averaging
      // figures from different windows.
      if (e.utilization_5h !== undefined) a.utilization_5h = e.utilization_5h
      if (e.utilization_7d !== undefined) a.utilization_7d = e.utilization_7d
    }
  }

  const accounts: AccountUsage[] = []
  for (const entry of acc.values()) {
    const { _okDurations, ...rest } = entry
    rest.avg_duration_ms =
      _okDurations.length > 0
        ? Math.round(
            _okDurations.reduce((s, d) => s + d, 0) / _okDurations.length,
          )
        : 0
    accounts.push(rest)
  }
  accounts.sort((a, b) => b.requests - a.requests)

  return { since, accounts, rotations, by_trigger }
}

/**
 * What `least-used` needs: requests served and when each account last ran.
 *
 * Kept separate from the full summary so the balancer depends on the smallest
 * possible shape and stays testable without any of this module.
 */
export function usageIndex(
  summary: UsageSummary,
): Record<string, { requests: number; lastUsedAt: number }> {
  const out: Record<string, { requests: number; lastUsedAt: number }> = {}
  for (const a of summary.accounts) {
    out[a.account] = { requests: a.requests, lastUsedAt: a.last_used_at }
  }
  return out
}

/**
 * The index the balancer reads, cached.
 *
 * A rotation decision happens after every response, and re-reading the whole
 * log each time would make telemetry cost more than the thing it measures. The
 * numbers only steer a choice between accounts, so a slightly stale count is
 * harmless where a per-request file scan would not be.
 */
let cachedIndex: Record<string, { requests: number; lastUsedAt: number }> = {}
let cachedIndexAt = 0

export function currentUsageIndex(
  windowMs = 24 * 60 * 60_000,
  ttlMs = 30_000,
  nowMs: number = Date.now(),
): Record<string, { requests: number; lastUsedAt: number }> {
  if (nowMs - cachedIndexAt < ttlMs) return cachedIndex
  cachedIndexAt = nowMs
  try {
    const since = nowMs - windowMs
    cachedIndex = usageIndex(summarize(readUsage(since), since))
  } catch {
    cachedIndex = {}
  }
  return cachedIndex
}

/** Test seam. */
export function resetUsageCache(): void {
  cachedIndex = {}
  cachedIndexAt = 0
}
