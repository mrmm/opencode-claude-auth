import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import { DEFAULT_CONFIG, type ClaudeAuthConfig } from "./config.ts"
import type { AccountQuota, QuotaCache } from "./quota.ts"
import {
  assess,
  eject,
  clearEjection,
  ejectedUntil,
  resetCursors,
  resetEjections,
  resolvePools,
  selectAccount,
  type Member,
} from "./balancer.ts"

const NOW_MS = 1785162626000
const NOW_SEC = Math.floor(NOW_MS / 1000)

const members = (...sources: string[]): Member[] =>
  sources.map((s) => ({ source: s, label: s }))

/** A reading with the given 5h utilisation, observed now, resetting in an hour. */
function reading(
  utilization: number,
  opts: { status?: string; resetsIn?: number } = {},
): AccountQuota {
  return {
    fiveHour: {
      utilization,
      status: opts.status,
      resetsAt: NOW_SEC + (opts.resetsIn ?? 3600),
    },
    representative: "five_hour",
    observedAt: NOW_SEC,
  }
}

const cfg = (over: Partial<ClaudeAuthConfig> = {}): ClaudeAuthConfig => ({
  ...DEFAULT_CONFIG,
  ...over,
})

beforeEach(() => {
  resetEjections()
  resetCursors()
})

describe("assess", () => {
  it("calls an account under the threshold healthy", () => {
    const cache: QuotaCache = { a: reading(0.5) }
    const [h] = assess(members("a"), cache, cfg(), NOW_MS)
    assert.equal(h!.healthy, true)
    assert.equal(h!.utilization, 0.5)
  })

  it("calls an account at or above switchAt unhealthy", () => {
    const cache: QuotaCache = { a: reading(0.95) }
    const [h] = assess(members("a"), cache, cfg({ switchAt: 0.95 }), NOW_MS)
    assert.equal(h!.healthy, false)
    assert.match(h!.reason, /95%/)
  })

  it("treats a window past its reset as empty, not spent", () => {
    // The figure describes a window that no longer exists.
    const cache: QuotaCache = { a: reading(1.0, { resetsIn: -60 }) }
    const [h] = assess(members("a"), cache, cfg(), NOW_MS)
    assert.equal(h!.healthy, true)
    assert.equal(h!.utilization, 0)
  })

  it("honours the server's own rejection", () => {
    const cache: QuotaCache = { a: reading(0.4, { status: "rejected" }) }
    const [h] = assess(members("a"), cache, cfg(), NOW_MS)
    assert.equal(h!.healthy, false)
    assert.equal(h!.reason, "server rejected")
  })

  it("assumes an unmeasured account is usable", () => {
    const [h] = assess(members("a"), {}, cfg(), NOW_MS)
    assert.equal(h!.healthy, true)
    assert.equal(h!.utilization, undefined)
  })

  it("respects an active ejection", () => {
    eject("a", cfg(), NOW_MS)
    const [h] = assess(members("a"), { a: reading(0.1) }, cfg(), NOW_MS)
    assert.equal(h!.healthy, false)
    assert.match(h!.reason, /ejected/)
  })

  it("reads the weekly window when told to", () => {
    const cache: QuotaCache = {
      a: {
        fiveHour: { utilization: 0.1, resetsAt: NOW_SEC + 3600 },
        sevenDay: { utilization: 0.99, resetsAt: NOW_SEC + 86400 },
        observedAt: NOW_SEC,
      },
    }
    const on5h = assess(
      members("a"),
      cache,
      cfg({ switchWindow: "5h" }),
      NOW_MS,
    )
    const on7d = assess(
      members("a"),
      cache,
      cfg({ switchWindow: "7d" }),
      NOW_MS,
    )
    assert.equal(on5h[0]!.healthy, true)
    assert.equal(on7d[0]!.healthy, false)
  })
})

describe("credential health", () => {
  it("refuses an account that cannot authenticate, however much headroom it has", () => {
    const cache: QuotaCache = { a: reading(0.0) }
    const [h] = assess(
      [{ source: "a", credential: "unusable" }],
      cache,
      cfg(),
      NOW_MS,
    )
    assert.equal(h!.healthy, false)
    assert.match(h!.reason, /cannot be refreshed/)
  })

  it("treats a refreshable account as usable", () => {
    const [h] = assess(
      [{ source: "a", credential: "refreshable" }],
      { a: reading(0.1) },
      cfg(),
      NOW_MS,
    )
    assert.equal(h!.healthy, true)
  })

  it("prefers a ready credential over an emptier one that needs refreshing", () => {
    const pair: Member[] = [
      { source: "ready", credential: "ok" },
      { source: "stale", credential: "refreshable" },
    ]
    const cache: QuotaCache = { ready: reading(0.8), stale: reading(0.0) }
    const d = selectAccount(
      pair,
      cache,
      cfg({ strategy: "least-loaded" }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "ready")
  })

  it("still uses a refreshable account when it is the only one left", () => {
    const pair: Member[] = [
      { source: "spent", credential: "ok" },
      { source: "stale", credential: "refreshable" },
    ]
    const cache: QuotaCache = { spent: reading(1.0), stale: reading(0.5) }
    const d = selectAccount(pair, cache, cfg(), "spent", NOW_MS)
    assert.equal(d!.source, "stale")
  })

  it("defaults a member with no stated credential to usable", () => {
    const [h] = assess(members("a"), { a: reading(0.1) }, cfg(), NOW_MS)
    assert.equal(h!.credential, "ok")
    assert.equal(h!.healthy, true)
  })
})

describe("ejection", () => {
  it("backs off multiplicatively and forgets once served", () => {
    const c = cfg({ ejectFor: 1000 })
    const first = eject("a", c, NOW_MS)
    assert.equal(first.until, NOW_MS + 1000)
    const second = eject("a", c, NOW_MS)
    assert.equal(second.until, NOW_MS + 2000)

    clearEjection("a")
    assert.equal(ejectedUntil("a", NOW_MS), undefined)
    // The count resets with the entry, so recovery is complete.
    assert.equal(eject("a", c, NOW_MS).until, NOW_MS + 1000)
  })

  it("expires on its own", () => {
    eject("a", cfg({ ejectFor: 1000 }), NOW_MS)
    assert.equal(ejectedUntil("a", NOW_MS + 1001), undefined)
  })
})

describe("resolvePools", () => {
  it("collapses to one implicit pool of every account", () => {
    const pools = resolvePools(members("a", "b"), cfg())
    assert.equal(pools.length, 1)
    assert.deepEqual(pools[0]!.accounts, ["a", "b"])
  })

  it("uses flat accounts as the implicit pool, in order", () => {
    const pools = resolvePools(
      members("a", "b", "c"),
      cfg({ accounts: ["c", "a"] }),
    )
    assert.deepEqual(pools[0]!.accounts, ["c", "a"])
  })

  it("drops configured accounts that no longer exist", () => {
    const pools = resolvePools(
      members("a"),
      cfg({ pools: [{ name: "p", accounts: ["a", "ghost"] }] }),
    )
    assert.deepEqual(pools[0]!.accounts, ["a"])
  })

  it("drops a pool left empty by a stale config", () => {
    const pools = resolvePools(
      members("a"),
      cfg({
        pools: [
          { name: "dead", accounts: ["ghost"] },
          { name: "live", accounts: ["a"] },
        ],
      }),
    )
    assert.deepEqual(
      pools.map((p) => p.name),
      ["live"],
    )
  })
})

describe("strategies", () => {
  const cache: QuotaCache = {
    a: reading(0.8),
    b: reading(0.2),
    c: reading(0.5),
  }

  it("sticky keeps a healthy active account even when fuller", () => {
    const d = selectAccount(members("a", "b", "c"), cache, cfg(), "a", NOW_MS)
    assert.equal(d!.source, "a")
    assert.equal(d!.changed, false)
  })

  it("sticky moves to the emptiest once the active one is spent", () => {
    const spent: QuotaCache = { ...cache, a: reading(0.99) }
    const d = selectAccount(members("a", "b", "c"), spent, cfg(), "a", NOW_MS)
    assert.equal(d!.source, "b")
    assert.equal(d!.changed, true)
  })

  it("least-loaded picks the most headroom regardless of who is active", () => {
    const d = selectAccount(
      members("a", "b", "c"),
      cache,
      cfg({ strategy: "least-loaded" }),
      "a",
      NOW_MS,
    )
    assert.equal(d!.source, "b")
  })

  it("least-loaded ranks an unmeasured account behind a measured one", () => {
    const d = selectAccount(
      members("a", "unknown"),
      { a: reading(0.8) },
      cfg({ strategy: "least-loaded" }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "a")
  })

  it("priority follows config order, not headroom", () => {
    const d = selectAccount(
      members("a", "b", "c"),
      cache,
      cfg({ strategy: "priority", accounts: ["c", "b", "a"] }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "c")
  })

  it("round-robin rotates across successive decisions", () => {
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b", "c"] })
    const picks = [0, 1, 2, 3].map(
      () =>
        selectAccount(members("a", "b", "c"), cache, c, null, NOW_MS)!.source,
    )
    assert.deepEqual(picks, ["a", "b", "c", "a"])
  })

  it("round-robin skips a spent member", () => {
    const spent: QuotaCache = { ...cache, b: reading(1.0) }
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b", "c"] })
    const picks = [0, 1, 2].map(
      () =>
        selectAccount(members("a", "b", "c"), spent, c, null, NOW_MS)!.source,
    )
    assert.deepEqual(picks, ["a", "c", "a"])
  })

  it("weighted interleaves a 2:1 split rather than bursting", () => {
    const c = cfg({
      strategy: "weighted",
      pools: [{ name: "p", accounts: ["a", "b"], weights: { a: 2, b: 1 } }],
    })
    const picks = [0, 1, 2].map(
      () => selectAccount(members("a", "b"), cache, c, null, NOW_MS)!.source,
    )
    // Smooth weighted round-robin: a, then b, then a — not a, a, b.
    assert.deepEqual(picks, ["a", "b", "a"])
    assert.equal(picks.filter((p) => p === "a").length, 2)
  })
})

describe("tiered failover", () => {
  const pools = [
    { name: "primary", accounts: ["a", "b"] },
    { name: "fallback", accounts: ["z"] },
  ]

  it("stays in the primary tier while it has room", () => {
    const cache: QuotaCache = {
      a: reading(0.5),
      b: reading(0.6),
      z: reading(0.0),
    }
    const d = selectAccount(
      members("a", "b", "z"),
      cache,
      cfg({ pools }),
      null,
      NOW_MS,
    )
    assert.equal(d!.pool, "primary")
  })

  it("reaches the fallback only when the primary is fully spent", () => {
    const cache: QuotaCache = {
      a: reading(1.0),
      b: reading(1.0),
      z: reading(0.1),
    }
    const d = selectAccount(
      members("a", "b", "z"),
      cache,
      cfg({ pools }),
      null,
      NOW_MS,
    )
    assert.equal(d!.pool, "fallback")
    assert.equal(d!.source, "z")
  })

  it("when everything is spent, picks whoever resets soonest and says so", () => {
    const cache: QuotaCache = {
      a: reading(1.0, { resetsIn: 7200 }),
      b: reading(1.0, { resetsIn: 600 }),
      z: reading(1.0, { resetsIn: 3600 }),
    }
    const d = selectAccount(
      members("a", "b", "z"),
      cache,
      cfg({ pools }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "b")
    assert.equal(d!.pool, "exhausted")
    assert.match(d!.reason, /all accounts spent/)
  })

  it("returns nothing when there are no accounts at all", () => {
    assert.equal(selectAccount([], {}, cfg(), null, NOW_MS), undefined)
  })
})
