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
  parseRatio,
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

describe("balancer config", () => {
  it("accepts every strategy name and rejects anything else", () => {
    for (const s of [
      "sticky",
      "priority",
      "least-loaded",
      "round-robin",
      "weighted",
      "least-used",
      "random",
      "p2c",
    ]) {
      assert.equal(sanitize({ strategy: s }).strategy, s)
    }
    // A real load-balancer term this plugin does not implement: in-flight
    // connection counts mean nothing when one process serves one request.
    assert.equal(
      sanitize({ strategy: "least-connections" }).strategy,
      undefined,
    )
    assert.equal(sanitize({ strategy: "" }).strategy, undefined)
  })

  it("reads switchAt as a ratio or a percentage", () => {
    assert.equal(sanitize({ switchAt: 0.8 }).switchAt, 0.8)
    assert.equal(sanitize({ switchAt: "85%" }).switchAt, 0.85)
  })

  it("takes the window only from the three known values", () => {
    assert.equal(sanitize({ switchWindow: "7d" }).switchWindow, "7d")
    assert.equal(sanitize({ switchWindow: "monthly" }).switchWindow, undefined)
  })

  it("coerces the booleans the way the rest of the file does", () => {
    assert.equal(sanitize({ autoSwitch: "true" }).autoSwitch, true)
    assert.equal(sanitize({ switchOn429: "0" }).switchOn429, false)
  })

  it("trims and de-duplicates accounts while keeping preference order", () => {
    assert.deepEqual(
      sanitize({ accounts: [" b ", "a", "b", 7, ""] }).accounts,
      ["b", "a"],
    )
  })

  it("names an unnamed pool by position and drops one with no accounts", () => {
    const pools = sanitize({
      pools: [
        { accounts: ["a"] },
        { name: "empty", accounts: [] },
        { accounts: ["b"] },
      ],
    }).pools
    assert.deepEqual(
      pools?.map((p) => p.name),
      ["pool0", "pool2"],
    )
  })

  it("keeps only positive numeric weights", () => {
    const pools = sanitize({
      pools: [
        { name: "p", accounts: ["a", "b"], weights: { a: 3, b: -1, c: "x" } },
      ],
    }).pools
    assert.deepEqual(pools?.[0]?.weights, { a: 3 })
  })

  it("keeps a per-pool strategy separate from the top-level one", () => {
    const out = sanitize({
      strategy: "sticky",
      pools: [{ name: "p", accounts: ["a"], strategy: "round-robin" }],
    })
    assert.equal(out.strategy, "sticky")
    assert.equal(out.pools?.[0]?.strategy, "round-robin")
  })

  it("ignores a bogus per-pool strategy rather than failing the pool", () => {
    const pools = sanitize({
      pools: [{ name: "p", accounts: ["a"], strategy: "nope" }],
    }).pools
    assert.equal(pools?.length, 1)
    assert.equal(pools?.[0]?.strategy, undefined)
  })

  it("reads ejectFor as a duration", () => {
    assert.equal(sanitize({ ejectFor: "90s" }).ejectFor, 90_000)
  })

  it("exposes the balancer knobs to the environment, pools excepted", () => {
    const layer = envLayer({
      CLAUDE_AUTH_AUTO_SWITCH: "1",
      CLAUDE_AUTH_SWITCH_AT: "70%",
      CLAUDE_AUTH_SWITCH_ON_429: "0",
      CLAUDE_AUTH_SWITCH_WINDOW: "5h",
      CLAUDE_AUTH_STRATEGY: "least-loaded",
      CLAUDE_AUTH_ACCOUNTS: "a, b ,a",
    } as NodeJS.ProcessEnv)
    assert.equal(layer.autoSwitch, true)
    assert.equal(layer.switchAt, 0.7)
    assert.equal(layer.switchOn429, false)
    assert.equal(layer.switchWindow, "5h")
    assert.equal(layer.strategy, "least-loaded")
    assert.deepEqual(layer.accounts, ["a", "b"])
    assert.equal(layer.pools, undefined)
  })

  it("defaults to off and sticky, so nothing rotates until asked", () => {
    assert.equal(DEFAULT_CONFIG.autoSwitch, false)
    assert.equal(DEFAULT_CONFIG.strategy, "sticky")
    assert.deepEqual(DEFAULT_CONFIG.pools, [])
  })
})

describe("parseRatio ambiguity", () => {
  it("reads a bare number above 1 as a percentage", () => {
    assert.equal(parseRatio(90, 0.5), 0.9)
    assert.equal(parseRatio(95, 0.5), 0.95)
  })

  it("reads an explicit percent as written, however small", () => {
    assert.equal(parseRatio("1.5%", 0.5), 0.015)
    assert.equal(parseRatio("85%", 0.5), 0.85)
  })

  it("refuses a bare 1..2, which used to silently mean 1.5%", () => {
    // Someone writing 1.5 is reaching for "above 100%" to disable a threshold.
    // Returning 0.015 condemned every account rather than none.
    assert.equal(parseRatio(1.5, 0.95), 0.95)
    assert.equal(parseRatio(1.01, 0.95), 0.95)
  })

  it("still accepts the boundaries either side", () => {
    assert.equal(parseRatio(1, 0.5), 1)
    assert.equal(parseRatio(2, 0.5), 0.02)
    assert.equal(parseRatio(0.015, 0.5), 0.015)
  })

  it("falls back on nonsense", () => {
    assert.equal(parseRatio("abc", 0.5), 0.5)
    assert.equal(parseRatio(0, 0.5), 0.5)
    assert.equal(parseRatio(-1, 0.5), 0.5)
    assert.equal(parseRatio("150%", 0.5), 0.5)
  })
})
