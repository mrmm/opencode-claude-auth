import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  bindingWindow,
  buildProbeRequest,
  PROBE_MODEL,
  refreshQuotas,
  formatDuration,
  formatQuotaPrefix,
  parseQuotaHeaders,
  quotaForAccount,
  readQuotaCache,
  writeQuotaForAccount,
  type AccountQuota,
} from "./quota.ts"

/**
 * Verbatim headers from a real 429 on this machine, so the parser is pinned to
 * the actual wire format rather than an assumed one.
 */
const REAL_HEADERS = {
  "anthropic-ratelimit-unified-5h-reset": "1785167400",
  "anthropic-ratelimit-unified-5h-status": "rejected",
  "anthropic-ratelimit-unified-5h-surpassed-threshold": "1.0",
  "anthropic-ratelimit-unified-5h-utilization": "1.0",
  "anthropic-ratelimit-unified-7d-reset": "1785211200",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
  "anthropic-ratelimit-unified-7d-utilization": "0.92",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "retry-after": "4774",
}

const OBSERVED = 1785162626

describe("parseQuotaHeaders", () => {
  it("reads both windows from real headers", () => {
    const q = parseQuotaHeaders(REAL_HEADERS, OBSERVED)
    assert.ok(q)
    assert.equal(q.fiveHour?.utilization, 1)
    assert.equal(q.fiveHour?.resetsAt, 1785167400)
    assert.equal(q.fiveHour?.status, "rejected")
    assert.equal(q.sevenDay?.utilization, 0.92)
    assert.equal(q.sevenDay?.resetsAt, 1785211200)
    assert.equal(q.representative, "five_hour")
    assert.equal(q.observedAt, OBSERVED)
  })

  it("works with a Headers instance, not just a plain object", () => {
    const h = new Headers(REAL_HEADERS)
    const q = parseQuotaHeaders(h, OBSERVED)
    assert.equal(q?.fiveHour?.utilization, 1)
    assert.equal(q?.sevenDay?.utilization, 0.92)
  })

  it("is case-insensitive for plain objects", () => {
    const q = parseQuotaHeaders(
      { "Anthropic-RateLimit-Unified-5h-Utilization": "0.5" },
      OBSERVED,
    )
    assert.equal(q?.fiveHour?.utilization, 0.5)
  })

  it("returns undefined when no quota headers are present", () => {
    assert.equal(
      parseQuotaHeaders({ "content-type": "application/json" }),
      undefined,
    )
    assert.equal(parseQuotaHeaders({}), undefined)
  })

  it("tolerates a window with utilisation but no reset", () => {
    const q = parseQuotaHeaders(
      { "anthropic-ratelimit-unified-5h-utilization": "0.3" },
      OBSERVED,
    )
    assert.equal(q?.fiveHour?.utilization, 0.3)
    assert.equal(q?.fiveHour?.resetsAt, undefined)
  })

  it("ignores an unparseable utilisation rather than reporting 0%", () => {
    // Reporting 0% for a garbled value would read as "plenty left".
    assert.equal(
      parseQuotaHeaders({
        "anthropic-ratelimit-unified-5h-utilization": "n/a",
      }),
      undefined,
    )
  })

  it("survives a null-ish header bag", () => {
    assert.doesNotThrow(() => parseQuotaHeaders({} as never))
    assert.equal(parseQuotaHeaders(undefined as never), undefined)
  })
})

describe("formatDuration", () => {
  it("formats each magnitude compactly", () => {
    assert.equal(formatDuration(45), "45s")
    assert.equal(formatDuration(12 * 60), "12m")
    assert.equal(formatDuration(80 * 60), "1h20m")
    assert.equal(formatDuration(2 * 3600), "2h")
    assert.equal(formatDuration(51 * 3600), "2d3h")
    assert.equal(formatDuration(48 * 3600), "2d")
  })

  it("pads minutes so widths line up in a list", () => {
    assert.equal(formatDuration(65 * 60), "1h05m")
  })

  it("treats past and nonsense as now", () => {
    assert.equal(formatDuration(0), "now")
    assert.equal(formatDuration(-10), "now")
    assert.equal(formatDuration(Number.NaN), "now")
  })
})

describe("bindingWindow", () => {
  const five = { utilization: 0.4 }
  const seven = { utilization: 0.9 }

  it("honours the server's representative claim", () => {
    assert.equal(
      bindingWindow({
        fiveHour: five,
        sevenDay: seven,
        representative: "five_hour",
        observedAt: 0,
      }),
      five,
    )
    assert.equal(
      bindingWindow({
        fiveHour: five,
        sevenDay: seven,
        representative: "seven_day",
        observedAt: 0,
      }),
      seven,
    )
  })

  it("falls back to whichever window is fuller", () => {
    assert.equal(
      bindingWindow({ fiveHour: five, sevenDay: seven, observedAt: 0 }),
      seven,
    )
    assert.equal(
      bindingWindow({ fiveHour: seven, sevenDay: five, observedAt: 0 }),
      seven,
    )
  })

  it("copes with only one window", () => {
    assert.equal(bindingWindow({ fiveHour: five, observedAt: 0 }), five)
    assert.equal(bindingWindow({ sevenDay: seven, observedAt: 0 }), seven)
    assert.equal(bindingWindow({ observedAt: 0 }), undefined)
  })
})

describe("formatQuotaPrefix", () => {
  it("renders the real exhausted account", () => {
    const q = parseQuotaHeaders(REAL_HEADERS, OBSERVED)
    // 1785167400 - 1785162626 = 4774s = 1h19m
    assert.equal(formatQuotaPrefix(q, OBSERVED), "[100% 1h19m]")
  })

  it("renders a healthy account", () => {
    const q = parseQuotaHeaders(
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.22",
        "anthropic-ratelimit-unified-5h-reset": String(OBSERVED + 2 * 3600),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
      OBSERVED,
    )
    assert.equal(formatQuotaPrefix(q, OBSERVED), "[22% 2h]")
  })

  it("reports 0% once the window has reset rather than a stale figure", () => {
    const q = parseQuotaHeaders(REAL_HEADERS, OBSERVED)
    // Well past the 5h reset: the old 100% would be actively misleading.
    assert.equal(formatQuotaPrefix(q, 1785167400 + 60), "[0%]")
  })

  it("omits the timer when no reset is known", () => {
    const q = parseQuotaHeaders(
      { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
      OBSERVED,
    )
    assert.equal(formatQuotaPrefix(q, OBSERVED), "[50%]")
  })

  it("returns an empty string when nothing is known, so rows stay clean", () => {
    assert.equal(formatQuotaPrefix(undefined), "")
    assert.equal(formatQuotaPrefix({ observedAt: 0 }), "")
  })

  it("clamps utilisation above 1 to 100%", () => {
    const q = parseQuotaHeaders(
      { "anthropic-ratelimit-unified-5h-utilization": "1.4" },
      OBSERVED,
    )
    assert.equal(formatQuotaPrefix(q, OBSERVED), "[100%]")
  })
})

describe("cache", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "quota-")), "q.json")

  it("round-trips an account", () => {
    const p = tmp()
    const q = parseQuotaHeaders(REAL_HEADERS, OBSERVED)!
    assert.equal(writeQuotaForAccount("Claude Code-credentials", q, p), true)
    assert.deepEqual(readQuotaCache(p)["Claude Code-credentials"], q)
  })

  it("keeps accounts independent", () => {
    const p = tmp()
    const a = parseQuotaHeaders(REAL_HEADERS, OBSERVED)!
    const b = parseQuotaHeaders(
      { "anthropic-ratelimit-unified-5h-utilization": "0.1" },
      OBSERVED,
    )!
    writeQuotaForAccount("acct-a", a, p)
    writeQuotaForAccount("acct-b", b, p)
    const cache = readQuotaCache(p)
    assert.equal(cache["acct-a"].fiveHour?.utilization, 1)
    assert.equal(cache["acct-b"].fiveHour?.utilization, 0.1)
  })

  it("treats a missing or corrupt file as no data", () => {
    assert.deepEqual(
      readQuotaCache(join(tmpdir(), "definitely-absent.json")),
      {},
    )
    const p = tmp()
    writeFileSync(p, "{ not json", "utf8")
    assert.deepEqual(readQuotaCache(p), {})
  })

  it("never throws when the path is unwritable", () => {
    const q = parseQuotaHeaders(REAL_HEADERS, OBSERVED)!
    assert.equal(writeQuotaForAccount("x", q, "/proc/nope/q.json"), false)
  })

  it("expires stale entries", () => {
    const cache = { a: parseQuotaHeaders(REAL_HEADERS, OBSERVED)! }
    assert.ok(quotaForAccount("a", cache, OBSERVED + 60))
    assert.equal(quotaForAccount("a", cache, OBSERVED + 13 * 3600), undefined)
  })

  it("ignores entries without a timestamp", () => {
    assert.equal(
      quotaForAccount("a", {
        a: { fiveHour: { utilization: 1 } } as AccountQuota,
      }),
      undefined,
    )
    assert.equal(quotaForAccount("missing", {}), undefined)
  })
})

describe("refreshQuotas", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "quota-probe-")), "q.json")
  const acct = (n: string) => ({ source: n, accessToken: `tok-${n}` })

  function fakeFetch(headersBySeq: Array<Record<string, string> | null>) {
    let i = 0
    const calls: string[] = []
    const fn = async (url: string, init?: RequestInit) => {
      const h = headersBySeq[i++] ?? null
      const auth = (init?.headers as Record<string, string>)?.authorization
      calls.push(auth ?? "none")
      return { headers: new Headers(h ?? {}) } as unknown as Response
    }
    return { fn: fn as unknown as typeof fetch, calls }
  }

  it("probes each account and caches what it learns", async () => {
    const p = tmp()
    const { fn, calls } = fakeFetch([
      { "anthropic-ratelimit-unified-5h-utilization": "1.0" },
      { "anthropic-ratelimit-unified-5h-utilization": "0.34" },
    ])
    const r = await refreshQuotas([acct("a"), acct("b")], {
      fetchImpl: fn,
      path: p,
    })

    assert.deepEqual(r, { probed: 2, skipped: 0, failed: 0 })
    const cache = readQuotaCache(p)
    assert.equal(cache.a.fiveHour?.utilization, 1)
    assert.equal(cache.b.fiveHour?.utilization, 0.34)
    // Each probe must use its own account's token.
    assert.deepEqual(calls, ["Bearer tok-a", "Bearer tok-b"])
  })

  it("skips accounts that already have a fresh reading", async () => {
    const p = tmp()
    writeQuotaForAccount("a", parseQuotaHeaders(REAL_HEADERS, OBSERVED)!, p)
    const { fn, calls } = fakeFetch([
      { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
    ])
    const r = await refreshQuotas([acct("a"), acct("b")], {
      fetchImpl: fn,
      path: p,
      now: () => OBSERVED + 60,
    })

    assert.equal(r.skipped, 1)
    assert.equal(r.probed, 1)
    assert.equal(calls.length, 1, "the fresh account must not be probed")
  })

  it("re-probes once a reading goes stale", async () => {
    const p = tmp()
    writeQuotaForAccount("a", parseQuotaHeaders(REAL_HEADERS, OBSERVED)!, p)
    const { fn } = fakeFetch([
      { "anthropic-ratelimit-unified-5h-utilization": "0.5" },
    ])
    const r = await refreshQuotas([acct("a")], {
      fetchImpl: fn,
      path: p,
      now: () => OBSERVED + 3600,
    })
    assert.equal(r.probed, 1)
  })

  it("counts a response without quota headers as failed, not probed", async () => {
    // What an expired token (401) looks like.
    const p = tmp()
    const { fn } = fakeFetch([null])
    const r = await refreshQuotas([acct("a")], { fetchImpl: fn, path: p })
    assert.deepEqual(r, { probed: 0, skipped: 0, failed: 1 })
    assert.deepEqual(readQuotaCache(p), {})
  })

  it("resolves rather than throwing when the network fails", async () => {
    const p = tmp()
    const boom = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const r = await refreshQuotas([acct("a")], { fetchImpl: boom, path: p })
    assert.deepEqual(r, { probed: 0, skipped: 0, failed: 1 })
  })

  it("ignores malformed account entries", async () => {
    const p = tmp()
    const { fn, calls } = fakeFetch([])
    const r = await refreshQuotas(
      [{ source: "", accessToken: "x" }, { source: "y" }] as never,
      { fetchImpl: fn, path: p },
    )
    assert.equal(r.failed, 2)
    assert.equal(calls.length, 0)
  })

  it("handles an empty or missing account list", async () => {
    const p = tmp()
    assert.deepEqual(await refreshQuotas([], { path: p }), {
      probed: 0,
      skipped: 0,
      failed: 0,
    })
    assert.deepEqual(await refreshQuotas(undefined as never, { path: p }), {
      probed: 0,
      skipped: 0,
      failed: 0,
    })
  })

  it("sends a single-token request so probing is not a real cost", () => {
    const [url, init] = buildProbeRequest("tok")
    assert.match(url, /api\.anthropic\.com\/v1\/messages$/)
    const body = JSON.parse(init.body as string)
    assert.equal(body.max_tokens, 1)
    assert.equal(body.model, PROBE_MODEL)
  })
})
