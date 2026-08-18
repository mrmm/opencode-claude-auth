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
  AUTO_SOURCE,
  PRESET_PREFIX,
  getActiveAccount,
  listAccounts,
  loadPersistedAccountSource,
  setActiveAccountSource,
} from "../credentials.ts"
import { type ClaudeAuthConfig, getConfig } from "../config.ts"
import { emitNotice } from "../notify.ts"
import { log } from "../logger.ts"
import {
  type CredentialState,
  type Decision,
  clearEjection,
  eject,
  selectAccount,
} from "./balancer.ts"
import type { ClaudeAccount } from "../keychain.ts"
import {
  type HeaderLike,
  bindingWindow,
  parseQuotaHeaders,
  readQuotaCache,
  writeQuotaForAccount,
} from "./quota.ts"
import { currentUsageIndex, recordRotation } from "./usage.ts"

/**
 * Which account a fresh process should start on.
 *
 * Never one that cannot serve a request. The Keychain's first entry is not
 * necessarily usable — here it is an entry holding no access token — and
 * starting there put the plugin on a dead account until the first rotation,
 * once per init, with the label advertising it the whole time.
 *
 * A pin is honoured only if it can actually serve; a pin to a dead account is a
 * stale instruction, not a reason to fail every request.
 */
export function pickStartupAccount<T extends { source: string }>(
  accounts: readonly T[],
  persisted: string | null,
  isUsable: (a: T) => boolean,
): T | undefined {
  if (accounts.length === 0) return undefined
  const pinned =
    persisted &&
    persisted !== AUTO_SOURCE &&
    !persisted.startsWith(PRESET_PREFIX)
      ? accounts.find((a) => a.source === persisted)
      : undefined
  if (pinned && isUsable(pinned)) return pinned
  return accounts.find((a) => isUsable(a)) ?? accounts[0]
}

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

/**
 * How the current selection reads, in the same words the status line uses.
 *
 * Shared so a toast and the provider label cannot describe the same state
 * differently — the toast exists precisely because the label cannot be rewritten
 * mid-session, and two descriptions of one thing would defeat the point.
 */
export function describeSelection(
  cfg: ClaudeAuthConfig,
  persisted: string | null,
  /** The pinned account's label. A pin names an account, so name it. */
  pinnedLabel?: string,
): string {
  if (persisted === AUTO_SOURCE) return `LB: balancing, ${cfg.strategy}`
  if (persisted?.startsWith(PRESET_PREFIX)) {
    const name = persisted.slice(PRESET_PREFIX.length)
    const text = cfg.presets[name]?.label ?? name
    return `LB: ${text.replace(/^LB\s+/i, "")}`
  }
  if (cfg.preset) {
    const text = cfg.presets[cfg.preset]?.label ?? cfg.preset
    return `LB: ${text.replace(/^LB\s+/i, "")}`
  }
  return pinnedLabel ?? "one account"
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
      // The status line cannot be rewritten mid-session, so without this a
      // change made by `pnpm lb` or claude_auth_select is invisible: the label
      // would keep advertising the arrangement that was in force at start-up.
      emitNotice({
        kind: "selection-changed",
        what: describeSelection(
          raw,
          persisted,
          getActiveAccount()?.label ?? undefined,
        ),
        nowOn: getActiveAccount()?.label ?? "an account",
      })
    }

    // `autoSwitch` decides only whether the plugin moves on its OWN initiative.
    // An explicit selection — chosen now, or in force at start-up — is obeyed
    // either way, otherwise picking a preset would appear to do nothing.
    if (!cfg.autoSwitch && !changed && !opts.force) return undefined

    // A pin names one account. Moving off it would answer a question the
    // operator already answered, so threshold and refusal are ignored while one
    // is set; an explicit change of selection still applies.
    const pinned =
      persisted !== null &&
      persisted !== "" &&
      persisted !== AUTO_SOURCE &&
      !persisted.startsWith(PRESET_PREFIX)
    if (pinned && cfg.pinBlocksRotation && !changed && !opts.force) {
      log("rotate_blocked_by_pin", { trigger, pinned: persisted })
      return undefined
    }

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
    //
    // Deliberately NOT syncAuthJson() either. That file is OpenCode's own
    // credential store, read while it constructs the provider. Rewriting it on
    // every rotation meant authorize() handed OpenCode one account's tokens and
    // a rotation replaced them microseconds later — five rewrites in thirteen
    // seconds, flip-flopping between accounts, observed while the provider was
    // being rebuilt after Provider Connect. Nothing needs it: the token is
    // resolved per request inside this plugin's own fetch, so the active
    // account is honoured without OpenCode's copy changing at all.

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
 * Usually the rate-limit headers explain the refusal — a window at its limit,
 * with a reset epoch — and health then follows from the quota cache with nothing
 * extra stored.
 *
 * But a refusal can also arrive that the headers call `allowed`. A monthly spend
 * cap does exactly this: observed live as `status=allowed 5h=37%` alongside a
 * 429 reading "would exceed your account's monthly spend limit". Trusting the
 * headers there leaves the account looking perfectly usable, so the balancer
 * picks it again, and again. When the headers and the response disagree, the
 * response is what actually happened: eject the account explicitly.
 */
export function noteRejection(
  source: string | null,
  headers: HeaderLike,
): Decision | undefined {
  const cfg = getConfig()
  if (!cfg.switchOn429) return undefined
  if (!source) return undefined

  let dated = false
  let explained = false

  try {
    const quota = parseQuotaHeaders(headers)
    if (quota) {
      writeQuotaForAccount(source, quota)
      dated =
        (quota.fiveHour?.resetsAt ?? quota.sevenDay?.resetsAt) !== undefined

      // Do the headers account for the refusal? A window out of room, or the
      // server saying `rejected`, explains it. Anything else means the limit
      // that bit is one these headers do not describe.
      const windows = [quota.fiveHour, quota.sevenDay].filter(
        (w): w is NonNullable<typeof w> => w !== undefined,
      )
      explained = windows.some(
        (w) => w.status === "rejected" || w.utilization >= cfg.switchAt,
      )
    }
  } catch {
    // fall through to an untimed ejection
  }

  let retryAfterMs: number | undefined
  const raw = headers.get?.("retry-after")
  if (raw) {
    const secs = Number.parseFloat(raw)
    if (Number.isFinite(secs) && secs > 0) retryAfterMs = secs * 1000
  }

  if (!dated || !explained) {
    // Prefer the server's own retry-after over our backoff: it knows when it
    // will accept traffic again, and we would be guessing.
    const e = eject(source, cfg, Date.now(), retryAfterMs)
    log("rotate_ejected", {
      source,
      untilMs: e.until,
      consecutive: e.count,
      reason: explained
        ? "refusal carried no reset time"
        : "refused while the headers reported room — a limit they do not describe",
      retryAfterMs: retryAfterMs ?? null,
    })
  }

  return maybeRotate("429")
}

/** An account that just served a request is not ejected. */
export function noteSuccess(source: string | null): void {
  if (source) clearEjection(source)
}
