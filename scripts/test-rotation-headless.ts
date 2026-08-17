/**
 * Headless end-to-end test for quota-driven account rotation.
 *
 * Runs real `opencode run` invocations against the locally built plugin and
 * asserts on the structured debug log:
 *
 *   1. Rotation — with autoSwitch on and a threshold set just under the active
 *      account's own utilisation, the plugin must move to another account
 *      mid-run and the request must still succeed on the new one.
 *   2. Control — with autoSwitch off, the same conditions must produce no
 *      rotation at all.
 *   3. Non-persistence — a rotation must not rewrite the account the user
 *      pinned in the switcher.
 *
 * Unlike `test-headless.ts` this needs no keychain shims: rotation is decided
 * from the quota cache and the real accounts, so the honest test is the real
 * thing. It therefore spends a few tokens (two haiku replies) and may refresh
 * an expired token, exactly as normal use would.
 *
 * The threshold is derived from live readings rather than hard-coded, because
 * the whole point is to force one specific decision; if the live state cannot
 * produce that decision the test SKIPS rather than failing, since a green run
 * that asserted nothing would be worse than an honest skip.
 *
 * Requires: macOS, `opencode` on PATH, >= 2 Claude accounts, one usable.
 * Run with: pnpm test:rotation
 */
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { readAllClaudeAccounts } from "../dist/keychain.js"
import { bindingWindow, readQuotaCache } from "../dist/quota.js"
import { assess } from "../dist/balancer.js"
import { credentialState } from "../dist/rotate.js"
import { DEFAULT_CONFIG } from "../dist/config.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MODEL = "anthropic/claude-haiku-4-5"
const PIN_FILE = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "claude-account-source.txt",
)

let failures = 0

function pass(msg: string): void {
  console.log(`  \u2713 ${msg}`)
}
function fail(msg: string): void {
  failures++
  console.error(`  \u2717 ${msg}`)
}
function skip(msg: string): never {
  console.log(`\n- SKIP: ${msg}`)
  process.exit(0)
}

/** One isolated `opencode run`, returning its stdout and its own debug log. */
function runOpencode(
  env: Record<string, string>,
  prompt: string,
): { stdout: string; log: string } {
  const xdg = mkdtempSync(join(tmpdir(), "oc-rotate-"))
  const logPath = join(xdg, "claude-auth.log")
  mkdirSync(join(xdg, "opencode"), { recursive: true })
  writeFileSync(
    join(xdg, "opencode", "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [repoRoot],
    }),
  )

  const result = spawnSync("opencode", ["run", "--model", MODEL, prompt], {
    encoding: "utf-8",
    timeout: 180_000,
    // env -i equivalent: only what the plugin and opencode genuinely need, so a
    // stray CLAUDE_AUTH_* in the developer's shell cannot silently steer this.
    env: {
      HOME: process.env.HOME ?? homedir(),
      PATH: process.env.PATH ?? "",
      TERM: "dumb",
      XDG_CONFIG_HOME: xdg,
      CLAUDE_AUTH_DEBUG: logPath,
      CLAUDE_AUTH_DEBUG_LEVEL: "info",
      ...env,
    },
  })

  const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : ""
  return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`, log }
}

const events = (log: string, event: string): number =>
  log.split("\n").filter((l) => l.includes(`"event":"${event}"`)).length

// --- decide what this machine's state can actually prove -------------------

const accounts = readAllClaudeAccounts()
if (accounts.length < 2) skip("needs at least 2 Claude accounts")

const members = accounts.map((a) => ({
  source: a.source,
  label: a.label,
  credential: credentialState(a),
}))
const cache = readQuotaCache()
const pinned = existsSync(PIN_FILE)
  ? readFileSync(PIN_FILE, "utf-8").trim()
  : null
const active = members.find((m) => m.source === pinned) ?? members[0]
if (!active) skip("no active account could be determined")

const activeQuota = cache[active.source]
const activeWindow = activeQuota ? bindingWindow(activeQuota) : undefined
if (!activeWindow) {
  skip(
    `no quota reading for the active account (${active.label}); run a request first, or set quotaProbe`,
  )
}

// Just under the active account's own utilisation: enough to condemn it without
// condemning everything, which would only prove the exhausted path.
const switchAt = Math.max(0.01, activeWindow.utilization - 0.01)
const healthyElsewhere = assess(members, cache, {
  ...DEFAULT_CONFIG,
  switchAt,
}).filter((h) => h.healthy && h.source !== active.source)

if (healthyElsewhere.length === 0) {
  skip(
    `no other account is healthy at ${(switchAt * 100).toFixed(0)}% — nothing to rotate to`,
  )
}

console.log(
  `\nactive: ${active.label} at ${(activeWindow.utilization * 100).toFixed(0)}%`,
)
console.log(
  `forcing switchAt=${switchAt.toFixed(2)}; ${healthyElsewhere.length} other account(s) usable\n`,
)

// --- 1. rotation ------------------------------------------------------------

console.log("1. rotates off a spent account and still answers")
{
  const { stdout, log } = runOpencode(
    {
      CLAUDE_AUTH_AUTO_SWITCH: "1",
      CLAUDE_AUTH_SWITCH_AT: String(switchAt),
      CLAUDE_AUTH_STRATEGY: "sticky",
    },
    "Reply with exactly the word: ROTATEOK",
  )

  if (events(log, "rotate_applied") > 0) pass("rotate_applied was logged")
  else fail(`no rotate_applied in the log\n${log.slice(-1200)}`)

  if (stdout.includes("ROTATEOK")) pass("the request succeeded after the move")
  else fail(`sentinel missing from output:\n${stdout.slice(-600)}`)

  const rotateLine = log
    .split("\n")
    .find((l) => l.includes('"event":"rotate_applied"'))
  if (rotateLine) {
    const parsed = JSON.parse(rotateLine) as { from?: string; to?: string }
    if (parsed.from === active.source) {
      pass(`moved off the spent account (${parsed.from} -> ${parsed.to})`)
    } else {
      fail(`moved off ${parsed.from}, expected ${active.source}`)
    }
  }
}

// --- 2. control -------------------------------------------------------------

console.log("\n2. does nothing when autoSwitch is off")
{
  const { stdout, log } = runOpencode(
    {
      CLAUDE_AUTH_AUTO_SWITCH: "0",
      CLAUDE_AUTH_SWITCH_AT: String(switchAt),
    },
    "Reply with exactly the word: CONTROLOK",
  )

  const n = events(log, "rotate_applied")
  if (n === 0) pass("no rotation occurred")
  else fail(`rotated ${n} time(s) with autoSwitch off`)

  if (stdout.includes("CONTROLOK")) pass("the request still succeeded")
  else fail(`sentinel missing from output:\n${stdout.slice(-600)}`)
}

// --- 3. the pin survives ----------------------------------------------------

console.log("\n3. leaves the pinned account alone")
{
  const after = existsSync(PIN_FILE)
    ? readFileSync(PIN_FILE, "utf-8").trim()
    : null
  if (after === pinned) pass(`pin unchanged (${pinned ?? "none"})`)
  else fail(`pin was rewritten: ${pinned} -> ${after}`)
}

console.log(
  failures === 0
    ? "\nAll rotation checks passed."
    : `\n${failures} check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)
