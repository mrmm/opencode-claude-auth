/**
 * Capture everything needed to diagnose one reproduction.
 *
 *   pnpm capture start     mark now, and print what to do
 *   pnpm capture stop      collect everything since the mark into one folder
 *
 * Exists because the useful evidence is spread across three places that must be
 * read together: this plugin's log says what it decided, OpenCode's log says
 * what the stream did, and the account/quota state says what was available at
 * the time. Reading one without the others is how a symptom gets attributed to
 * the wrong cause — a blank screen looked like rotation misfiring when it was
 * rotation being switched off.
 *
 * Nothing here transmits anything. It writes a folder and prints the path.
 */
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SHARE = join(homedir(), ".local", "share", "opencode")
const PLUGIN_LOG = join(SHARE, "claude-auth-debug.log")
const OC_LOG = join(SHARE, "log", "opencode.log")
// Deliberately NOT os.tmpdir(): TMPDIR differs between shells, so a mark
// written by one process was invisible to the next and `capture stop` reported
// no mark at all. Alongside the logs it reads, it is found by everyone.
const MARK = join(SHARE, "claude-auth-capture-mark.json")

type Mark = { at: string; pluginBytes: number; ocBytes: number }

const sizeOf = (p: string): number => {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/** Read only what was appended after the mark, so the capture is the repro. */
function tailSince(path: string, from: number): string {
  const size = sizeOf(path)
  if (size === 0) return ""
  const start = Math.min(from, size)
  const buf = readFileSync(path)
  return buf.subarray(start).toString("utf8")
}

const cmd = process.argv[2] ?? "start"

if (cmd === "start") {
  const mark: Mark = {
    at: new Date().toISOString(),
    pluginBytes: sizeOf(PLUGIN_LOG),
    ocBytes: sizeOf(OC_LOG),
  }
  writeFileSync(MARK, JSON.stringify(mark, null, 2))

  console.log(`
Marked ${mark.at}.

Now reproduce it:

  1. Restart OpenCode first — a running instance still has the old build loaded.
  2. Switch account: 'opencode auth login' -> Claude Code -> pick an account or a
     preset row. (This is the path that cancels in-flight work, which is why
     'pnpm lb <preset>' exists — but reproduce the way you hit it.)
  3. Send one message and let it fail the way it did.
  4. Exit OpenCode.

Then run:  pnpm capture stop
`)
  process.exit(0)
}

if (cmd !== "stop") {
  console.error(`unknown command "${cmd}" — use start or stop`)
  process.exit(1)
}

if (!existsSync(MARK)) {
  console.error("No mark found. Run `pnpm capture start` first.")
  process.exit(1)
}

const mark = JSON.parse(readFileSync(MARK, "utf8")) as Mark
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const out = join(SHARE, "captures", `claude-auth-capture-${stamp}`)
mkdirSync(out, { recursive: true })

const pluginSlice = tailSince(PLUGIN_LOG, mark.pluginBytes)
const ocSlice = tailSince(OC_LOG, mark.ocBytes)

writeFileSync(join(out, "plugin.log"), pluginSlice)
writeFileSync(join(out, "opencode.log"), ocSlice)

// State as it is now — the quota cache and selection explain which choices were
// even available while the repro was running.
const state: Record<string, unknown> = {
  mark,
  capturedAt: new Date().toISOString(),
}
for (const [key, path] of [
  ["selection", join(SHARE, "claude-account-source.txt")],
  ["quota", join(SHARE, "claude-auth-quota.json")],
] as const) {
  try {
    state[key] = readFileSync(path, "utf8").trim()
  } catch {
    state[key] = null
  }
}
try {
  state.config = readFileSync(
    join(homedir(), ".config", "opencode", "claude-auth.jsonc"),
    "utf8",
  )
} catch {
  state.config = null
}
try {
  state.pluginCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf-8",
  }).trim()
} catch {
  state.pluginCommit = null
}
writeFileSync(join(out, "state.json"), JSON.stringify(state, null, 2))

// A summary worth reading before the raw logs.
const events = new Map<string, number>()
for (const line of pluginSlice.split("\n")) {
  const m = line.match(/"event":"([a-z_]+)"/)
  if (m) events.set(m[1]!, (events.get(m[1]!) ?? 0) + 1)
}
const ocErrors = ocSlice
  .split("\n")
  .filter((l) => /level=ERROR/.test(l))
  .slice(-25)

const summary = [
  `captured ${new Date().toISOString()}  (marked ${mark.at})`,
  `plugin commit: ${state.pluginCommit ?? "unknown"}`,
  `plugin log: ${pluginSlice.split("\n").length} lines`,
  `opencode log: ${ocSlice.split("\n").length} lines`,
  "",
  "plugin events in this window:",
  ...[...events.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([e, n]) => `  ${String(n).padStart(5)}  ${e}`),
  "",
  `opencode ERROR lines (${ocErrors.length}):`,
  ...ocErrors.map((l) => `  ${l.slice(0, 260)}`),
  "",
  "the events that matter for a switch:",
  "  authorize_called / authorize_returning  what the switcher was asked for",
  "  account_switch / rotate_applied         the account actually changing",
  "  chat_headers                            the per-session bridge firing",
  "  session_bound                           a session getting its own account",
  "  rotate_ejected / rotate_blocked_by_pin  why it did or did not move",
  "  fetch_error_response                    what the API actually refused",
].join("\n")

writeFileSync(join(out, "SUMMARY.txt"), summary)

console.log(summary)
console.log(`\nfull capture: ${out}`)
console.log("  plugin.log  opencode.log  state.json  SUMMARY.txt")
console.log("\nstate.json holds your config verbatim — no tokens are logged,")
console.log("but skim it before sharing if that matters.\n")
