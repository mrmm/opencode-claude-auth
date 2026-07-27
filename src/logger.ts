import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
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

type LogMode = "disabled" | "file" | "stream"

let mode: LogMode = "disabled"
let logFilePath: string | null = null
let logStream: Writable | null = null

function getDefaultLogPath(): string {
  return join(homedir(), ".local", "share", "opencode", "claude-auth-debug.log")
}

export function initLogger(options?: { stream?: Writable }): void {
  closeLogger()

  compileEventSpec(process.env.CLAUDE_AUTH_DEBUG_EVENTS)

  if (options?.stream) {
    mode = "stream"
    logStream = options.stream
    return
  }

  compileEventSpec(process.env.CLAUDE_AUTH_DEBUG_EVENTS)

  const envVal = process.env.CLAUDE_AUTH_DEBUG
  if (!envVal) {
    mode = "disabled"
    return
  }

  mode = "file"
  logFilePath = envVal === "1" ? getDefaultLogPath() : envVal

  const dir = dirname(logFilePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(logFilePath, "", "utf-8")
}

export function log(event: string, data?: Record<string, unknown>): void {
  if (mode === "disabled") return
  if (!eventEnabled(event)) return

  const entry = {
    ts: new Date().toISOString(),
    event,
    ...redact(data ?? {}),
  }
  const line = JSON.stringify(entry) + "\n"

  if (mode === "file" && logFilePath) {
    appendFileSync(logFilePath, line, "utf-8")
  } else if (mode === "stream" && logStream) {
    logStream.write(line)
  }
}

export function closeLogger(): void {
  mode = "disabled"
  matchers = []
  hasInclude = false
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
