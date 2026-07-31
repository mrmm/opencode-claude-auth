import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  acquireRefreshLock,
  isStale,
  lockPathFor,
  LOCK_STALE_MS,
  readLock,
} from "./refresh-lock.ts"

const dir = () => mkdtempSync(join(tmpdir(), "cauth-lock-"))
const releases: Array<() => void> = []

afterEach(() => {
  while (releases.length) releases.pop()?.()
})

function take(source: string, d: string, opts = {}) {
  const r = acquireRefreshLock(source, { dir: d, ...opts })
  if (r) releases.push(r)
  return r
}

describe("lock path", () => {
  it("gives each account its own lock, so accounts never block each other", () => {
    const d = dir()
    assert.notEqual(
      lockPathFor("Claude Code-credentials-780bcd9b", d),
      lockPathFor("Claude Code-credentials-04bd82dd", d),
    )
  })

  it("sanitises the service name into a filename", () => {
    const p = lockPathFor("Claude Code-credentials/../evil", dir())
    assert.ok(!p.includes("/../"), p)
  })
})

describe("acquire", () => {
  it("succeeds when nothing holds the lock", () => {
    assert.ok(take("acct", dir()))
  })

  it("refuses a second holder while a live process owns it", () => {
    const d = dir()
    // A different, definitely-alive pid.
    writeFileSync(
      lockPathFor("acct", d),
      JSON.stringify({ pid: 999_999, at: Date.now() }),
    )
    assert.equal(take("acct", d, { alive: () => true }), null)
  })

  it("breaks a lock whose owner is gone, so a crash cannot wedge auth", () => {
    const d = dir()
    writeFileSync(
      lockPathFor("acct", d),
      JSON.stringify({ pid: 999_999, at: Date.now() }),
    )
    assert.ok(take("acct", d, { alive: () => false }))
  })

  it("breaks a lock that is simply too old", () => {
    const d = dir()
    writeFileSync(
      lockPathFor("acct", d),
      JSON.stringify({ pid: 999_999, at: Date.now() - LOCK_STALE_MS - 1000 }),
    )
    assert.ok(take("acct", d, { alive: () => true }))
  })

  it("records the owning pid", () => {
    const d = dir()
    take("acct", d)
    assert.equal(readLock(lockPathFor("acct", d))?.pid, process.pid)
  })

  it("release removes the lock so the next process can proceed", () => {
    const d = dir()
    const release = acquireRefreshLock("acct", { dir: d })
    assert.ok(release)
    release?.()
    assert.equal(existsSync(lockPathFor("acct", d)), false)
    assert.ok(take("acct", d, { alive: () => true }))
  })

  it("does not remove a lock taken over by someone else", () => {
    const d = dir()
    const release = acquireRefreshLock("acct", { dir: d })
    // Another process replaced it after we timed out.
    writeFileSync(
      lockPathFor("acct", d),
      JSON.stringify({ pid: 999_999, at: Date.now() }),
    )
    release?.()
    assert.equal(readLock(lockPathFor("acct", d))?.pid, 999_999)
  })

  it("proceeds rather than blocking when the lock cannot be written", () => {
    // Refusing to refresh because a lock file failed would be worse than
    // refreshing without coordination.
    assert.ok(acquireRefreshLock("acct", { dir: "/proc/nope/locks" }))
  })
})

describe("staleness", () => {
  it("treats a missing or malformed lock as free", () => {
    assert.equal(isStale(null), true)
    const d = dir()
    writeFileSync(lockPathFor("acct", d), "not json")
    assert.equal(readLock(lockPathFor("acct", d)), null)
  })

  it("treats our own pid as stale — a previous attempt did not clean up", () => {
    assert.equal(isStale({ pid: process.pid, at: Date.now() }), true)
  })

  it("respects a fresh lock from a live foreign process", () => {
    assert.equal(
      isStale({ pid: 999_999, at: Date.now() }, Date.now(), () => true),
      false,
    )
  })
})
