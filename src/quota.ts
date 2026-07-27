/**
 * Per-account quota, read from Anthropic's unified rate-limit response headers.
 *
 * Every API response carries the caller's current utilisation and reset time:
 *
 *   anthropic-ratelimit-unified-5h-utilization: 1.0
 *   anthropic-ratelimit-unified-5h-reset: 1785167400
 *   anthropic-ratelimit-unified-5h-status: rejected
 *   anthropic-ratelimit-unified-7d-utilization: 0.92
 *   anthropic-ratelimit-unified-representative-claim: five_hour
 *
 * This is the only usable source here. claude.ai's /api/organizations/{id}/usage
 * needs a web `sessionKey` cookie and an organisation id; the plugin holds OAuth
 * tokens for api.anthropic.com (scopes user:inference, user:profile, ...), which
 * that endpoint does not accept. Headers cost nothing extra -- they arrive with
 * traffic the plugin already proxies.
 *
 * Values are cached to disk per account because the account switcher builds its
 * options synchronously and cannot await a request.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** One rate-limit window. */
export type QuotaWindow = {
  /** Fraction consumed, 0..1+ (1.0 means the window is exhausted). */
  utilization: number
  /** Unix seconds when the window resets, or undefined if absent. */
  resetsAt?: number
  /** Server's own verdict: allowed | allowed_warning | rejected. */
  status?: string
}

export type AccountQuota = {
  fiveHour?: QuotaWindow
  sevenDay?: QuotaWindow
  /** Which window the server says is currently binding. */
  representative?: string
  /** When these values were observed (unix seconds). */
  observedAt: number
}

const PREFIX = "anthropic-ratelimit-unified-"

/** Header bag, tolerating a real Headers instance or a plain object. */
export type HeaderLike =
  | Headers
  | { get?: (name: string) => string | null; [key: string]: unknown }

function headerValue(headers: HeaderLike, name: string): string | undefined {
  if (!headers) return undefined

  const getter = (headers as { get?: unknown }).get
  if (typeof getter === "function") {
    const v = (getter as (n: string) => string | null).call(headers, name)
    return v === null || v === undefined ? undefined : String(v)
  }

  // Plain objects may be keyed with any casing.
  const bag = headers as Record<string, unknown>
  const direct = bag[name]
  if (typeof direct === "string") return direct
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(bag)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v
  }
  return undefined
}

function parseWindow(
  headers: HeaderLike,
  key: "5h" | "7d",
): QuotaWindow | undefined {
  const util = headerValue(headers, `${PREFIX}${key}-utilization`)
  if (util === undefined) return undefined

  const utilization = Number.parseFloat(util)
  if (!Number.isFinite(utilization)) return undefined

  const resetRaw = headerValue(headers, `${PREFIX}${key}-reset`)
  const reset = resetRaw ? Number.parseInt(resetRaw, 10) : Number.NaN

  return {
    utilization,
    resetsAt: Number.isFinite(reset) ? reset : undefined,
    status: headerValue(headers, `${PREFIX}${key}-status`),
  }
}

/**
 * Read quota from response headers, or undefined when none are present.
 *
 * Absence is normal: non-Anthropic responses and errors raised before the
 * upstream call carry no such headers.
 */
export function parseQuotaHeaders(
  headers: HeaderLike,
  now: number = Math.floor(Date.now() / 1000),
): AccountQuota | undefined {
  const fiveHour = parseWindow(headers, "5h")
  const sevenDay = parseWindow(headers, "7d")
  if (!fiveHour && !sevenDay) return undefined

  return {
    fiveHour,
    sevenDay,
    representative: headerValue(headers, `${PREFIX}representative-claim`),
    observedAt: now,
  }
}

/** Compact duration: 45s, 12m, 1h20m, 2d3h. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now"
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) {
    const rem = m % 60
    return rem ? `${h}h${String(rem).padStart(2, "0")}m` : `${h}h`
  }
  const d = Math.floor(h / 24)
  const remH = h % 24
  return remH ? `${d}d${remH}h` : `${d}d`
}

/** The window that matters: the server's representative claim, else the fuller. */
export function bindingWindow(q: AccountQuota): QuotaWindow | undefined {
  if (q.representative === "seven_day" && q.sevenDay) return q.sevenDay
  if (q.representative === "five_hour" && q.fiveHour) return q.fiveHour
  if (q.fiveHour && q.sevenDay) {
    return q.sevenDay.utilization > q.fiveHour.utilization
      ? q.sevenDay
      : q.fiveHour
  }
  return q.fiveHour ?? q.sevenDay
}

/**
 * Prefix for an account switcher row, e.g. "[100% 1h20m]" or "[22% 2h05m]".
 *
 * Returns "" when nothing is known, so a row is never padded with noise.
 * A window already past its reset reads as 0% -- the reset happened, and
 * showing the stale figure would be actively misleading.
 */
export function formatQuotaPrefix(
  quota: AccountQuota | undefined,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (!quota) return ""
  const w = bindingWindow(quota)
  if (!w) return ""

  const expired = w.resetsAt !== undefined && w.resetsAt <= now
  if (expired) return "[0%]"

  const pct = Math.round(Math.min(Math.max(w.utilization, 0), 1) * 100)
  const remaining =
    w.resetsAt !== undefined ? formatDuration(w.resetsAt - now) : undefined

  return remaining ? `[${pct}% ${remaining}]` : `[${pct}%]`
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function quotaCachePath(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "claude-auth-quota.json",
  )
}

export type QuotaCache = Record<string, AccountQuota>

/** Read the cache; a missing or corrupt file is simply "no data". */
export function readQuotaCache(path: string = quotaCachePath()): QuotaCache {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as QuotaCache) : {}
  } catch {
    return {}
  }
}

/**
 * Record one account's quota.
 *
 * Never throws: this runs on the response path of every request, where an
 * unwritable cache must not surface as a failed API call.
 */
export function writeQuotaForAccount(
  source: string,
  quota: AccountQuota,
  path: string = quotaCachePath(),
): boolean {
  try {
    const cache = readQuotaCache(path)
    cache[source] = quota
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

/** Quota for one account, dropping entries older than `maxAgeSeconds`. */
export function quotaForAccount(
  source: string,
  cache: QuotaCache,
  now: number = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 60 * 60 * 12,
): AccountQuota | undefined {
  const q = cache?.[source]
  if (!q || typeof q.observedAt !== "number") return undefined
  if (now - q.observedAt > maxAgeSeconds) return undefined
  return q
}

// ---------------------------------------------------------------------------
// Filling rows the passive path cannot reach
// ---------------------------------------------------------------------------

/**
 * Passive capture only ever learns about the account currently serving traffic,
 * which is the one row the user already knows. Comparing accounts in the
 * switcher needs a figure for each, so every account is probed once per
 * session with a 1-token request.
 *
 * Cost is deliberately near-zero: an exhausted account answers 429 and consumes
 * nothing, and a healthy one spends a single token. Accounts with a reading
 * newer than `maxAgeSeconds` are skipped entirely.
 */
export type ProbeAccount = { source: string; accessToken: string }

export type ProbeResult = {
  probed: number
  skipped: number
  failed: number
}

export const PROBE_MODEL = "claude-haiku-4-5-20251001"

/** Minimal request the API will answer with rate-limit headers attached. */
export function buildProbeRequest(accessToken: string): [string, RequestInit] {
  return [
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    },
  ]
}

/**
 * Refresh quota for the given accounts, writing what it learns to the cache.
 *
 * Resolves rather than rejects on network failure: this runs detached from
 * start-up and must never surface as an error to the user.
 */
export async function refreshQuotas(
  accounts: ProbeAccount[],
  options: {
    fetchImpl?: typeof fetch
    path?: string
    now?: () => number
    maxAgeSeconds?: number
  } = {},
): Promise<ProbeResult> {
  const {
    fetchImpl = fetch,
    path = quotaCachePath(),
    now = () => Math.floor(Date.now() / 1000),
    maxAgeSeconds = 10 * 60,
  } = options

  const result: ProbeResult = { probed: 0, skipped: 0, failed: 0 }
  const cache = readQuotaCache(path)

  for (const account of accounts ?? []) {
    if (!account?.source || !account?.accessToken) {
      result.failed++
      continue
    }
    if (quotaForAccount(account.source, cache, now(), maxAgeSeconds)) {
      result.skipped++
      continue
    }

    try {
      const [url, init] = buildProbeRequest(account.accessToken)
      const res = await fetchImpl(url, init)
      const quota = parseQuotaHeaders(res.headers as HeaderLike, now())
      if (quota) {
        writeQuotaForAccount(account.source, quota, path)
        result.probed++
      } else {
        // 401 from an expired token, or any response without the headers.
        result.failed++
      }
    } catch {
      result.failed++
    }
  }

  return result
}
