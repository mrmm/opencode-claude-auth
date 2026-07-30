import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  bestAlternative,
  noticeKey,
  noticeToToast,
  buildAdvisory,
  shortenLabel,
  type AdvisoryAccount,
} from "./advisory.ts"
import type { AccountQuota, QuotaCache } from "./quota.ts"

const NOW = 1785162626

const ACCOUNTS: AdvisoryAccount[] = [
  { source: "s1", label: "Claude Team 1" },
  { source: "s3", label: "Claude Team - Team C" },
  { source: "s1w", label: "Claude Team - Team A" },
  { source: "s2", label: "Claude Team - Team B" },
]

function q(
  fiveUtil?: number,
  opts: { fiveReset?: number; weekUtil?: number; weekReset?: number } = {},
): AccountQuota {
  return {
    fiveHour:
      fiveUtil === undefined
        ? undefined
        : {
            utilization: fiveUtil,
            resetsAt: opts.fiveReset ?? NOW + 4774,
            status: fiveUtil >= 1 ? "rejected" : "allowed",
          },
    sevenDay:
      opts.weekUtil === undefined
        ? undefined
        : {
            utilization: opts.weekUtil,
            resetsAt: opts.weekReset ?? NOW + 48574,
          },
    representative: "five_hour",
    observedAt: NOW,
  }
}

describe("shortenLabel", () => {
  it("drops the shared plan prefix", () => {
    assert.equal(
      shortenLabel("Claude Team - Team A"),
      "Team A",
    )
    assert.equal(shortenLabel("Claude Max - Personal"), "Personal")
  })

  it("leaves labels without the prefix alone", () => {
    assert.equal(shortenLabel("Claude Team 1"), "Claude Team 1")
    assert.equal(shortenLabel("work"), "work")
  })

  it("never returns an empty string", () => {
    assert.equal(shortenLabel("Claude Team - "), "Claude Team - ")
  })
})

describe("bestAlternative", () => {
  const cache: QuotaCache = { s1w: q(1.0), s2: q(0.35), s3: q(1.0) }

  it("picks the account with the most room", () => {
    const alt = bestAlternative(ACCOUNTS, cache, "s1w", NOW)
    assert.equal(alt?.account.source, "s2")
    assert.equal(alt?.utilization, 0.35)
  })

  it("never suggests the account already in use", () => {
    const alt = bestAlternative(
      ACCOUNTS,
      { s1w: q(0.1), s2: q(0.9) },
      "s1w",
      NOW,
    )
    assert.equal(alt?.account.source, "s2")
  })

  it("ignores accounts with no reading rather than guessing", () => {
    // s1 has no entry at all.
    const alt = bestAlternative(ACCOUNTS, { s1w: q(1.0) }, "s1w", NOW)
    assert.equal(alt, undefined)
  })

  it("copes with an empty account list", () => {
    assert.equal(bestAlternative([], cache, "s1w", NOW), undefined)
    assert.equal(
      bestAlternative(undefined as never, cache, null, NOW),
      undefined,
    )
  })
})

describe("buildAdvisory", () => {
  it("reports the real situation: exhausted, with a healthy alternative", () => {
    const cache: QuotaCache = { s1w: q(1.0), s2: q(0.35), s3: q(1.0) }
    const a = buildAdvisory(ACCOUNTS, cache, "s1w", NOW)

    assert.equal(a?.variant, "error")
    assert.equal(a?.title, "Claude quota exhausted")
    assert.equal(
      a?.message,
      "Team A at 100% (resets in 1h19m). Team B is at 35%.",
    )
  })

  it("warns before exhaustion, without crying error", () => {
    const a = buildAdvisory(ACCOUNTS, { s1w: q(0.93) }, "s1w", NOW)
    assert.equal(a?.variant, "warning")
    assert.equal(a?.title, "Claude quota low")
    assert.match(a?.message ?? "", /at 93%/)
  })

  it("omits the suggestion when no alternative has real room", () => {
    const cache: QuotaCache = { s1w: q(1.0), s2: q(0.95) }
    const a = buildAdvisory(ACCOUNTS, cache, "s1w", NOW)
    assert.ok(!a?.message.includes("Team B"))
  })

  it("stays silent on a healthy account — no toast spam", () => {
    assert.equal(
      buildAdvisory(ACCOUNTS, { s1w: q(0.35) }, "s1w", NOW),
      undefined,
    )
  })

  it("surfaces weekly burn that the 5h figure hides", () => {
    // This is the real shape here: 5h fine, weekly at 92%.
    const cache: QuotaCache = { s1w: q(0.2, { weekUtil: 0.92 }) }
    const a = buildAdvisory(ACCOUNTS, cache, "s1w", NOW)
    assert.equal(a?.title, "Claude weekly quota high")
    assert.match(a?.message ?? "", /92% of the weekly limit/)
  })

  it("prefers the 5h warning when both windows are high", () => {
    const cache: QuotaCache = { s1w: q(1.0, { weekUtil: 0.92 }) }
    assert.equal(
      buildAdvisory(ACCOUNTS, cache, "s1w", NOW)?.title,
      "Claude quota exhausted",
    )
  })

  it("says nothing when the active account has no reading", () => {
    assert.equal(buildAdvisory(ACCOUNTS, {}, "s1w", NOW), undefined)
  })

  it("says nothing when there is no active account", () => {
    assert.equal(buildAdvisory(ACCOUNTS, { s1w: q(1.0) }, null, NOW), undefined)
  })

  it("ignores a stale reading rather than warning on old data", () => {
    const cache: QuotaCache = { s1w: q(1.0) }
    assert.equal(
      buildAdvisory(ACCOUNTS, cache, "s1w", NOW + 13 * 3600),
      undefined,
    )
  })

  it("handles a reset that has already passed", () => {
    const cache: QuotaCache = { s1w: q(1.0, { fiveReset: NOW - 10 }) }
    const a = buildAdvisory(ACCOUNTS, cache, "s1w", NOW)
    assert.match(a?.message ?? "", /resetting now/)
  })

  it("falls back to the source when the label is unknown", () => {
    const a = buildAdvisory([], { unknown: q(1.0) }, "unknown", NOW)
    assert.match(a?.message ?? "", /^unknown at 100%/)
  })
})

describe("refresh notices", () => {
  it("shows a failure, with the remedy", () => {
    const t = noticeToToast({
      kind: "refresh-failed",
      source: "Claude Team - Team A",
      reason: "every refresh path failed",
    })
    assert.equal(t?.variant, "error")
    assert.match(t?.message ?? "", /every refresh path failed/)
    assert.match(t?.message ?? "", /re-authenticate/)
  })

  it("shows a silent account switch — it spends another account's quota", () => {
    const t = noticeToToast({
      kind: "account-switched",
      failedSource: "Claude Team - Team A",
      usedSource: "Claude Team - Team B",
    })
    assert.equal(t?.variant, "warning")
    assert.match(t?.message ?? "", /Team A could not be refreshed/)
    assert.match(t?.message ?? "", /using Team B/)
  })

  it("stays quiet about a routine successful refresh by default", () => {
    const n = {
      kind: "refresh-succeeded" as const,
      source: "acct",
      extendedByMinutes: 480,
      via: "oauth",
    }
    assert.equal(noticeToToast(n), undefined)
    assert.equal(noticeToToast(n, { showSuccess: true })?.variant, "success")
  })

  it("reports how much validity a refresh actually bought", () => {
    const t = noticeToToast(
      {
        kind: "refresh-succeeded",
        source: "acct",
        extendedByMinutes: 480,
        via: "oauth",
      },
      { showSuccess: true },
    )
    assert.match(t?.message ?? "", /extended by 8h/)
  })

  it("does not claim an extension when the expiry did not move", () => {
    const t = noticeToToast(
      {
        kind: "refresh-succeeded",
        source: "acct",
        extendedByMinutes: 0,
        via: "cli",
      },
      { showSuccess: true },
    )
    assert.ok(!/extended by/.test(t?.message ?? ""))
    assert.match(t?.message ?? "", /refreshed via cli/)
  })

  it("keys notices so a repeat can be suppressed", () => {
    const a = noticeKey({ kind: "refresh-failed", source: "x", reason: "r" })
    const b = noticeKey({
      kind: "refresh-failed",
      source: "x",
      reason: "different",
    })
    const c = noticeKey({ kind: "refresh-failed", source: "y", reason: "r" })
    assert.equal(a, b, "same account+kind must collapse regardless of reason")
    assert.notEqual(a, c, "a different account is a different notice")
  })

  it("distinguishes switch pairs", () => {
    assert.notEqual(
      noticeKey({
        kind: "account-switched",
        failedSource: "a",
        usedSource: "b",
      }),
      noticeKey({
        kind: "account-switched",
        failedSource: "a",
        usedSource: "c",
      }),
    )
  })
})
