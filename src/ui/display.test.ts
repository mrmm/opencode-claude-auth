import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyAccountLabelToConfig,
  decorateName,
  DEFAULT_PLACEMENT,
  isAccountLabelPlacement,
  shouldDecorateModel,
  shouldDecorateProvider,
} from "./display.ts"

const LABEL = "Claude Team - Jack Test"

describe("decorateName", () => {
  it("appends the label as a parenthesised suffix", () => {
    assert.equal(decorateName("Anthropic", LABEL), `Anthropic (acct: ${LABEL})`)
  })

  it("is idempotent — the loader may run more than once per session", () => {
    const once = decorateName("Anthropic", LABEL)
    const twice = decorateName(once, LABEL)
    const thrice = decorateName(twice, LABEL)
    assert.equal(thrice, once)
  })

  it("replaces a stale label instead of appending a second one", () => {
    // The user switched accounts and the provider object was reused.
    const before = decorateName("Anthropic", "Claude Pro - Old")
    const after = decorateName(before, LABEL)
    assert.equal(after, `Anthropic (acct: ${LABEL})`)
    assert.ok(!after.includes("Old"))
  })

  it("leaves the name alone when the label is empty", () => {
    assert.equal(decorateName("Anthropic", ""), "Anthropic")
    assert.equal(decorateName("Anthropic", "   "), "Anthropic")
  })

  it("does not eat a name that legitimately ends in parentheses", () => {
    // "Claude Haiku 4.5 (latest)" is a real model name from /config/providers.
    // Detecting a stale label by bare trailing "(...)" replaced the "(latest)".
    const once = decorateName("Claude Haiku 4.5 (latest)", LABEL)
    assert.equal(once, `Claude Haiku 4.5 (latest) (acct: ${LABEL})`)

    // Still idempotent, and still able to swap in a new account label.
    assert.equal(decorateName(once, LABEL), once)
    assert.equal(
      decorateName(once, "Claude Pro - Other"),
      "Claude Haiku 4.5 (latest) (acct: Claude Pro - Other)",
    )
  })

  it("does not mistake parentheses inside a model name for a label", () => {
    // Only a trailing (...) group is treated as a previous label.
    assert.equal(
      decorateName("Claude (beta) Opus", LABEL),
      `Claude (beta) Opus (acct: ${LABEL})`,
    )
  })
})

describe("placement", () => {
  it("defaults to both, satisfying either reading of the request", () => {
    assert.equal(DEFAULT_PLACEMENT, "both")
    assert.ok(shouldDecorateProvider("both"))
    assert.ok(shouldDecorateModel("both"))
  })

  it("provider-only touches the provider", () => {
    assert.ok(shouldDecorateProvider("provider"))
    assert.ok(!shouldDecorateModel("provider"))
  })

  it("model-only touches models", () => {
    assert.ok(!shouldDecorateProvider("model"))
    assert.ok(shouldDecorateModel("model"))
  })

  it("off touches neither", () => {
    assert.ok(!shouldDecorateProvider("off"))
    assert.ok(!shouldDecorateModel("off"))
  })

  it("validates config input", () => {
    for (const v of ["provider", "model", "both", "off"]) {
      assert.ok(isAccountLabelPlacement(v))
    }
    for (const v of ["Provider", "", "yes", null, undefined, 1, {}]) {
      assert.ok(!isAccountLabelPlacement(v))
    }
  })
})

describe("applyAccountLabelToConfig", () => {
  const LBL = "Claude Team - Jack Test"

  it("names the provider even when config has no provider section", () => {
    const cfg: Record<string, unknown> = {}
    const r = applyAccountLabelToConfig(cfg, LBL)
    const p = (cfg.provider as Record<string, Record<string, unknown>>)
      .anthropic
    assert.equal(p.name, `Anthropic (acct: ${LBL})`)
    assert.equal(r.provider, true)
  })

  it("preserves an existing provider name as the base", () => {
    const cfg = { provider: { anthropic: { name: "Claude (work)" } } }
    applyAccountLabelToConfig(cfg, LBL)
    assert.equal(cfg.provider.anthropic.name, `Claude (work) (acct: ${LBL})`)
  })

  it("leaves unrelated provider config untouched", () => {
    const cfg = {
      provider: {
        anthropic: { options: { baseURL: "https://x" } },
        openai: { name: "OpenAI" },
      },
    } as Record<string, Record<string, Record<string, unknown>>>
    applyAccountLabelToConfig(cfg, LBL)
    assert.deepEqual(cfg.provider.anthropic.options, { baseURL: "https://x" })
    assert.equal(cfg.provider.openai.name, "OpenAI")
  })

  it("renames declared models", () => {
    const cfg = {
      provider: {
        anthropic: {
          models: { "claude-opus-4-5": { name: "Claude Opus 4.5" } },
        },
      },
    } as Record<
      string,
      Record<string, Record<string, Record<string, { name: string }>>>
    >
    const r = applyAccountLabelToConfig(cfg, LBL, "both")
    assert.equal(
      cfg.provider.anthropic.models["claude-opus-4-5"].name,
      `Claude Opus 4.5 (acct: ${LBL})`,
    )
    assert.equal(r.models, 1)
  })

  it("does not invent model entries the account may not have", () => {
    const cfg: Record<string, unknown> = {}
    const r = applyAccountLabelToConfig(cfg, LBL, "model")
    const p = (cfg.provider as Record<string, Record<string, unknown>>)
      .anthropic
    assert.equal(r.models, 0)
    assert.equal(p.models, undefined)
  })

  it("is idempotent across repeated config loads", () => {
    const cfg: Record<string, unknown> = {}
    applyAccountLabelToConfig(cfg, LBL)
    applyAccountLabelToConfig(cfg, LBL)
    const second = applyAccountLabelToConfig(cfg, LBL)
    const p = (cfg.provider as Record<string, Record<string, unknown>>)
      .anthropic
    assert.equal(p.name, `Anthropic (acct: ${LBL})`)
    assert.equal(second.provider, false)
  })

  it("replaces the label after switching accounts", () => {
    const cfg: Record<string, unknown> = {}
    applyAccountLabelToConfig(cfg, "Claude Pro - Old")
    applyAccountLabelToConfig(cfg, LBL)
    const p = (cfg.provider as Record<string, Record<string, unknown>>)
      .anthropic
    assert.equal(p.name, `Anthropic (acct: ${LBL})`)
  })

  it("off and empty labels write nothing at all", () => {
    for (const [label, placement] of [
      [LBL, "off"],
      ["", "both"],
    ] as const) {
      const cfg: Record<string, unknown> = {}
      const r = applyAccountLabelToConfig(cfg, label, placement)
      assert.deepEqual(r, { provider: false, models: 0 })
      assert.equal(cfg.provider, undefined)
    }
  })

  it("tolerates a non-object config", () => {
    for (const bad of [null, undefined, 42, "x"]) {
      assert.doesNotThrow(() => applyAccountLabelToConfig(bad, LBL))
    }
  })

  it("honours a non-default provider id", () => {
    const cfg: Record<string, unknown> = {}
    applyAccountLabelToConfig(cfg, LBL, "provider", "anthropic-vertex")
    const ps = cfg.provider as Record<string, Record<string, unknown>>
    assert.ok(ps["anthropic-vertex"].name)
    assert.equal(ps.anthropic, undefined)
  })
})
