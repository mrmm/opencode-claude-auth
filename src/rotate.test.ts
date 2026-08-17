import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { DEFAULT_CONFIG, type ClaudeAuthConfig } from "./config.ts"
import { credentialState, resolveActiveConfig } from "./rotate.ts"

const cfg = (over: Partial<ClaudeAuthConfig> = {}): ClaudeAuthConfig => ({
  ...DEFAULT_CONFIG,
  ...over,
})

const NOW = 1785000000000

const account = (over: Record<string, unknown> = {}) =>
  ({
    source: "s",
    label: "l",
    credentials: {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: NOW + 60_000,
    },
    ...over,
    // biome-ignore lint: shaped like a ClaudeAccount for the function under test
  }) as never

describe("credentialState", () => {
  it("accepts a live token", () => {
    assert.equal(credentialState(account(), NOW), "ok")
  })

  it("takes a token with no expiry at face value", () => {
    // A long-lived token is legitimate; refusing it would exclude a working seat.
    assert.equal(
      credentialState(
        account({ credentials: { accessToken: "tok", refreshToken: "" } }),
        NOW,
      ),
      "ok",
    )
  })

  it("calls an expired token with a refresh token refreshable", () => {
    assert.equal(
      credentialState(
        account({
          credentials: {
            accessToken: "tok",
            refreshToken: "ref",
            expiresAt: NOW - 1,
          },
        }),
        NOW,
      ),
      "refreshable",
    )
  })

  it("calls an expired token with nothing to refresh from unusable", () => {
    assert.equal(
      credentialState(
        account({
          credentials: {
            accessToken: "tok",
            refreshToken: "",
            expiresAt: NOW - 1,
          },
        }),
        NOW,
      ),
      "unusable",
    )
  })

  it("calls an entry holding no access token unusable", () => {
    // Observed on a real Keychain: an entry present but never populated.
    assert.equal(
      credentialState(
        account({ credentials: { accessToken: "", expiresAt: 0 } }),
        NOW,
      ),
      "unusable",
    )
    assert.equal(
      credentialState(account({ credentials: undefined }), NOW),
      "unusable",
    )
  })
})

describe("resolveActiveConfig", () => {
  const presets = {
    "rr-12": { strategy: "round-robin" as const, accounts: ["one", "two"] },
    tiered: {
      pools: [
        { name: "hot", accounts: ["one"] },
        { name: "cold", accounts: ["two"] },
      ],
    },
  }

  it("passes the config through when nothing is selected", () => {
    const out = resolveActiveConfig(cfg({ presets }), null)
    assert.equal(out.preset, null)
    assert.equal(out.cfg.strategy, "sticky")
  })

  it("applies the preset chosen in the switcher", () => {
    const out = resolveActiveConfig(cfg({ presets }), "preset:rr-12")
    assert.equal(out.preset, "rr-12")
    assert.equal(out.cfg.strategy, "round-robin")
    assert.deepEqual(out.cfg.accounts, ["one", "two"])
  })

  it("lets the switcher choice beat the configured default", () => {
    const out = resolveActiveConfig(
      cfg({ presets, preset: "tiered" }),
      "preset:rr-12",
    )
    assert.equal(out.preset, "rr-12")
  })

  it("falls back to the configured default preset", () => {
    const out = resolveActiveConfig(cfg({ presets, preset: "rr-12" }), null)
    assert.equal(out.preset, "rr-12")
    assert.equal(out.cfg.strategy, "round-robin")
  })

  it("ignores a pinned account, which is not a preset", () => {
    const out = resolveActiveConfig(
      cfg({ presets }),
      "Claude Code-credentials-abc",
    )
    assert.equal(out.preset, null)
  })

  it("ignores an unknown preset rather than narrowing the account set", () => {
    // A typo must not silently reduce which accounts may serve requests.
    const out = resolveActiveConfig(
      cfg({ presets, accounts: ["keep"] }),
      "preset:typo",
    )
    assert.equal(out.preset, null)
    assert.deepEqual(out.cfg.accounts, ["keep"])
  })

  it("a tiered preset replaces inherited flat accounts entirely", () => {
    const out = resolveActiveConfig(
      cfg({ presets, accounts: ["inherited"] }),
      "preset:tiered",
    )
    assert.deepEqual(out.cfg.accounts, [])
    assert.deepEqual(
      out.cfg.pools.map((p) => p.name),
      ["hot", "cold"],
    )
  })

  it("a flat preset replaces inherited pools entirely", () => {
    const out = resolveActiveConfig(
      cfg({ presets, pools: [{ name: "inherited", accounts: ["x"] }] }),
      "preset:rr-12",
    )
    assert.deepEqual(out.cfg.pools, [])
    assert.deepEqual(out.cfg.accounts, ["one", "two"])
  })
})
