/**
 * Select the account, preset, or Auto — without touching provider auth.
 *
 * This exists because `opencode auth login` is the wrong door while work is in
 * flight. Choosing there runs the auth hook's `authorize()`, OpenCode
 * re-initialises the provider, and anything the agent had running — subagents
 * included — is cancelled. That is fine when idle and unacceptable mid-task.
 *
 * All this does is write the selection file the plugin already consults. A
 * running OpenCode re-reads it on its next request, so the switch is invisible
 * to the agent: no auth flow, no provider reload, nothing cancelled.
 *
 *   pnpm lb                     show what is selected and what is available
 *   pnpm lb rr-12               use a preset by name
 *   pnpm lb "Team B"          pin one account (label fragment or source)
 *   pnpm lb auto                balance, no pin
 *   pnpm lb clear               forget the selection, fall back to the config
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { AUTO_SOURCE, PRESET_PREFIX } from "../dist/credentials.js"
import { getConfig } from "../dist/config.js"
import { readAllClaudeAccounts } from "../dist/keychain.js"
import { resolveRef } from "../dist/balancer.js"

const STATE = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "claude-account-source.txt",
)

const read = (): string | null => {
  try {
    return readFileSync(STATE, "utf-8").trim() || null
  } catch {
    return null
  }
}

const write = (value: string): void => {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, value, "utf-8")
}

const cfg = getConfig()
const accounts = readAllClaudeAccounts()
const members = accounts.map((a) => ({ source: a.source, label: a.label }))
const arg = process.argv.slice(2).join(" ").trim()

const describe = (value: string | null): string => {
  if (!value) return "nothing selected — using the config as written"
  if (value === AUTO_SOURCE) return `Auto (${cfg.strategy})`
  if (value.startsWith(PRESET_PREFIX)) {
    const name = value.slice(PRESET_PREFIX.length)
    const p = cfg.presets[name]
    return p ? `preset "${p.label ?? name}"` : `preset "${name}" (NOT DEFINED)`
  }
  const m = members.find((x) => x.source === value)
  return `pinned to ${m?.label ?? value}`
}

if (!arg || arg === "status") {
  const current = read()
  console.log(`\nselected: ${describe(current)}`)
  console.log(`autoSwitch: ${cfg.autoSwitch}`)
  if (cfg.preset) console.log(`config preset: ${cfg.preset}`)

  console.log("\npresets:")
  for (const [name, p] of Object.entries(cfg.presets)) {
    const n = p.pools
      ? p.pools.reduce((t, x) => t + x.accounts.length, 0)
      : (p.accounts?.length ?? 0)
    console.log(
      `  ${name.padEnd(20)} ${(p.strategy ?? cfg.strategy).padEnd(13)} ${n} accounts`,
    )
  }

  console.log("\naccounts:")
  for (const m of members)
    console.log(`  ${m.source.padEnd(36)} ${m.label ?? ""}`)

  console.log(`\nstate file: ${STATE}`)
  console.log("change it with: pnpm lb <preset|account|auto|clear>\n")
  process.exit(0)
}

if (arg === "clear") {
  if (existsSync(STATE)) unlinkSync(STATE)
  console.log("selection cleared — the config decides from here.")
  process.exit(0)
}

if (arg === "auto") {
  write(AUTO_SOURCE)
  console.log(`selected: Auto (${cfg.strategy}). Applies on the next request.`)
  process.exit(0)
}

if (cfg.presets[arg]) {
  write(`${PRESET_PREFIX}${arg}`)
  const p = cfg.presets[arg]!
  console.log(
    `selected: preset "${p.label ?? arg}" (${p.strategy ?? cfg.strategy}). Applies on the next request.`,
  )
  process.exit(0)
}

const source = resolveRef(arg, members)
if (source) {
  write(source)
  const m = members.find((x) => x.source === source)
  console.log(`pinned: ${m?.label ?? source}. Applies on the next request.`)
  process.exit(0)
}

console.error(`\nNo preset or account matches "${arg}".`)
console.error(`presets: ${Object.keys(cfg.presets).join(", ") || "(none)"}`)
console.error("Run `pnpm lb` to list accounts.\n")
process.exit(1)
