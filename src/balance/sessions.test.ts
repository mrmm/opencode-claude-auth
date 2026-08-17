import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import { DEFAULT_CONFIG, type ClaudeAuthConfig } from "../config.ts"
import type { AccountQuota, QuotaCache } from "./quota.ts"
import { resetCursors, resetEjections, type Member } from "./balancer.ts"
import {
  SESSION_HEADER,
  bindSession,
  boundSource,
  forgetSession,
  listBindings,
  resetBindings,
  resolveForSession,
} from "./sessions.ts"

const NOW = 1785162626000
const SEC = Math.floor(NOW / 1000)

const reading = (u: number): AccountQuota => ({
  fiveHour: { utilization: u, resetsAt: SEC + 3600 },
  representative: "five_hour",
  observedAt: SEC,
})

const members = (...s: string[]): Member[] =>
  s.map((x) => ({ source: x, label: x, credential: "ok" as const }))

const cfg = (o: Partial<ClaudeAuthConfig> = {}): ClaudeAuthConfig => ({
  ...DEFAULT_CONFIG,
  ...o,
})

beforeEach(() => {
  resetBindings()
  resetCursors()
  resetEjections()
})

describe("session bindings", () => {
  it("keeps a session on its account across requests", () => {
    const cache: QuotaCache = { a: reading(0.1), b: reading(0.1) }
    const first = resolveForSession("s1", members("a", "b"), cache, cfg(), NOW)
    const second = resolveForSession("s1", members("a", "b"), cache, cfg(), NOW)
    assert.equal(second!.source, first!.source)
    assert.equal(second!.changed, false)
    assert.equal(second!.reason, "already bound")
  })

  it("gives two sessions different accounts under round-robin", () => {
    // The point of the feature: parallel subagents arrive as separate sessions.
    const cache: QuotaCache = { a: reading(0.1), b: reading(0.1) }
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b"] })
    const s1 = resolveForSession("s1", members("a", "b"), cache, c, NOW)
    const s2 = resolveForSession("s2", members("a", "b"), cache, c, NOW)
    assert.notEqual(s1!.source, s2!.source)
  })

  it("moves only the session whose account is spent", () => {
    const healthy: QuotaCache = { a: reading(0.1), b: reading(0.1) }
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b"] })
    const s1 = resolveForSession("s1", members("a", "b"), healthy, c, NOW)!
    const s2 = resolveForSession("s2", members("a", "b"), healthy, c, NOW)!

    // Spend whatever s1 landed on; s2 must not be disturbed.
    const spent: QuotaCache = { ...healthy, [s1.source]: reading(1) }
    const s1b = resolveForSession("s1", members("a", "b"), spent, c, NOW)!
    const s2b = resolveForSession("s2", members("a", "b"), spent, c, NOW)!
    assert.notEqual(s1b.source, s1.source, "s1 should have moved")
    assert.equal(s2b.source, s2.source, "s2 should be untouched")
  })

  it("rebinds when the bound account becomes unusable", () => {
    const cache: QuotaCache = { a: reading(0.1), b: reading(0.1) }
    bindSession("s1", "a", NOW)
    const spent: QuotaCache = { ...cache, a: reading(1) }
    const d = resolveForSession("s1", members("a", "b"), spent, cfg(), NOW)!
    assert.equal(d.source, "b")
    assert.equal(d.changed, true)
    assert.match(d.reason, /rebound/)
  })

  it("forgets a session on request", () => {
    bindSession("s1", "a", NOW)
    assert.equal(boundSource("s1"), "a")
    forgetSession("s1")
    assert.equal(boundSource("s1"), undefined)
  })

  it("sweeps a session idle for over an hour", () => {
    bindSession("old", "a", NOW)
    bindSession("new", "b", NOW + 2 * 60 * 60_000)
    assert.equal(boundSource("old"), undefined)
    assert.equal(boundSource("new"), "b")
  })

  it("reports its bindings", () => {
    bindSession("s1", "a", NOW)
    assert.deepEqual(listBindings(), [{ sessionId: "s1", source: "a" }])
  })

  it("returns nothing when there are no accounts", () => {
    assert.equal(resolveForSession("s1", [], {}, cfg(), NOW), undefined)
  })

  it("uses a header name that cannot collide with Anthropic's", () => {
    assert.match(SESSION_HEADER, /^x-claude-auth-/)
  })
})
