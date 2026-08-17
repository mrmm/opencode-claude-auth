/**
 * File-based configuration.
 *
 * Everything here was previously environment-only, which has two costs: the
 * settings live in a shell profile far from the plugin, and changing one means a
 * new shell and an OpenCode restart. A file can be re-read, so an edit takes
 * effect on the next check without restarting anything.
 *
 * Precedence, least specific first:
 *
 *   defaults
 *     < ~/.config/opencode/claude-auth.jsonc      global
 *     < <project>/claude-auth.jsonc               project
 *     < inline options in opencode.jsonc          per-install
 *     < CLAUDE_AUTH_* environment variables       one-off override
 *
 * Environment stays highest so a single command can still turn something on
 * without editing anything, but it is no longer where configuration lives.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_PLACEMENT,
  isAccountLabelPlacement,
  type AccountLabelPlacement,
} from "./display.ts"
import { parseKeep, parseLevel, parseSize, type LogLevel } from "./logger.ts"

export const CONFIG_FILENAME = "claude-auth.jsonc"
export const CONFIG_FILENAME_JSON = "claude-auth.json"

/**
 * Parse a duration: bare milliseconds, or a suffixed value (30s, 5m, 2h, 1d).
 *
 * Returns the fallback for anything unparseable or non-positive -- a zero
 * interval would mean a timer firing continuously, which is worse than ignoring
 * a typo.
 */
export function parseDuration(
  input: string | number | undefined,
  fallback: number,
): number {
  if (input === undefined || input === null || input === "") return fallback
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.floor(input) : fallback
  }
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(ms|s|m|h|d)?\s*$/i.exec(input)
  if (!m) return fallback
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return fallback
  const unit = (m[2] ?? "ms").toLowerCase()
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }
  return Math.floor(n * (mult[unit] ?? 1))
}

/** Parse a 0..1 ratio, also accepting a percentage like "90%" or 90. */
export function parseRatio(
  input: string | number | undefined,
  fallback: number,
): number {
  if (input === undefined || input === null || input === "") return fallback

  const text = String(input)
  const isPercent = typeof input === "string" && text.includes("%")
  const raw =
    typeof input === "number" ? input : Number.parseFloat(text.replace("%", ""))
  if (!Number.isFinite(raw) || raw <= 0) return fallback

  // An explicit "%" is always per-hundred, so "1.5%" is 0.015 as written.
  if (isPercent) {
    const asRatio = raw / 100
    return asRatio > 0 && asRatio <= 1 ? asRatio : fallback
  }

  // A bare number above 1 is read as a percentage, so 90 means 0.9. Between 1
  // and 2 that guess is unsafe: 1.5 is not plausibly "1.5%", it is someone
  // reaching for "above 100%" to disable a threshold — and silently returning
  // 0.015 condemns every account instead of none. Refuse it and keep the
  // default; write "1.5%" if a hundredth and a half is genuinely meant.
  if (raw > 1 && raw < 2) return fallback

  const asRatio = raw > 1 ? raw / 100 : raw
  return asRatio > 0 && asRatio <= 1 ? asRatio : fallback
}

/**
 * Which rate-limit window a switch decision reads. "binding" follows whichever
 * of the two is closer to its limit, so a spent weekly budget moves the
 * account even while the 5h figure still looks healthy.
 */
export type SwitchWindow = "5h" | "7d" | "binding"

const SWITCH_WINDOWS = new Set<string>(["5h", "7d", "binding"])

export function isSwitchWindow(v: unknown): v is SwitchWindow {
  return typeof v === "string" && SWITCH_WINDOWS.has(v)
}

/**
 * Keep the strings, drop everything else, and preserve the order given: the
 * order is the preference order, so it carries meaning beyond membership.
 */
export function parseAccounts(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
  return [...new Set(out)]
}

/**
 * How one pool chooses among its healthy members.
 *
 * `sticky` is the default because Anthropic's prompt cache is per-account:
 * every move to another account starts that account's cache cold, so a
 * strategy that rotates freely trades cache hits for headroom. The rotating
 * strategies are here for when spreading load matters more than that.
 */
export type BalanceStrategy =
  | "sticky"
  | "priority"
  | "least-loaded"
  | "round-robin"
  | "weighted"
  | "least-used"
  | "random"
  | "p2c"

const STRATEGY_NAMES = new Set<string>([
  "sticky",
  "priority",
  "least-loaded",
  "round-robin",
  "weighted",
  "least-used",
  "random",
  "p2c",
])

export function isBalanceStrategy(v: unknown): v is BalanceStrategy {
  return typeof v === "string" && STRATEGY_NAMES.has(v)
}

/**
 * A group of accounts that share a strategy. Pool order is failover order:
 * a pool is only reached when every pool before it has no healthy member.
 */
export type Pool = {
  name: string
  accounts: string[]
  /** Omitted means the top-level `strategy`. */
  strategy?: BalanceStrategy
  /** Per-account weight for `weighted`; missing entries weigh 1. */
  weights?: Record<string, number>
}

/**
 * Keep only pools that name at least one account. A pool that survives
 * parsing but matches no live account is dropped later, at selection time,
 * where the live account list is known.
 */
export function parsePools(v: unknown): Pool[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Pool[] = []
  for (const [i, raw] of v.entries()) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const accounts = parseAccounts(r.accounts)
    if (!accounts || accounts.length === 0) continue
    const pool: Pool = {
      name:
        typeof r.name === "string" && r.name.trim()
          ? r.name.trim()
          : `pool${i}`,
      accounts,
    }
    if (isBalanceStrategy(r.strategy)) pool.strategy = r.strategy
    if (r.weights && typeof r.weights === "object") {
      const weights: Record<string, number> = {}
      for (const [k, w] of Object.entries(
        r.weights as Record<string, unknown>,
      )) {
        const n = Number(w)
        if (Number.isFinite(n) && n > 0) weights[k] = n
      }
      if (Object.keys(weights).length > 0) pool.weights = weights
    }
    out.push(pool)
  }
  return out
}

/**
 * A named, selectable configuration: which accounts, in what order, under which
 * strategy.
 *
 * Presets exist because the useful unit of choice is not one account but one
 * *arrangement* — "round-robin over 1 and 2" is a thing you switch to, and
 * spelling it out in the config each time you change your mind is not. They are
 * offered as rows in the account switcher alongside the individual accounts.
 */
export type Preset = {
  /** Shown in the switcher; defaults to the key. */
  label?: string
  strategy?: BalanceStrategy
  /** Accounts in priority order. Ignored when `pools` is set. */
  accounts?: string[]
  /** Failover tiers, for a preset that needs more than one. */
  pools?: Pool[]
}

export function parsePresets(v: unknown): Record<string, Preset> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const out: Record<string, Preset> = {}
  for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const preset: Preset = {}
    if (typeof r.label === "string" && r.label.trim())
      preset.label = r.label.trim()
    if (isBalanceStrategy(r.strategy)) preset.strategy = r.strategy
    const accounts = parseAccounts(r.accounts)
    if (accounts && accounts.length > 0) preset.accounts = accounts
    const pools = parsePools(r.pools)
    if (pools && pools.length > 0) preset.pools = pools
    // A preset that names no accounts and no pools would silently mean "all of
    // them", which is not what anyone writes a preset for.
    if (!preset.accounts && !preset.pools) continue
    out[name] = preset
  }
  return out
}

export type ClaudeAuthConfig = {
  /** false disables logging; true uses the default path; a string is a path. */
  debug: boolean | string
  logLevel: LogLevel
  /** Event selection spec, e.g. "refresh,quota" or "-keychain". */
  logEvents: string
  logMaxSizeBytes: number
  logKeep: number
  /** Probe every account once per session so each switcher row shows quota. */
  quotaProbe: boolean
  /** Also toast on a successful refresh (failures always toast). */
  toastOnRefresh: boolean
  accountLabel: AccountLabelPlacement

  /** How often the background timer checks whether a refresh is due. */
  refreshCheckInterval: number
  /** How long before expiry a token is refreshed. */
  refreshBeforeExpiry: number
  /** How long the same toast is suppressed after being shown once. */
  noticeCooldown: number
  /** How long a quota reading is reused before an account is re-probed. */
  quotaProbeMaxAge: number
  /** Beyond this age a cached quota reading is ignored entirely. */
  quotaMaxAge: number
  /** 5h utilisation at or above which the active account is flagged. */
  quotaWarnAt: number
  /** Weekly utilisation at or above which the account is flagged. */
  quotaWeeklyWarnAt: number
  /** An alternative account is only suggested at or below this utilisation. */
  quotaAlternativeAt: number
  /** How often the config file itself is re-checked for edits. */
  configReloadInterval: number

  /**
   * Which accounts may serve requests, in preference order, by Keychain
   * source. Empty means every account the Keychain offers. An entry that
   * matches nothing is ignored, so a stale config cannot strand the plugin
   * with no usable account.
   */
  accounts: string[]
  /**
   * Move to another account by itself when the active one runs out. Off by
   * default: changing which subscription serves a request is the kind of
   * thing that should be asked for rather than assumed.
   */
  autoSwitch: boolean
  /** Utilisation at or above which the active account is abandoned. */
  switchAt: number
  /** Also move when Anthropic actually refuses a request (429). */
  switchOn429: boolean
  /** Which window `switchAt` is measured against. */
  switchWindow: SwitchWindow
  /** Strategy for pools that do not name their own. */
  strategy: BalanceStrategy
  /**
   * Failover tiers, tried in order. Empty means one implicit pool holding
   * `accounts` (or every Keychain account when that is empty too), so the
   * simple single-tier case needs no pool declaration at all.
   */
  pools: Pool[]
  /**
   * How long an account stays ejected after being found spent without a reset
   * time to trust. Multiplied by consecutive ejections, so a repeatedly
   * exhausted account backs off instead of being retried every cycle.
   */
  ejectFor: number
  /**
   * Register the claude_auth_* tools with OpenCode. They are convenient, and
   * they are not free: every description sits in the model's context for the
   * whole session, and the agent can call them. Turn them off to keep the CLI
   * as the only front door.
   */
  tools: boolean
  /** Named, switchable arrangements. Offered as rows in the switcher. */
  presets: Record<string, Preset>
  /**
   * Preset applied when nothing has been chosen in the switcher. The switcher's
   * choice is remembered and wins over this.
   */
  preset: string
}

export const DEFAULT_CONFIG: ClaudeAuthConfig = {
  debug: false,
  logLevel: "info",
  logEvents: "",
  logMaxSizeBytes: 5 * 1024 * 1024,
  logKeep: 3,
  quotaProbe: false,
  toastOnRefresh: false,
  accountLabel: DEFAULT_PLACEMENT,

  refreshCheckInterval: 5 * 60_000,
  refreshBeforeExpiry: 60 * 60_000,
  noticeCooldown: 10 * 60_000,
  quotaProbeMaxAge: 10 * 60_000,
  quotaMaxAge: 12 * 60 * 60_000,
  quotaWarnAt: 0.9,
  quotaWeeklyWarnAt: 0.85,
  quotaAlternativeAt: 0.7,
  configReloadInterval: 3000,

  accounts: [],
  autoSwitch: false,
  switchAt: 0.95,
  switchOn429: true,
  switchWindow: "binding",
  strategy: "sticky",
  pools: [],
  ejectFor: 5 * 60_000,
  presets: {},
  preset: "",
  tools: true,
}

/**
 * Strip comments and trailing commas so a commented config file parses.
 *
 * String contents are preserved: a `//` inside a value is data, not a comment.
 */
export function stripJsonc(text: string): string {
  let out = ""
  let inString = false
  let quote = ""
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i++
      } else if (c === quote) {
        inString = false
      }
      continue
    }
    if (c === '"' || c === "'") {
      inString = true
      quote = c
      out += c
      continue
    }
    if (c === "/" && next === "/") {
      inLine = true
      i++
      continue
    }
    if (c === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += c
  }

  // Trailing commas before a closing brace or bracket.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function readFileLayer(path: string): Partial<ClaudeAuthConfig> {
  try {
    if (!existsSync(path)) return {}
    return sanitize(JSON.parse(stripJsonc(readFileSync(path, "utf8"))))
  } catch {
    // A malformed file must not take the plugin down; it simply contributes
    // nothing, and the defaults below still apply.
    return {}
  }
}

const bool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v
  if (v === "true" || v === "1") return true
  if (v === "false" || v === "0") return false
  return undefined
}

/** Accept a partial, unknown-shaped object and keep only what is valid. */
export function sanitize(raw: unknown): Partial<ClaudeAuthConfig> {
  if (!raw || typeof raw !== "object") return {}
  const r = raw as Record<string, unknown>
  const out: Partial<ClaudeAuthConfig> = {}

  if (typeof r.debug === "string" || typeof r.debug === "boolean") {
    out.debug = r.debug
  }
  if (typeof r.logLevel === "string") out.logLevel = parseLevel(r.logLevel)
  if (typeof r.logEvents === "string") out.logEvents = r.logEvents
  if (r.logMaxSize !== undefined) {
    out.logMaxSizeBytes = parseSize(String(r.logMaxSize))
  }
  if (r.logKeep !== undefined) out.logKeep = parseKeep(String(r.logKeep))

  const probe = bool(r.quotaProbe)
  if (probe !== undefined) out.quotaProbe = probe

  const toast = bool(r.toastOnRefresh)
  if (toast !== undefined) out.toastOnRefresh = toast

  if (isAccountLabelPlacement(r.accountLabel)) out.accountLabel = r.accountLabel

  const tools = bool(r.tools)
  if (tools !== undefined) out.tools = tools

  const autoSwitch = bool(r.autoSwitch)
  if (autoSwitch !== undefined) out.autoSwitch = autoSwitch

  const on429 = bool(r.switchOn429)
  if (on429 !== undefined) out.switchOn429 = on429

  if (isSwitchWindow(r.switchWindow)) out.switchWindow = r.switchWindow
  if (isBalanceStrategy(r.strategy)) out.strategy = r.strategy

  const accounts = parseAccounts(r.accounts)
  if (accounts !== undefined) out.accounts = accounts

  const pools = parsePools(r.pools)
  if (pools !== undefined) out.pools = pools

  const presets = parsePresets(r.presets)
  if (presets !== undefined) out.presets = presets

  if (typeof r.preset === "string") out.preset = r.preset.trim()

  const durations: Array<[keyof ClaudeAuthConfig, unknown]> = [
    ["refreshCheckInterval", r.refreshCheckInterval],
    ["refreshBeforeExpiry", r.refreshBeforeExpiry],
    ["noticeCooldown", r.noticeCooldown],
    ["quotaProbeMaxAge", r.quotaProbeMaxAge],
    ["quotaMaxAge", r.quotaMaxAge],
    ["configReloadInterval", r.configReloadInterval],
    ["ejectFor", r.ejectFor],
  ]
  for (const [key, value] of durations) {
    if (value === undefined) continue
    const parsed = parseDuration(
      value as string | number,
      DEFAULT_CONFIG[key] as number,
    )
    ;(out as Record<string, unknown>)[key] = parsed
  }

  const ratios: Array<[keyof ClaudeAuthConfig, unknown]> = [
    ["quotaWarnAt", r.quotaWarnAt],
    ["quotaWeeklyWarnAt", r.quotaWeeklyWarnAt],
    ["quotaAlternativeAt", r.quotaAlternativeAt],
    ["switchAt", r.switchAt],
  ]
  for (const [key, value] of ratios) {
    if (value === undefined) continue
    ;(out as Record<string, unknown>)[key] = parseRatio(
      value as string | number,
      DEFAULT_CONFIG[key] as number,
    )
  }

  return out
}

/** Highest-precedence layer: the environment. */
export function envLayer(
  env: NodeJS.ProcessEnv = process.env,
): Partial<ClaudeAuthConfig> {
  const out: Partial<ClaudeAuthConfig> = {}
  if (env.CLAUDE_AUTH_DEBUG) {
    out.debug = env.CLAUDE_AUTH_DEBUG === "1" ? true : env.CLAUDE_AUTH_DEBUG
  }
  if (env.CLAUDE_AUTH_DEBUG_LEVEL) {
    out.logLevel = parseLevel(env.CLAUDE_AUTH_DEBUG_LEVEL)
  }
  if (env.CLAUDE_AUTH_DEBUG_EVENTS !== undefined) {
    out.logEvents = env.CLAUDE_AUTH_DEBUG_EVENTS
  }
  if (env.CLAUDE_AUTH_DEBUG_MAX_SIZE) {
    out.logMaxSizeBytes = parseSize(env.CLAUDE_AUTH_DEBUG_MAX_SIZE)
  }
  if (env.CLAUDE_AUTH_DEBUG_KEEP)
    out.logKeep = parseKeep(env.CLAUDE_AUTH_DEBUG_KEEP)
  if (env.CLAUDE_AUTH_QUOTA_PROBE !== undefined) {
    out.quotaProbe = env.CLAUDE_AUTH_QUOTA_PROBE === "1"
  }
  if (env.CLAUDE_AUTH_TOAST_REFRESH !== undefined) {
    out.toastOnRefresh = env.CLAUDE_AUTH_TOAST_REFRESH === "1"
  }
  if (isAccountLabelPlacement(env.CLAUDE_AUTH_ACCOUNT_LABEL)) {
    out.accountLabel = env.CLAUDE_AUTH_ACCOUNT_LABEL
  }
  if (env.CLAUDE_AUTH_AUTO_SWITCH !== undefined) {
    out.autoSwitch = env.CLAUDE_AUTH_AUTO_SWITCH === "1"
  }
  if (env.CLAUDE_AUTH_SWITCH_ON_429 !== undefined) {
    out.switchOn429 = env.CLAUDE_AUTH_SWITCH_ON_429 === "1"
  }
  if (env.CLAUDE_AUTH_SWITCH_AT) {
    out.switchAt = parseRatio(
      env.CLAUDE_AUTH_SWITCH_AT,
      DEFAULT_CONFIG.switchAt,
    )
  }
  if (isSwitchWindow(env.CLAUDE_AUTH_SWITCH_WINDOW)) {
    out.switchWindow = env.CLAUDE_AUTH_SWITCH_WINDOW
  }
  if (isBalanceStrategy(env.CLAUDE_AUTH_STRATEGY)) {
    out.strategy = env.CLAUDE_AUTH_STRATEGY
  }
  if (env.CLAUDE_AUTH_ACCOUNTS !== undefined) {
    const parsed = parseAccounts(env.CLAUDE_AUTH_ACCOUNTS.split(","))
    if (parsed) out.accounts = parsed
  }
  if (env.CLAUDE_AUTH_TOOLS !== undefined) {
    out.tools = env.CLAUDE_AUTH_TOOLS === "1"
  }
  if (env.CLAUDE_AUTH_PRESET !== undefined) {
    out.preset = env.CLAUDE_AUTH_PRESET.trim()
  }
  // `pools` and `presets` are deliberately file-only: a tiered, per-pool-strategy
  // structure does not survive being flattened into one environment variable
  // legibly. CLAUDE_AUTH_PRESET selects one by name, which does.
  return out
}

export function candidatePaths(
  projectDir?: string,
  home: string = homedir(),
): string[] {
  const paths = [
    join(home, ".config", "opencode", CONFIG_FILENAME),
    join(home, ".config", "opencode", CONFIG_FILENAME_JSON),
  ]
  if (projectDir) {
    paths.push(join(projectDir, CONFIG_FILENAME))
    paths.push(join(projectDir, CONFIG_FILENAME_JSON))
  }
  return paths
}

/** Merge layers in order; later wins, and undefined never overwrites. */
export function mergeConfig(
  ...layers: Array<Partial<ClaudeAuthConfig>>
): ClaudeAuthConfig {
  const out = { ...DEFAULT_CONFIG }
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

export function resolveConfig(
  projectDir?: string,
  inline?: unknown,
): ClaudeAuthConfig {
  return mergeConfig(
    ...candidatePaths(projectDir).map(readFileLayer),
    sanitize(inline),
    envLayer(),
  )
}

// ---------------------------------------------------------------------------
// Live reload
// ---------------------------------------------------------------------------

/**
 * Cached config, invalidated when any candidate file changes.
 *
 * Checked at most every `RECHECK_MS`, and only by stat, so the common path is
 * cheap. This is the reason for a file over environment variables: editing it
 * takes effect without a new shell or an OpenCode restart.
 */
const RECHECK_FALLBACK_MS = 3000

let cached: ClaudeAuthConfig | null = null
let cachedAt = 0
let cachedStamp = ""
let cachedProjectDir: string | undefined
let cachedInline: unknown

function stampFor(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const s = statSync(p)
        return `${p}:${s.mtimeMs}:${s.size}`
      } catch {
        return `${p}:-`
      }
    })
    .join("|")
}

export function getConfig(
  projectDir: string | undefined = cachedProjectDir,
  inline: unknown = cachedInline,
): ClaudeAuthConfig {
  const now = Date.now()
  const recheck = cached?.configReloadInterval ?? RECHECK_FALLBACK_MS
  if (cached && now - cachedAt < recheck) return cached

  const paths = candidatePaths(projectDir)
  const stamp = stampFor(paths)
  cachedAt = now

  if (cached && stamp === cachedStamp) return cached

  cachedStamp = stamp
  cachedProjectDir = projectDir
  cachedInline = inline
  cached = resolveConfig(projectDir, inline)
  return cached
}

/** Record the project directory and inline options discovered at plugin start. */
export function primeConfig(
  projectDir?: string,
  inline?: unknown,
): ClaudeAuthConfig {
  cached = null
  cachedAt = 0
  cachedStamp = ""
  cachedProjectDir = projectDir
  cachedInline = inline
  return getConfig(projectDir, inline)
}

export function resetConfigCache(): void {
  cached = null
  cachedAt = 0
  cachedStamp = ""
  cachedProjectDir = undefined
  cachedInline = undefined
}
