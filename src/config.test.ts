import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_CONFIG,
  envLayer,
  getConfig,
  mergeConfig,
  primeConfig,
  resetConfigCache,
  sanitize,
  stripJsonc,
} from "./config.ts"

/**
 * The environment is the highest-precedence layer, so a developer with
 * CLAUDE_AUTH_* exported would see these tests assert against their shell rather
 * than the code. Precedence itself is covered by passing an explicit env object
 * to envLayer(), which needs no ambient state.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CLAUDE_AUTH_")) delete process.env[key]
}

// homedir() follows HOME on POSIX, and a real ~/.config/opencode/claude-auth.jsonc
// would otherwise be a silent extra layer in every assertion below.
process.env.HOME = mkdtempSync(join(tmpdir(), "cauth-home-"))

const dir = () => mkdtempSync(join(tmpdir(), "cauth-cfg-"))

afterEach(() => resetConfigCache())

describe("stripJsonc", () => {
  it("removes line and block comments", () => {
    const src = `{
      // a line comment
      "quotaProbe": true, /* inline */
      /* block
         spanning lines */
      "logLevel": "warn"
    }`
    assert.deepEqual(JSON.parse(stripJsonc(src)), {
      quotaProbe: true,
      logLevel: "warn",
    })
  })

  it("keeps // inside a string, which is data not a comment", () => {
    const src = '{"debug": "/tmp/a//b.log"}'
    assert.deepEqual(JSON.parse(stripJsonc(src)), { debug: "/tmp/a//b.log" })
  })

  it("tolerates trailing commas", () => {
    assert.deepEqual(JSON.parse(stripJsonc('{"logKeep": 2, }')), { logKeep: 2 })
  })

  it("handles escaped quotes without ending the string early", () => {
    assert.deepEqual(JSON.parse(stripJsonc('{"logEvents": "a\\"b"}')), {
      logEvents: 'a"b',
    })
  })
})

describe("sanitize", () => {
  it("keeps only recognised, valid keys", () => {
    const out = sanitize({
      quotaProbe: true,
      logLevel: "warn",
      accountLabel: "provider",
      nonsense: 1,
      accountLabelTypo: "provider",
    })
    assert.deepEqual(out, {
      quotaProbe: true,
      logLevel: "warn",
      accountLabel: "provider",
    })
  })

  it("accepts human sizes and string booleans", () => {
    const out = sanitize({
      logMaxSize: "2MB",
      logKeep: "5",
      quotaProbe: "true",
    })
    assert.equal(out.logMaxSizeBytes, 2 * 1024 * 1024)
    assert.equal(out.logKeep, 5)
    assert.equal(out.quotaProbe, true)
  })

  it("drops an invalid placement rather than accepting it", () => {
    assert.equal(sanitize({ accountLabel: "sideways" }).accountLabel, undefined)
  })

  it("ignores junk input", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      assert.deepEqual(sanitize(bad), {})
    }
  })
})

describe("precedence", () => {
  it("later layers win, and undefined never overwrites", () => {
    const merged = mergeConfig(
      { quotaProbe: true, logKeep: 9 },
      { quotaProbe: false },
      { logKeep: undefined },
    )
    assert.equal(merged.quotaProbe, false)
    assert.equal(merged.logKeep, 9)
  })

  it("falls back to defaults for anything unset", () => {
    assert.deepEqual(mergeConfig({}), DEFAULT_CONFIG)
  })

  it("environment overrides the file, so a one-off switch still works", () => {
    const d = dir()
    writeFileSync(join(d, "claude-auth.jsonc"), '{"quotaProbe": false}')
    const cfg = mergeConfig(
      sanitize({ quotaProbe: false }),
      envLayer({ CLAUDE_AUTH_QUOTA_PROBE: "1" } as NodeJS.ProcessEnv),
    )
    assert.equal(cfg.quotaProbe, true)
  })

  it("reads CLAUDE_AUTH_DEBUG=1 as 'use the default path'", () => {
    assert.equal(envLayer({ CLAUDE_AUTH_DEBUG: "1" } as never).debug, true)
    assert.equal(
      envLayer({ CLAUDE_AUTH_DEBUG: "/tmp/x.log" } as never).debug,
      "/tmp/x.log",
    )
  })

  it("ignores an empty environment", () => {
    assert.deepEqual(envLayer({} as NodeJS.ProcessEnv), {})
  })
})

describe("file loading", () => {
  it("reads a project config file", () => {
    const d = dir()
    writeFileSync(
      join(d, "claude-auth.jsonc"),
      '{ // comment\n "quotaProbe": true, "logLevel": "warn" }',
    )
    const cfg = primeConfig(d, undefined)
    assert.equal(cfg.quotaProbe, true)
    assert.equal(cfg.logLevel, "warn")
  })

  it("inline options beat the file", () => {
    const d = dir()
    writeFileSync(join(d, "claude-auth.jsonc"), '{"quotaProbe": false}')
    assert.equal(primeConfig(d, { quotaProbe: true }).quotaProbe, true)
  })

  it("a malformed file contributes nothing instead of throwing", () => {
    const d = dir()
    writeFileSync(join(d, "claude-auth.jsonc"), "{ not json at all")
    assert.doesNotThrow(() => primeConfig(d, undefined))
    assert.equal(
      primeConfig(d, undefined).quotaProbe,
      DEFAULT_CONFIG.quotaProbe,
    )
  })

  it("a missing file is simply no layer", () => {
    assert.deepEqual(primeConfig(dir(), undefined), DEFAULT_CONFIG)
  })
})

describe("live reload", () => {
  it("picks up an edit without re-priming — the reason for a file", () => {
    const d = dir()
    const f = join(d, "claude-auth.jsonc")
    writeFileSync(f, '{"logLevel": "info"}')
    assert.equal(primeConfig(d, undefined).logLevel, "info")

    // Rewrite with different content and size, then defeat the recheck window.
    writeFileSync(f, '{"logLevel": "error", "quotaProbe": true}')
    resetCacheClock()

    const cfg = getConfig()
    assert.equal(cfg.logLevel, "error")
    assert.equal(cfg.quotaProbe, true)
  })

  it("serves the cached value inside the recheck window", () => {
    const d = dir()
    const f = join(d, "claude-auth.jsonc")
    writeFileSync(f, '{"logLevel": "info"}')
    primeConfig(d, undefined)
    writeFileSync(f, '{"logLevel": "error"}')
    // No clock reset: the previous value should still be served.
    assert.equal(getConfig().logLevel, "info")
  })
})

/** Force the next getConfig() past its recheck window. */
function resetCacheClock(): void {
  // The module caches by timestamp; waiting is the honest way to cross it.
  const until = Date.now() + 3100
  while (Date.now() < until) {
    // busy-wait briefly; the window is 3s
  }
}
