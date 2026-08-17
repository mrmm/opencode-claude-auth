import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import {
  type Notice,
  clearNoticeSink,
  emitNotice,
  setNoticeSink,
} from "./notify.ts"

const rotated: Notice = {
  kind: "account-rotated",
  fromSource: "a",
  toSource: "b",
  reason: "spent",
  pool: "default",
  strategy: "sticky",
}

afterEach(() => clearNoticeSink())

describe("notice sink", () => {
  it("delivers to the installed sink", () => {
    const seen: Notice[] = []
    setNoticeSink((n) => seen.push(n))
    emitNotice(rotated)
    assert.deepEqual(seen, [rotated])
  })

  it("is a no-op with no sink, rather than throwing", () => {
    // This runs on the credential path: a missing sink must not fail a request.
    assert.doesNotThrow(() => emitNotice(rotated))
  })

  it("swallows a throwing sink", () => {
    // Same reason — a broken notifier must not become a broken refresh.
    setNoticeSink(() => {
      throw new Error("boom")
    })
    assert.doesNotThrow(() => emitNotice(rotated))
  })

  it("stops delivering once cleared", () => {
    const seen: Notice[] = []
    setNoticeSink((n) => seen.push(n))
    clearNoticeSink()
    emitNotice(rotated)
    assert.equal(seen.length, 0)
  })

  it("replaces rather than stacks sinks", () => {
    const first: Notice[] = []
    const second: Notice[] = []
    setNoticeSink((n) => first.push(n))
    setNoticeSink((n) => second.push(n))
    emitNotice(rotated)
    assert.equal(first.length, 0)
    assert.equal(second.length, 1)
  })
})
