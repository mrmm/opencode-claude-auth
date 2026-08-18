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

import type { Notice } from "../notify.ts"
import {
  bindingWindow,
  formatDuration,
  quotaForAccount,
  type AccountQuota,
  type QuotaCache,
} from "../balance/quota.ts"

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
 * account: "Claude Team - Team A" -> "Team A - Team A". Labels that do not carry the prefix are left alone.
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
export type AdvisoryThresholds = {
  warnAt?: number
  weeklyWarnAt?: number
  alternativeAt?: number
  maxAgeSeconds?: number
}

export function buildAdvisory(
  accounts: AdvisoryAccount[],
  cache: QuotaCache,
  activeSource: string | null,
  now: number = Math.floor(Date.now() / 1000),
  thresholds: AdvisoryThresholds = {},
): Advisory | undefined {
  const warnAt = thresholds.warnAt ?? WARN_AT
  const weeklyWarnAt = thresholds.weeklyWarnAt ?? WEEKLY_WARN_AT
  const alternativeAt = thresholds.alternativeAt ?? ALTERNATIVE_AT
  if (!activeSource) return undefined

  const active = quotaForAccount(
    activeSource,
    cache,
    now,
    thresholds.maxAgeSeconds,
  )
  if (!active) return undefined

  const activeLabel = shortenLabel(
    accounts?.find((a) => a.source === activeSource)?.label ?? activeSource,
  )

  const five = active.fiveHour
  const week = active.sevenDay

  // Exhausted or nearly so: the next request may simply fail.
  if (five && five.utilization >= warnAt) {
    const pct = Math.round(Math.min(five.utilization, 1) * 100)
    const resets =
      five.resetsAt && five.resetsAt > now
        ? `resets in ${formatDuration(five.resetsAt - now)}`
        : "resetting now"

    const alt = bestAlternative(accounts, cache, activeSource, now)
    const suggestion =
      alt && alt.utilization <= alternativeAt
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
  if (week && week.utilization >= weeklyWarnAt) {
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

// ---------------------------------------------------------------------------
// Refresh notices
// ---------------------------------------------------------------------------

/**
 * Whether a refresh notice is worth a toast, and what it should say.
 *
 * Deliberately asymmetric. A failure and a silent account switch both change
 * which credentials serve your requests without you asking, so they are shown by
 * default. A successful refresh is routine -- it happens every few hours by
 * design -- so it is opt-in via CLAUDE_AUTH_TOAST_REFRESH=1; showing it always
 * would train you to ignore the toasts that matter.
 *
 * Latching is the caller's job: this function is pure so the policy can be
 * tested without a clock or a client.
 */
export function noticeToToast(
  notice: Notice,
  opts: { showSuccess?: boolean } = {},
): Advisory | undefined {
  switch (notice.kind) {
    case "refresh-failed":
      return {
        variant: "error",
        title: "Claude token refresh failed",
        message: `${shortenLabel(notice.source)}: ${notice.reason}. Run \`claude\` to re-authenticate.`,
      }

    case "account-switched":
      // This one was invisible: the plugin served a different account 304 times
      // without saying so, which silently spends another account's quota.
      return {
        variant: "warning",
        title: "Claude account switched",
        message: `${shortenLabel(notice.failedSource)} could not be refreshed; using ${shortenLabel(notice.usedSource)} instead.`,
      }

    case "account-rotated":
      // Always shown, regardless of showSuccess: this is the only thing on
      // screen that says which account is spending your quota now. The
      // provider/model label is applied once at config load and cannot be
      // rewritten mid-session, so without this the switch is invisible.
      return {
        variant: "warning",
        title: "Claude account rotated",
        message: `${shortenLabel(notice.fromSource)} ${notice.reason} — now on ${shortenLabel(notice.toSource)} (${notice.strategy}, ${notice.pool}).`,
      }

    case "selection-changed":
      // Always shown. The provider name in the status line is written once at
      // config load and cannot be rewritten mid-session, so without this a
      // change made by `pnpm lb` or claude_auth_select is invisible until the
      // next restart — the status line would still advertise the old one.
      return {
        variant: "info",
        title: "Claude account selection changed",
        message: `${notice.what} — now on ${shortenLabel(notice.nowOn)}. The status line updates on the next restart.`,
      }

    case "accounts-exhausted": {
      // Previously this state was log-only: every account spent and the screen
      // said nothing, which reads as the plugin having simply stopped.
      const when = notice.resetsAt
        ? formatDuration(notice.resetsAt - Math.floor(Date.now() / 1000))
        : undefined
      return {
        variant: "error",
        title: "All Claude accounts are spent",
        message: when
          ? `Staying on ${shortenLabel(notice.soonestSource)}, which frees up in ${when}.`
          : `Staying on ${shortenLabel(notice.soonestSource)}; no reset time was reported.`,
      }
    }

    case "refresh-succeeded":
      if (!opts.showSuccess) return undefined
      return {
        variant: "success",
        title: "Claude token refreshed",
        message:
          notice.extendedByMinutes > 0
            ? `${shortenLabel(notice.source)} extended by ${formatDuration(notice.extendedByMinutes * 60)} via ${notice.via}.`
            : `${shortenLabel(notice.source)} refreshed via ${notice.via}.`,
      }

    default:
      return undefined
  }
}

/** Key used to avoid repeating the same notice over and over. */
export function noticeKey(notice: Notice): string {
  switch (notice.kind) {
    case "refresh-failed":
      return `failed:${notice.source}`
    case "account-switched":
      return `switched:${notice.failedSource}->${notice.usedSource}`
    case "selection-changed":
      // Keyed on the selection, so each distinct change speaks even if another
      // came minutes earlier; the cooldown only suppresses the identical one.
      return `selection:${notice.what}`
    case "accounts-exhausted":
      // Keyed on the reset, so one message per exhaustion rather than per request.
      return `exhausted:${notice.resetsAt ?? 0}`
    case "account-rotated":
      // Keyed on the pair, not the reason, so a flapping pair is suppressed by
      // the cooldown while a move to a genuinely new account still speaks up.
      return `rotated:${notice.fromSource}->${notice.toSource}`
    case "refresh-succeeded":
      return `ok:${notice.source}`
    default:
      return "unknown"
  }
}
