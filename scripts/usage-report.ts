/**
 * Print per-account usage from the telemetry log.
 *
 * Usage:
 *   pnpm usage              last 24h
 *   pnpm usage -- 7d        last 7 days
 *   pnpm usage -- 1h --json machine-readable
 */
import { bindingWindow, readQuotaCache } from "../dist/balance/quota.js"
import { readUsage, summarize, usagePath } from "../dist/balance/usage.js"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const spec = args.find((a) => /^\d+[smhd]$/.test(a)) ?? "24h"

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}
const windowMs = Number.parseInt(spec, 10) * (UNITS[spec.slice(-1)] ?? UNITS.h!)
const since = Date.now() - windowMs

const summary = summarize(readUsage(since), since)

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

if (summary.accounts.length === 0) {
  console.log(`No usage recorded in the last ${spec}.`)
  console.log(`Log: ${usagePath()}`)
  process.exit(0)
}

const quota = readQuotaCache()
const nowSec = Math.floor(Date.now() / 1000)
const total = summary.accounts.reduce((n, a) => n + a.requests, 0)

const ago = (ms: number): string => {
  if (!ms) return "never"
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

console.log(`\nPer-account usage, last ${spec} (${total} requests)\n`)
console.log(
  [
    "account".padEnd(34),
    "reqs".padStart(6),
    "share".padStart(7),
    "429".padStart(5),
    "err".padStart(5),
    "avg".padStart(8),
    "quota".padStart(8),
    "last used",
  ].join("  "),
)

for (const a of summary.accounts) {
  const w = quota[a.account] ? bindingWindow(quota[a.account]!) : undefined
  const util =
    w && !(w.resetsAt !== undefined && w.resetsAt <= nowSec)
      ? `${Math.round(w.utilization * 100)}%`
      : "-"
  console.log(
    [
      a.account.slice(-34).padEnd(34),
      String(a.requests).padStart(6),
      `${Math.round((a.requests / total) * 100)}%`.padStart(7),
      String(a.refusals).padStart(5),
      String(a.errors).padStart(5),
      `${a.avg_duration_ms}ms`.padStart(8),
      util.padStart(8),
      ago(a.last_used_at),
    ].join("  "),
  )
}

console.log(`\nrotations: ${summary.rotations}`)
for (const [trigger, n] of Object.entries(summary.by_trigger)) {
  console.log(`  ${trigger}: ${n}`)
}

// A perfectly even split is rarely the goal, but a wildly uneven one usually
// means the strategy is not doing what was intended.
if (summary.accounts.length > 1) {
  const shares = summary.accounts.map((a) => a.requests / total)
  const spread = Math.max(...shares) - Math.min(...shares)
  console.log(
    `\nspread: ${Math.round(spread * 100)} points between the busiest and quietest account`,
  )
}
console.log(`log: ${usagePath()}\n`)
