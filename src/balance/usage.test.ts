import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type UsageEvent,
  readUsage,
  record,
  recordRequest,
  summarize,
  usageIndex,
} from "./usage.ts"

const T0 = 1785000000000

const req = (
  account: string,
  over: Partial<Extract<UsageEvent, { kind: "request" }>> = {},
): UsageEvent => ({
  kind: "request",
  timestamp: new Date(T0).toISOString(),
  created_at: T0,
  account,
  model: "claude-haiku-4-5",
  status: 200,
  duration_ms: 1000,
  ...over,
})

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "usage-")), "usage.jsonl")
}

describe("record + readUsage", () => {
  it("round-trips events through the file", () => {
    const path = tmpFile()
    record(req("a"), path)
    recordRequest(
      { account: "b", model: "m", status: 200, duration_ms: 5 },
      path,
    )
    const back = readUsage(0, path)
    assert.equal(back.length, 2)
    assert.equal(back[0]!.kind, "request")
  })

  it("survives a truncated final line from a crashed append", () => {
    const path = tmpFile()
    record(req("a"), path)
    writeFileSync(path, `${readFileSync(path, "utf-8")}{"kind":"request","crea`)
    const back = readUsage(0, path)
    assert.equal(back.length, 1)
  })

  it("filters by time", () => {
    const path = tmpFile()
    record(req("old", { created_at: T0 - 10_000 }), path)
    record(req("new", { created_at: T0 }), path)
    const back = readUsage(T0 - 1000, path)
    assert.deepEqual(
      back.map((e) => (e.kind === "request" ? e.account : "")),
      ["new"],
    )
  })

  it("never throws on an unwritable path", () => {
    assert.doesNotThrow(() => record(req("a"), "/proc/nope/usage.jsonl"))
  })
})

describe("summarize", () => {
  it("counts requests, refusals and other errors apart", () => {
    const s = summarize([
      req("a"),
      req("a", { status: 429 }),
      req("a", { status: 500 }),
      req("b"),
    ])
    const a = s.accounts.find((x) => x.account === "a")!
    assert.equal(a.requests, 3)
    assert.equal(a.refusals, 1)
    assert.equal(a.errors, 1)
    assert.equal(s.accounts[0]!.account, "a", "busiest account sorts first")
  })

  it("averages duration over successful requests only", () => {
    // A refusal returns fast and would flatter the average.
    const s = summarize([
      req("a", { duration_ms: 1000 }),
      req("a", { duration_ms: 3000 }),
      req("a", { status: 429, duration_ms: 1 }),
    ])
    assert.equal(s.accounts[0]!.avg_duration_ms, 2000)
  })

  it("keeps the newest utilisation rather than averaging readings", () => {
    const s = summarize([
      req("a", { created_at: T0, utilization_5h: 0.2 }),
      req("a", { created_at: T0 + 5000, utilization_5h: 0.9 }),
    ])
    assert.equal(s.accounts[0]!.utilization_5h, 0.9)
    assert.equal(s.accounts[0]!.last_used_at, T0 + 5000)
  })

  it("counts rotations by trigger", () => {
    const s = summarize([
      req("a"),
      {
        kind: "rotation",
        timestamp: new Date(T0).toISOString(),
        created_at: T0,
        from_account: "a",
        to_account: "b",
        trigger: "429",
        strategy: "sticky",
        pool: "default",
      },
      {
        kind: "rotation",
        timestamp: new Date(T0).toISOString(),
        created_at: T0,
        from_account: "b",
        to_account: "a",
        trigger: "quota-observed",
        strategy: "sticky",
        pool: "default",
      },
    ])
    assert.equal(s.rotations, 2)
    assert.deepEqual(s.by_trigger, { "429": 1, "quota-observed": 1 })
  })

  it("reduces to the index the balancer consumes", () => {
    const idx = usageIndex(summarize([req("a"), req("a"), req("b")]))
    assert.equal(idx["a"]!.requests, 2)
    assert.equal(idx["b"]!.requests, 1)
  })
})
