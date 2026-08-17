import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { classifySelection, parseWindowMs } from "./tools-format.ts"

describe("classifySelection", () => {
  it("reads the three things the selection file can hold", () => {
    assert.deepEqual(classifySelection(null, []), { kind: "none" })
    assert.deepEqual(classifySelection("__auto__", []), { kind: "auto" })
    assert.deepEqual(classifySelection("Claude Code-credentials-abc", []), {
      kind: "pin",
      source: "Claude Code-credentials-abc",
    })
  })

  it("flags a preset that is selected but not defined", () => {
    // A typo must be reported, not silently treated as a pin.
    assert.deepEqual(classifySelection("preset:typo", ["rr-12"]), {
      kind: "preset",
      name: "typo",
      known: false,
    })
    assert.deepEqual(classifySelection("preset:rr-12", ["rr-12"]), {
      kind: "preset",
      name: "rr-12",
      known: true,
    })
  })

  it("treats an empty string as nothing selected", () => {
    assert.deepEqual(classifySelection("", ["rr-12"]), { kind: "none" })
  })
})

describe("parseWindowMs", () => {
  it("parses each unit", () => {
    assert.equal(parseWindowMs("30s"), 30_000)
    assert.equal(parseWindowMs("15m"), 900_000)
    assert.equal(parseWindowMs("2h"), 7_200_000)
    assert.equal(parseWindowMs("7d"), 604_800_000)
  })

  it("falls back rather than throwing on nonsense", () => {
    // A model may pass anything; a bad window should still produce a report.
    assert.equal(parseWindowMs("yesterday"), parseWindowMs("24h"))
    assert.equal(parseWindowMs(undefined), parseWindowMs("24h"))
    assert.equal(parseWindowMs(""), parseWindowMs("24h"))
  })
})
