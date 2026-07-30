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
  const raw =
    typeof input === "number"
      ? input
      : Number.parseFloat(String(input).replace("%", ""))
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  const asRatio = raw > 1 ? raw / 100 : raw
  return asRatio > 0 && asRatio <= 1 ? asRatio : fallback
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

  const durations: Array<[keyof ClaudeAuthConfig, unknown]> = [
    ["refreshCheckInterval", r.refreshCheckInterval],
    ["refreshBeforeExpiry", r.refreshBeforeExpiry],
    ["noticeCooldown", r.noticeCooldown],
    ["quotaProbeMaxAge", r.quotaProbeMaxAge],
    ["quotaMaxAge", r.quotaMaxAge],
    ["configReloadInterval", r.configReloadInterval],
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
