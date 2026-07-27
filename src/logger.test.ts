import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"
import {
  closeLogger,
  initLogger,
  log,
  parseKeep,
  parseSize,
  redact,
  rotateLog,
} from "./logger.ts"

describe("logger", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-auth-log-test-"))
    delete process.env.CLAUDE_AUTH_DEBUG
  })

  afterEach(() => {
    closeLogger()
    delete process.env.CLAUDE_AUTH_DEBUG
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("no-op mode", () => {
    it("log() does nothing when CLAUDE_AUTH_DEBUG is unset", () => {
      initLogger()
      log("test_event", { key: "value" })
      // No file should be created at default path
      const defaultPath = join(tmpDir, "claude-auth-debug.log")
      assert.ok(!existsSync(defaultPath), "No log file should be created")
    })

    it("log() does nothing when CLAUDE_AUTH_DEBUG is empty string", () => {
      process.env.CLAUDE_AUTH_DEBUG = ""
      initLogger()
      log("test_event", { key: "value" })
      const defaultPath = join(tmpDir, "claude-auth-debug.log")
      assert.ok(!existsSync(defaultPath), "No log file should be created")
    })
  })

  describe("file mode", () => {
    it("writes JSON lines to the specified path", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("test_event", { key: "value" })

      const content = readFileSync(logPath, "utf-8").trim()
      const parsed = JSON.parse(content)
      assert.equal(parsed.event, "test_event")
      assert.equal(parsed.key, "value")
      assert.ok(parsed.ts, "should have a timestamp")
    })

    it("appends multiple events as separate lines", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("event_one", { a: 1 })
      log("event_two", { b: 2 })

      const lines = readFileSync(logPath, "utf-8").trim().split("\n")
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).event, "event_one")
      assert.equal(JSON.parse(lines[1]).event, "event_two")
    })

    it("keeps the previous session's log instead of truncating", () => {
      // Truncating on every init destroyed the run you most often want: the one
      // that just failed at start-up, before you restarted. Rotation is now
      // driven by size, so init appends.
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath

      initLogger()
      log("old_event", {})
      closeLogger()

      initLogger()
      log("new_event", {})

      const lines = readFileSync(logPath, "utf-8").trim().split("\n")
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).event, "old_event")
      assert.equal(JSON.parse(lines[1]).event, "new_event")
    })

    it("creates parent directories if they don't exist", () => {
      const logPath = join(tmpDir, "nested", "dirs", "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("test_event", {})

      assert.ok(
        existsSync(logPath),
        "Log file should be created in nested dirs",
      )
    })

    it("treats CLAUDE_AUTH_DEBUG=1 as default path", () => {
      process.env.CLAUDE_AUTH_DEBUG = "1"
      // Just verify initLogger doesn't throw — we can't easily assert
      // the default path without polluting the real filesystem
      initLogger()
      log("test_event", {})
      closeLogger()
    })
  })

  describe("stream mode", () => {
    it("writes JSON lines to a provided stream", () => {
      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      log("stream_event", { key: "value" })

      const parsed = JSON.parse(chunks.join("").trim())
      assert.equal(parsed.event, "stream_event")
      assert.equal(parsed.key, "value")
    })

    it("ignores CLAUDE_AUTH_DEBUG env var when stream is provided", () => {
      const logPath = join(tmpDir, "should-not-exist.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath

      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      log("stream_event", {})

      assert.ok(
        !existsSync(logPath),
        "File should not be created when stream is provided",
      )
      assert.ok(chunks.length > 0, "Stream should have received data")
    })
  })

  describe("timestamp", () => {
    it("includes an ISO 8601 timestamp", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      const before = new Date().toISOString()
      log("ts_test", {})
      const after = new Date().toISOString()

      const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim())
      assert.ok(parsed.ts >= before, "Timestamp should be >= before")
      assert.ok(parsed.ts <= after, "Timestamp should be <= after")
    })
  })
})

describe("redact", () => {
  it("fully redacts accessToken", () => {
    const result = redact({
      accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123",
    })
    assert.equal(result.accessToken, "REDACTED")
  })

  it("fully redacts refreshToken", () => {
    const result = redact({ refreshToken: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4" })
    assert.equal(result.refreshToken, "REDACTED")
  })

  it("redacts x-api-key", () => {
    const result = redact({ "x-api-key": "sk-ant-api03-abc123def456" })
    assert.equal(result["x-api-key"], "REDACTED")
  })

  it("catches JWT-pattern strings in arbitrary keys", () => {
    const result = redact({
      someToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    })
    assert.equal(result.someToken, "eyJhbGci...REDACTED")
  })

  it("preserves non-sensitive fields", () => {
    const result = redact({
      expiresAt: 1742860800000,
      subscriptionType: "max",
      source: "Claude Code-credentials",
      modelId: "claude-opus-4-6",
    })
    assert.equal(result.expiresAt, 1742860800000)
    assert.equal(result.subscriptionType, "max")
    assert.equal(result.source, "Claude Code-credentials")
    assert.equal(result.modelId, "claude-opus-4-6")
  })

  it("handles short accessToken without crashing", () => {
    const result = redact({ accessToken: "short" })
    assert.equal(result.accessToken, "REDACTED")
  })

  it("handles empty string values", () => {
    const result = redact({ accessToken: "", refreshToken: "" })
    assert.equal(result.accessToken, "REDACTED")
    assert.equal(result.refreshToken, "REDACTED")
  })

  it("passes through non-string values unchanged", () => {
    const result = redact({
      count: 42,
      success: true,
      items: ["a", "b"],
    })
    assert.equal(result.count, 42)
    assert.equal(result.success, true)
    assert.deepEqual(result.items, ["a", "b"])
  })
})

describe("event selection (CLAUDE_AUTH_DEBUG_EVENTS)", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.CLAUDE_AUTH_DEBUG_EVENTS
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_AUTH_DEBUG_EVENTS
    else process.env.CLAUDE_AUTH_DEBUG_EVENTS = saved
    closeLogger()
  })

  /** Apply a spec and return which of `events` would be written. */
  function pass(spec: string | undefined, events: string[]): string[] {
    if (spec === undefined) delete process.env.CLAUDE_AUTH_DEBUG_EVENTS
    else process.env.CLAUDE_AUTH_DEBUG_EVENTS = spec
    const lines: string[] = []
    initLogger({
      stream: { write: (c: string) => lines.push(String(c)) } as never,
    })
    for (const e of events) log(e)
    closeLogger()
    return lines.map((l) => JSON.parse(l).event)
  }

  const ALL = [
    "plugin_init",
    "keychain_read",
    "refresh_started",
    "refresh_failed",
    "proactive_refresh_check",
    "quota_probe",
    "quota_advisory_shown",
    "fetch_error_response",
  ]

  it("logs everything when unset — existing setups are unaffected", () => {
    assert.deepEqual(pass(undefined, ALL), ALL)
    assert.deepEqual(pass("", ALL), ALL)
  })

  it("a bare group name selects the whole group", () => {
    assert.deepEqual(pass("quota", ALL), [
      "quota_probe",
      "quota_advisory_shown",
    ])
  })

  it("accepts several groups", () => {
    assert.deepEqual(pass("quota,plugin", ALL), [
      "plugin_init",
      "quota_probe",
      "quota_advisory_shown",
    ])
  })

  it("matches globs against the whole event name", () => {
    assert.deepEqual(pass("*_failed", ALL), ["refresh_failed"])
  })

  it("excludes with a leading dash, keeping everything else", () => {
    const got = pass("-keychain_read", ALL)
    assert.ok(!got.includes("keychain_read"))
    assert.equal(got.length, ALL.length - 1)
  })

  it("lets exclusions override inclusions", () => {
    // refresh_started is in the group but explicitly removed.
    assert.deepEqual(pass("refresh,-refresh_started", ALL), [
      "refresh_failed",
      // proactive_refresh_* does not start with "refresh"
    ])
  })

  it("does not let a group name match mid-string", () => {
    // "refresh" must not pull in proactive_refresh_check.
    assert.ok(!pass("refresh", ALL).includes("proactive_refresh_check"))
    assert.ok(
      pass("proactive_refresh", ALL).includes("proactive_refresh_check"),
    )
  })

  it("supports the errors alias", () => {
    assert.deepEqual(pass("errors", ALL), [
      "refresh_failed",
      "fetch_error_response",
    ])
  })

  it("treats all and * as everything", () => {
    assert.deepEqual(pass("all", ALL), ALL)
    assert.deepEqual(pass("*", ALL), ALL)
  })

  it("ignores blanks and stray separators", () => {
    assert.deepEqual(pass(" , quota , ", ALL), [
      "quota_probe",
      "quota_advisory_shown",
    ])
  })

  it("accepts ! as an exclusion prefix too", () => {
    assert.ok(!pass("!quota", ALL).includes("quota_probe"))
  })

  it("selects nothing when no pattern matches, rather than falling back to all", () => {
    assert.deepEqual(pass("nonexistent_group", ALL), [])
  })

  it("does not treat a glob metacharacter as a literal escape hatch", () => {
    // A dot in a pattern must not match any character.
    assert.deepEqual(pass("quota.probe", ALL), [])
  })
})

describe("size parsing", () => {
  it("accepts plain byte counts", () => {
    assert.equal(parseSize("512"), 512)
  })

  it("accepts suffixed sizes", () => {
    assert.equal(parseSize("1KB"), 1024)
    assert.equal(parseSize("2mb"), 2 * 1024 * 1024)
    assert.equal(parseSize("1 MiB"), 1024 * 1024)
    assert.equal(parseSize("1.5KB"), 1536)
  })

  it("falls back on junk rather than logging to a zero-size file", () => {
    // A zero or negative cap would rotate on every single line.
    for (const bad of ["", "abc", "0", "-5", "5 parsecs", undefined]) {
      assert.equal(parseSize(bad, 999), 999)
    }
  })

  it("defaults to 5 MB", () => {
    assert.equal(parseSize(undefined), 5 * 1024 * 1024)
  })
})

describe("keep parsing", () => {
  it("reads a count", () => {
    assert.equal(parseKeep("5"), 5)
  })

  it("allows zero, meaning no history", () => {
    assert.equal(parseKeep("0"), 0)
  })

  it("rejects junk and negatives", () => {
    for (const bad of ["", "abc", "-1", undefined]) {
      assert.equal(parseKeep(bad, 3), 3)
    }
  })

  it("caps the number of generations", () => {
    assert.equal(parseKeep("9999"), 50)
  })
})

const rotDir = mkdtempSync(join(tmpdir(), "logrot-"))

describe("rotateLog", () => {
  it("shifts generations and starts empty", () => {
    const p = join(rotDir, "rot.log")
    writeFileSync(p, "current\n")
    writeFileSync(`${p}.1`, "older\n")

    rotateLog(p, 3)

    assert.equal(readFileSync(p, "utf-8"), "")
    assert.equal(readFileSync(`${p}.1`, "utf-8"), "current\n")
    assert.equal(readFileSync(`${p}.2`, "utf-8"), "older\n")
  })

  it("discards the oldest beyond keep", () => {
    const p = join(rotDir, "rot2.log")
    writeFileSync(p, "c\n")
    writeFileSync(`${p}.1`, "b\n")
    writeFileSync(`${p}.2`, "a\n")

    rotateLog(p, 2)

    assert.equal(readFileSync(`${p}.1`, "utf-8"), "c\n")
    assert.equal(readFileSync(`${p}.2`, "utf-8"), "b\n")
    assert.equal(existsSync(`${p}.3`), false)
  })

  it("keep=0 truncates without keeping history", () => {
    const p = join(rotDir, "rot3.log")
    writeFileSync(p, "gone\n")
    rotateLog(p, 0)
    assert.equal(readFileSync(p, "utf-8"), "")
    assert.equal(existsSync(`${p}.1`), false)
  })

  it("does not throw on an unwritable path", () => {
    assert.doesNotThrow(() => rotateLog("/proc/nope/x.log", 3))
  })
})

describe("rotation while logging", () => {
  let savedMax: string | undefined
  let savedKeep: string | undefined

  beforeEach(() => {
    savedMax = process.env.CLAUDE_AUTH_DEBUG_MAX_SIZE
    savedKeep = process.env.CLAUDE_AUTH_DEBUG_KEEP
  })
  afterEach(() => {
    if (savedMax === undefined) delete process.env.CLAUDE_AUTH_DEBUG_MAX_SIZE
    else process.env.CLAUDE_AUTH_DEBUG_MAX_SIZE = savedMax
    if (savedKeep === undefined) delete process.env.CLAUDE_AUTH_DEBUG_KEEP
    else process.env.CLAUDE_AUTH_DEBUG_KEEP = savedKeep
    closeLogger()
  })

  it("rotates once the file passes the limit", () => {
    const p = join(rotDir, "grow.log")
    process.env.CLAUDE_AUTH_DEBUG = p
    process.env.CLAUDE_AUTH_DEBUG_MAX_SIZE = "400"
    process.env.CLAUDE_AUTH_DEBUG_KEEP = "2"

    initLogger()
    for (let i = 0; i < 40; i++) log("stream_event", { i, pad: "x".repeat(40) })
    closeLogger()

    // The live file is bounded, and history exists.
    assert.ok(statSync(p).size <= 400 + 200, `live file ${statSync(p).size}B`)
    assert.equal(existsSync(`${p}.1`), true)
  })

  it("never keeps more generations than requested", () => {
    const p = join(rotDir, "grow2.log")
    process.env.CLAUDE_AUTH_DEBUG = p
    process.env.CLAUDE_AUTH_DEBUG_MAX_SIZE = "200"
    process.env.CLAUDE_AUTH_DEBUG_KEEP = "2"

    initLogger()
    for (let i = 0; i < 80; i++) log("stream_event", { i, pad: "y".repeat(40) })
    closeLogger()

    assert.equal(existsSync(`${p}.1`), true)
    assert.equal(existsSync(`${p}.2`), true)
    assert.equal(existsSync(`${p}.3`), false)
  })

  it("rotates at init when the existing file is already over the limit", () => {
    const p = join(rotDir, "big.log")
    writeFileSync(p, "z".repeat(1000))
    process.env.CLAUDE_AUTH_DEBUG = p
    process.env.CLAUDE_AUTH_DEBUG_MAX_SIZE = "500"
    process.env.CLAUDE_AUTH_DEBUG_KEEP = "1"

    initLogger()
    log("new_event", {})

    assert.equal(readFileSync(`${p}.1`, "utf-8").length, 1000)
    assert.equal(readFileSync(p, "utf-8").trim().split("\n").length, 1)
  })
})
