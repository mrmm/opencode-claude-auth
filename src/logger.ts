import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Writable } from "node:stream"

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{10,}/

/**
 * Event selection, via CLAUDE_AUTH_DEBUG_EVENTS.
 *
 * There are dozens of events and most runs only care about a handful; a single
 * keychain read alone fires eight times per start-up. The spec is a
 * comma-separated list of glob patterns:
 *
 *   refresh,quota          only these groups
 *   quota_*,*_failed       globs, matched against the whole event name
 *   -keychain_read         exclusions, which always win
 *   errors                 alias for the failure-shaped events
 *
 * Unset means log everything, so existing setups are unaffected. Exclusion-only
 * specs subtract from everything; once any inclusion is given, only matches pass.
 */
const EVENT_ALIASES: Record<string, string[]> = {
  errors: [
    "*_failed",
    "*_error",
    "*_error_*",
    "*_exhausted",
    "*_unavailable",
    "*_skipped",
  ],
  all: ["*"],
}

/** Prefixes the events group under, for documentation and discoverability. */
export const LOG_CATEGORIES = [
  "account",
  "auth",
  "cache",
  "credentials",
  "fetch",
  "keychain",
  "plugin",
  "proactive_refresh",
  "quota",
  "refresh",
  "sync",
  "writeback",
] as const

type Matcher = { negated: boolean; re: RegExp }

let matchers: Matcher[] = []
let hasInclude = false

function globToRegExp(pattern: string): RegExp {
  // A bare group name matches the whole group: "refresh" behaves as "refresh*".
  const body = pattern.includes("*") ? pattern : `${pattern}*`
  const escaped = body
    .replace(/[.+^${}()|[\]\\]/g, (ch) => `\\${ch}`)
    .replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

function compileEventSpec(spec: string | undefined): void {
  matchers = []
  hasInclude = false
  if (!spec || !spec.trim()) return

  for (const raw of spec.split(",")) {
    let token = raw.trim()
    if (!token) continue

    const negated = token.startsWith("-") || token.startsWith("!")
    if (negated) token = token.slice(1).trim()
    if (!token) continue

    for (const pattern of EVENT_ALIASES[token] ?? [token]) {
      matchers.push({ negated, re: globToRegExp(pattern) })
      if (!negated) hasInclude = true
    }
  }
}

/** Whether an event passes the current selection. */
export function eventEnabled(event: string): boolean {
  if (matchers.length === 0) return true
  for (const m of matchers) {
    if (m.negated && m.re.test(event)) return false
  }
  if (!hasInclude) return true
  return matchers.some((m) => !m.negated && m.re.test(event))
}

/**
 * Size-based rotation.
 *
 * The log previously truncated on every init, which bounded it but threw away
 * the previous session -- exactly the run you want when something failed at
 * start-up and you have just restarted. It now appends across sessions and
 * rotates on size instead, keeping a few generations.
 *
 * Size is tracked in memory, seeded from the file at init, so the hot path does
 * not stat() once per line.
 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_KEEP = 3

/** Accepts a byte count or a suffixed size: 512, 900KB, 5MB, 1.5 MiB. */
export function parseSize(
  input: string | undefined,
  fallback = DEFAULT_MAX_BYTES,
): number {
  if (!input) return fallback
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(b|kb|mb|gb|kib|mib|gib)?\s*$/i.exec(input)
  if (!m) return fallback
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return fallback
  const unit = (m[2] ?? "b").toLowerCase()
  const mult: Record<string, number> = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
  }
  return Math.floor(n * (mult[unit] ?? 1))
}

export function parseKeep(
  input: string | undefined,
  fallback = DEFAULT_KEEP,
): number {
  if (!input) return fallback
  const n = Number.parseInt(input, 10)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(n, 50)
}

/**
 * Shift generations and start a fresh file: log -> log.1, log.1 -> log.2, ...
 *
 * `keep` of 0 means no history: the file is simply truncated. Never throws --
 * losing rotation is preferable to breaking the caller.
 */
export function rotateLog(path: string, keep: number): void {
  try {
    if (keep <= 0) {
      writeFileSync(path, "", "utf-8")
      return
    }
    // Drop the oldest, then shift the rest down, highest first so nothing is
    // overwritten before it has moved.
    const oldest = `${path}.${keep}`
    if (existsSync(oldest)) rmSync(oldest, { force: true })
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${path}.${i}`
      if (existsSync(from)) renameSync(from, `${path}.${i + 1}`)
    }
    if (existsSync(path)) renameSync(path, `${path}.1`)
    writeFileSync(path, "", "utf-8")
  } catch {
    // Rotation is best-effort.
  }
}

/**
 * Line schema, v1.
 *
 * Every line carries the same envelope so a reader never has to know the event
 * vocabulary to make sense of it:
 *
 *   { v, ts, sid, level, group, event, ...payload }
 *
 * - v      schema version, so a parser can evolve without guessing
 * - sid    per-process id. Several opencode processes append to one file, and
 *          without this their lines interleave with no way to attribute them
 * - level  info | warn | error, derived from the event name so severity is
 *          filterable without enumerating 50+ events
 * - group  the family the event belongs to, for aggregation
 *
 * Derivation is by pattern rather than a per-event table: a table of that size
 * rots silently as events are added, whereas a new *_failed event is classified
 * correctly the moment it is written.
 */
export const LOG_SCHEMA_VERSION = 1

export type LogLevel = "info" | "warn" | "error"

const ERROR_PATTERNS = [
  /_failed$/,
  /_error$/,
  /_error_/,
  /_exhausted$/,
  /_unavailable$/,
]
const WARN_PATTERNS = [
  /_skipped$/,
  /_invalid/,
  /_fallback/,
  /_no_[a-z]/,
  /_empty$/,
  /_miss$/,
  /_warning$/,
  /_rate_limited/,
  /_stale$/,
]

/** Severity for an event, overridable by passing `level` in the payload. */
export function deriveLevel(event: string, explicit?: unknown): LogLevel {
  if (explicit === "info" || explicit === "warn" || explicit === "error") {
    return explicit
  }
  const e = event ?? ""
  if (ERROR_PATTERNS.some((r) => r.test(e))) return "error"
  if (WARN_PATTERNS.some((r) => r.test(e))) return "warn"
  return "info"
}

/** Longest known category prefix, else the segment before the first underscore. */
export function deriveGroup(event: string): string {
  const e = event ?? ""
  let best = ""
  for (const c of LOG_CATEGORIES) {
    if ((e === c || e.startsWith(`${c}_`)) && c.length > best.length) best = c
  }
  if (best) return best
  const i = e.indexOf("_")
  return i > 0 ? e.slice(0, i) : e || "unknown"
}

/** Short, stable id for this process, so interleaved lines can be separated. */
const SESSION_ID = Math.random().toString(36).slice(2, 10)

export function sessionId(): string {
  return SESSION_ID
}

/** Minimum severity to record; set via CLAUDE_AUTH_DEBUG_LEVEL. */
const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 }
let minLevel: LogLevel = "info"

export function parseLevel(input: string | undefined): LogLevel {
  const v = (input ?? "").trim().toLowerCase()
  return v === "warn" || v === "warning"
    ? "warn"
    : v === "error"
      ? "error"
      : "info"
}

type LogMode = "disabled" | "file" | "stream"

let mode: LogMode = "disabled"
let logFilePath: string | null = null
let logStream: Writable | null = null
let maxBytes = DEFAULT_MAX_BYTES
let keepFiles = DEFAULT_KEEP
let bytesWritten = 0

function getDefaultLogPath(): string {
  return join(homedir(), ".local", "share", "opencode", "claude-auth-debug.log")
}

export type LoggerConfig = {
  debug?: boolean | string
  logLevel?: LogLevel
  logEvents?: string
  logMaxSizeBytes?: number
  logKeep?: number
}

/**
 * Initialise logging.
 *
 * `config` comes from the resolved config layers when the plugin supplies it;
 * the environment is used directly otherwise, so the logger still works when
 * used standalone or in tests.
 */
export function initLogger(options?: {
  stream?: Writable
  config?: LoggerConfig
}): void {
  closeLogger()

  const cfg = options?.config
  compileEventSpec(cfg?.logEvents ?? process.env.CLAUDE_AUTH_DEBUG_EVENTS)
  minLevel = cfg?.logLevel ?? parseLevel(process.env.CLAUDE_AUTH_DEBUG_LEVEL)

  if (options?.stream) {
    mode = "stream"
    logStream = options.stream
    return
  }

  const debug = cfg?.debug ?? process.env.CLAUDE_AUTH_DEBUG
  if (!debug || debug === "0" || debug === "false") {
    mode = "disabled"
    return
  }

  mode = "file"
  logFilePath =
    debug === true || debug === "1" ? getDefaultLogPath() : String(debug)

  maxBytes =
    cfg?.logMaxSizeBytes ?? parseSize(process.env.CLAUDE_AUTH_DEBUG_MAX_SIZE)
  keepFiles = cfg?.logKeep ?? parseKeep(process.env.CLAUDE_AUTH_DEBUG_KEEP)

  const dir = dirname(logFilePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  // Carry the previous session forward unless it is already at the limit.
  let existing = 0
  try {
    existing = existsSync(logFilePath) ? statSync(logFilePath).size : 0
  } catch {
    existing = 0
  }
  if (existing >= maxBytes) {
    rotateLog(logFilePath, keepFiles)
    existing = 0
  } else if (!existsSync(logFilePath)) {
    writeFileSync(logFilePath, "", "utf-8")
  }
  bytesWritten = existing
}

export function log(event: string, data?: Record<string, unknown>): void {
  if (mode === "disabled") return
  if (!eventEnabled(event)) return

  const { level: explicitLevel, ...payload } = (data ?? {}) as Record<
    string,
    unknown
  >
  const level = deriveLevel(event, explicitLevel)
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  const entry = {
    v: LOG_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    sid: SESSION_ID,
    level,
    group: deriveGroup(event),
    event,
    ...redact(payload),
  }
  const line = JSON.stringify(entry) + "\n"

  if (mode === "file" && logFilePath) {
    // Rotate before writing so a single line never straddles generations.
    if (bytesWritten + line.length > maxBytes) {
      rotateLog(logFilePath, keepFiles)
      bytesWritten = 0
    }
    appendFileSync(logFilePath, line, "utf-8")
    bytesWritten += Buffer.byteLength(line, "utf-8")
  } else if (mode === "stream" && logStream) {
    logStream.write(line)
  }
}

export function closeLogger(): void {
  mode = "disabled"
  matchers = []
  hasInclude = false
  bytesWritten = 0
  maxBytes = DEFAULT_MAX_BYTES
  keepFiles = DEFAULT_KEEP
  minLevel = "info"
  logFilePath = null
  logStream = null
}

function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value

  if (key === "refreshToken" || key === "x-api-key") {
    return "REDACTED"
  }

  if (key === "accessToken") {
    return "REDACTED"
  }

  if (JWT_PATTERN.test(value)) {
    return `${value.slice(0, 8)}...REDACTED`
  }

  return value
}

export function redact(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    result[key] = redactValue(key, value)
  }
  return result
}
