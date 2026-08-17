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
  PRESET_PREFIX,
  getActiveAccount,
  getCachedCredentials,
  listAccounts,
  loadPersistedAccountSource,
  setActiveAccountSource,
  syncAuthJson,
} from "./credentials.ts"
import { type ClaudeAuthConfig, getConfig } from "./config.ts"
import { emitNotice } from "./notify.ts"
import { log } from "./logger.ts"
import {
  type CredentialState,
  type Decision,
  clearEjection,
  eject,
  selectAccount,
} from "./balancer.ts"
import type { ClaudeAccount } from "./keychain.ts"
import {
  type HeaderLike,
  bindingWindow,
  parseQuotaHeaders,
  readQuotaCache,
  writeQuotaForAccount,
} from "./quota.ts"
import { currentUsageIndex, recordRotation } from "./usage.ts"

/**
 * Fold the selected preset into the config.
 *
 * Precedence is deliberate: what you chose in the switcher beats `preset` in the
 * file, which beats the bare top-level settings. A preset named but not defined
 * is ignored rather than fatal — a typo should not silently narrow which
 * accounts may serve requests.
 */
export function resolveActiveConfig(
  cfg: ClaudeAuthConfig,
  persisted: string | null,
): { cfg: ClaudeAuthConfig; preset: string | null } {
  const chosen = persisted?.startsWith(PRESET_PREFIX)
    ? persisted.slice(PRESET_PREFIX.length)
    : cfg.preset || null
  if (!chosen) return { cfg, preset: null }

  const preset = cfg.presets[chosen]
  if (!preset) {
    log("preset_unknown", {
      requested: chosen,
      known: Object.keys(cfg.presets),
    })
    return { cfg, preset: null }
  }

  return {
    cfg: {
      ...cfg,
      ...(preset.strategy ? { strategy: preset.strategy } : {}),
      // A preset declares either a flat list or tiers, never a mix: letting a
      // preset's accounts sit alongside inherited pools would make the effective
      // set depend on settings the preset never mentioned.
      ...(preset.pools
        ? { pools: preset.pools, accounts: [] }
        : { accounts: preset.accounts ?? [], pools: [] }),
    },
    preset: chosen,
  }
}

/** The preset in force, or null. */
export function activePreset(): string | null {
  return resolveActiveConfig(getConfig(), loadPersistedAccountSource()).preset
}

/**
 * Can this account's stored credentials serve a request?
 *
 * An account with generous headroom and a token that expired days ago is not a
 * candidate just because its quota looks good — that was a real defect found by
 * pointing the balancer at a live Keychain, where one entry had been expired for
 * over two days and still assessed as healthy. A token with no expiry is a
 * long-lived one and is taken at face value.
 */
export function credentialState(
  account: ClaudeAccount,
  nowMs: number = Date.now(),
): CredentialState {
  const creds = account.credentials
  if (!creds?.accessToken) return "unusable"
  if (creds.expiresAt === undefined) return "ok"
  if (creds.expiresAt > nowMs) return "ok"
  return creds.refreshToken ? "refreshable" : "unusable"
}

/**
 * Re-evaluate which account should serve requests, and move if the answer
 * changed.
 *
 * Returns the decision when a move happened, otherwise undefined. Never
 * throws: this runs on the credential path, where a bookkeeping failure must
 * not become a failed request.
 */
/**
 * The selection currently in force, as a comparable key.
 *
 * Tracked so a *changed* selection is honoured even when `autoSwitch` is off.
 * `autoSwitch` governs whether the plugin moves accounts on its own initiative;
 * it must not also decide whether an explicit choice is obeyed, or picking a
 * preset would silently do nothing.
 */
let lastSelection: string | null = null

/** Test seam. */
export function resetSelectionMemo(): void {
  lastSelection = null
}

export function maybeRotate(
  trigger: string,
  opts: { force?: boolean } = {},
): Decision | undefined {
  try {
    const persisted = loadPersistedAccountSource()
    const raw = getConfig()
    const { cfg, preset } = resolveActiveConfig(raw, persisted)

    // Re-read on every call, so a selection changed from outside this process —
    // by an edit to the config file, or by `overlord`-style CLI writing the
    // state file — is picked up on the next request without an auth flow, and
    // therefore without OpenCode re-initialising the provider and cancelling
    // whatever the agent had in flight.
    const selection = `${persisted ?? ""}|${raw.preset}`
    const changed = lastSelection !== null && selection !== lastSelection
    lastSelection = selection
    if (changed) {
      log("selection_changed", { trigger, selection, preset })
    }

    // `autoSwitch` decides only whether the plugin moves on its OWN initiative.
    // An explicit selection — chosen now, or in force at start-up — is obeyed
    // either way, otherwise picking a preset would appear to do nothing.
    if (!cfg.autoSwitch && !changed && !opts.force) return undefined

    const accounts = listAccounts()
    if (accounts.length <= 1) return undefined

    const active = getActiveAccount()?.source ?? null
    // Only `least-used` reads the usage log, so only it pays for it.
    const wantsUsage =
      cfg.strategy === "least-used" ||
      cfg.pools.some((p) => p.strategy === "least-used")
    const decision = selectAccount(
      accounts.map((a) => ({
        source: a.source,
        label: a.label,
        credential: credentialState(a),
      })),
      readQuotaCache(),
      cfg,
      active,
      Date.now(),
      { usage: wantsUsage ? currentUsageIndex() : {} },
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
      const soonestReset = readQuotaCache()[decision.source]
      const w = soonestReset ? bindingWindow(soonestReset) : undefined
      emitNotice({
        kind: "accounts-exhausted",
        soonestSource: decision.source,
        ...(w?.resetsAt ? { resetsAt: w.resetsAt } : {}),
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
      preset,
      from,
      to: decision.source,
      pool: decision.pool,
      strategy: decision.strategy,
      reason: decision.reason,
    })

    recordRotation({
      from_account: from,
      to_account: decision.source,
      trigger,
      strategy: decision.strategy,
      pool: decision.pool,
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
