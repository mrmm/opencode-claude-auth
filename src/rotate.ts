/**
 * The side-effecting half of the balancer.
 *
 * `balancer.ts` decides; this applies. Keeping them apart is what lets the
 * whole policy be tested without a Keychain or a network, and it keeps the one
 * rule that makes the feature hot-reloadable honest: the config is read *here*,
 * at each decision, never captured at start-up. Edit `claude-auth.jsonc` and
 * the next request already obeys it.
 *
 * Applying a rotation is cheap because the provider is not re-registered. The
 * custom `fetch` in `index.ts` resolves the token per request via
 * `getCachedCredentials()`, so changing the active account changes who serves
 * the very next call — no provider reload, no OpenCode restart.
 */

import {
  getActiveAccount,
  getCachedCredentials,
  listAccounts,
  setActiveAccountSource,
  syncAuthJson,
} from "./credentials.ts"
import { getConfig } from "./config.ts"
import { emitNotice } from "./notify.ts"
import { log } from "./logger.ts"
import {
  type Decision,
  clearEjection,
  eject,
  selectAccount,
} from "./balancer.ts"
import {
  type HeaderLike,
  parseQuotaHeaders,
  readQuotaCache,
  writeQuotaForAccount,
} from "./quota.ts"

/**
 * Re-evaluate which account should serve requests, and move if the answer
 * changed.
 *
 * Returns the decision when a move happened, otherwise undefined. Never
 * throws: this runs on the credential path, where a bookkeeping failure must
 * not become a failed request.
 */
export function maybeRotate(trigger: string): Decision | undefined {
  try {
    const cfg = getConfig()
    if (!cfg.autoSwitch) return undefined

    const accounts = listAccounts()
    if (accounts.length <= 1) return undefined

    const active = getActiveAccount()?.source ?? null
    const decision = selectAccount(
      accounts.map((a) => ({ source: a.source, label: a.label })),
      readQuotaCache(),
      cfg,
      active,
    )
    if (!decision || !decision.changed) return undefined

    // Every account is spent: moving achieves nothing except a cold prompt
    // cache on an account that will refuse the request too. Stay put and let
    // the advisory toast explain the wait.
    if (decision.pool === "exhausted") {
      log("rotate_skipped_all_spent", {
        trigger,
        active,
        soonest: decision.source,
        reason: decision.reason,
      })
      return undefined
    }

    const from = active
    setActiveAccountSource(decision.source)

    // Deliberately NOT saveAccountSource(): the persisted value is the user's
    // declared choice from the switcher, restored at start-up. A rotation is
    // this process's runtime decision — persisting it would let one OpenCode
    // window's exhaustion silently move every future window, and would erase a
    // pin the user set on purpose.
    const creds = getCachedCredentials()
    if (creds) syncAuthJson(creds)

    log("rotate_applied", {
      trigger,
      from,
      to: decision.source,
      pool: decision.pool,
      strategy: decision.strategy,
      reason: decision.reason,
    })

    if (from) {
      emitNotice({
        kind: "account-rotated",
        fromSource: from,
        toSource: decision.source,
        reason: reasonForPrevious(from, trigger),
        pool: decision.pool,
        strategy: decision.strategy,
      })
    }

    return decision
  } catch (err) {
    log("rotate_failed", {
      trigger,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * Phrase why the account being left behind was abandoned, for the toast.
 *
 * Read from the cache rather than passed in, so the message reports what was
 * actually measured instead of restating the strategy's own summary.
 */
function reasonForPrevious(source: string, trigger: string): string {
  if (trigger === "429") return "was refused (429)"
  try {
    const cfg = getConfig()
    const q = readQuotaCache()[source]
    if (!q) return "is unavailable"
    const w =
      cfg.switchWindow === "7d"
        ? q.sevenDay
        : cfg.switchWindow === "5h"
          ? q.fiveHour
          : (q.sevenDay?.utilization ?? 0) > (q.fiveHour?.utilization ?? 0)
            ? q.sevenDay
            : q.fiveHour
    if (!w) return "is spent"
    return `hit ${Math.round(w.utilization * 100)}% of its ${cfg.switchWindow} limit`
  } catch {
    return "is spent"
  }
}

/**
 * Record a refusal against `source` and rotate away from it.
 *
 * A 429 carries the unified rate-limit headers, including the reset epoch, so
 * the refusal usually dates itself and health follows from the quota cache with
 * nothing extra stored. The bounded ejection is the fallback for a refusal that
 * arrives without a usable reset time — otherwise the account would look
 * healthy again the instant the response was forgotten.
 */
export function noteRejection(
  source: string | null,
  headers: HeaderLike,
): Decision | undefined {
  const cfg = getConfig()
  if (!cfg.switchOn429) return undefined
  if (!source) return undefined

  let dated = false
  try {
    const quota = parseQuotaHeaders(headers)
    if (quota) {
      writeQuotaForAccount(source, quota)
      dated =
        (quota.fiveHour?.resetsAt ?? quota.sevenDay?.resetsAt) !== undefined
    }
  } catch {
    // fall through to the untimed ejection
  }

  if (!dated) {
    const e = eject(source, cfg)
    log("rotate_ejected_undated", {
      source,
      untilMs: e.until,
      consecutive: e.count,
    })
  }

  return maybeRotate("429")
}

/** An account that just served a request is not ejected. */
export function noteSuccess(source: string | null): void {
  if (source) clearEjection(source)
}
