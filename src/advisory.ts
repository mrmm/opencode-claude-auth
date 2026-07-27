/**
 * Turning quota readings into something worth interrupting the user for.
 *
 * The account switcher and provider name both show quota, but only when the user
 * goes looking. Being on an exhausted account is worth saying out loud, because
 * the symptom otherwise arrives as a request failing mid-task.
 *
 * OpenCode's status bar cannot be extended -- there is no statusline plugin hook
 * or endpoint -- so the delivery mechanism is a toast (POST /tui/show-toast).
 * Toasts are transient and easy to resent, so this deliberately stays quiet
 * unless something is actually actionable.
 */

import {
  bindingWindow,
  formatDuration,
  quotaForAccount,
  type AccountQuota,
  type QuotaCache,
} from "./quota.ts"

/** Above this, the active account is worth warning about. */
export const WARN_AT = 0.9

/** An alternative is only worth naming if it has real room. */
export const ALTERNATIVE_AT = 0.7

/** Weekly burn is slower and hidden by the 5h figure, so it warns earlier. */
export const WEEKLY_WARN_AT = 0.85

export type Advisory = {
  variant: "info" | "success" | "warning" | "error"
  title: string
  message: string
}

export type AdvisoryAccount = { source: string; label: string }

/**
 * Drop the shared prefix so a toast reads as the part that distinguishes the
 * account: "Claude Team - Team A" -> "Team A - Wings of
 * Freedom". Labels that do not carry the prefix are left alone.
 */
export function shortenLabel(label: string): string {
  return (
    label.replace(/^Claude\s+(?:Team|Pro|Max|Free)\s*-\s*/i, "").trim() || label
  )
}

function utilOf(q: AccountQuota | undefined): number | undefined {
  if (!q) return undefined
  const w = bindingWindow(q)
  return w ? w.utilization : undefined
}

/**
 * The account with the most room, excluding `exceptSource`.
 *
 * Accounts with no reading are not candidates: recommending a switch to an
 * account whose state is unknown would be guessing.
 */
export function bestAlternative(
  accounts: AdvisoryAccount[],
  cache: QuotaCache,
  exceptSource: string | null,
  now?: number,
): { account: AdvisoryAccount; utilization: number } | undefined {
  let best: { account: AdvisoryAccount; utilization: number } | undefined
  for (const account of accounts ?? []) {
    if (!account?.source || account.source === exceptSource) continue
    const util = utilOf(quotaForAccount(account.source, cache, now))
    if (util === undefined) continue
    if (!best || util < best.utilization) best = { account, utilization: util }
  }
  return best
}

/**
 * What to tell the user, or undefined when nothing needs saying.
 *
 * Only the 5h and weekly windows are considered. Everything else the headers
 * carry (overage status, fallback percentage) describes why a limit behaves as
 * it does rather than anything the user can act on.
 */
export function buildAdvisory(
  accounts: AdvisoryAccount[],
  cache: QuotaCache,
  activeSource: string | null,
  now: number = Math.floor(Date.now() / 1000),
): Advisory | undefined {
  if (!activeSource) return undefined

  const active = quotaForAccount(activeSource, cache, now)
  if (!active) return undefined

  const activeLabel = shortenLabel(
    accounts?.find((a) => a.source === activeSource)?.label ?? activeSource,
  )

  const five = active.fiveHour
  const week = active.sevenDay

  // Exhausted or nearly so: the next request may simply fail.
  if (five && five.utilization >= WARN_AT) {
    const pct = Math.round(Math.min(five.utilization, 1) * 100)
    const resets =
      five.resetsAt && five.resetsAt > now
        ? `resets in ${formatDuration(five.resetsAt - now)}`
        : "resetting now"

    const alt = bestAlternative(accounts, cache, activeSource, now)
    const suggestion =
      alt && alt.utilization <= ALTERNATIVE_AT
        ? ` ${shortenLabel(alt.account.label)} is at ${Math.round(alt.utilization * 100)}%.`
        : ""

    return {
      variant: five.utilization >= 1 ? "error" : "warning",
      title:
        five.utilization >= 1 ? "Claude quota exhausted" : "Claude quota low",
      message: `${activeLabel} at ${pct}% (${resets}).${suggestion}`,
    }
  }

  // Weekly burn is invisible in the 5h number until it bites.
  if (week && week.utilization >= WEEKLY_WARN_AT) {
    const pct = Math.round(Math.min(week.utilization, 1) * 100)
    const resets =
      week.resetsAt && week.resetsAt > now
        ? `resets in ${formatDuration(week.resetsAt - now)}`
        : "resetting now"
    return {
      variant: "warning",
      title: "Claude weekly quota high",
      message: `${activeLabel} at ${pct}% of the weekly limit (${resets}).`,
    }
  }

  return undefined
}
