import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import crypto from "node:crypto"
import { config } from "./model-config.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  applyAccountLabelToConfig,
  getAccountLabelPlacement,
} from "./display.ts"
import { buildAdvisory, noticeKey, noticeToToast } from "./advisory.ts"
import { setNoticeSink } from "./notify.ts"
import { getConfig, primeConfig } from "./config.ts"
import {
  formatQuotaPrefix,
  parseQuotaHeaders,
  quotaForAccount,
  readQuotaCache,
  refreshQuotas,
  writeQuotaForAccount,
} from "./quota.ts"
import { maybeRotate, noteRejection, noteSuccess } from "./rotate.ts"
import { recordRequest } from "./usage.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import {
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
import {
  AUTO_SOURCE,
  PRESET_PREFIX,
  getActiveAccount,
  getCachedCredentials,
  reloadCredentialsFromSource,
  syncAuthJson,
  initAccounts,
  setActiveAccountSource,
  loadPersistedAccountSource,
  saveAccountSource,
  refreshAccountsList,
  refreshIfNeeded,
  type ClaudeCredentials,
} from "./credentials.ts"

export {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
export { resetExcludedBetas } from "./betas.ts"
export {
  stripToolPrefix,
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
export {
  getCachedCredentials,
  syncAuthJson,
  refreshAccountsList,
  type ClaudeCredentials,
} from "./credentials.ts"
export {
  applyAccountLabelToConfig,
  decorateName,
  getAccountLabelPlacement,
  type AccountLabelPlacement,
} from "./display.ts"
export {
  buildBillingHeaderValue,
  computeCch,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from "./signing.ts"

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, sdk-cli)`
  )
}

function getStainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os":
      process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
}

function buildRequestUrl(input: RequestInfo | URL): string | URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true")
  }

  return typeof input === "string" ? url.toString() : url
}

// Stable per-process session ID, matching Claude Code's X-Claude-Code-Session-Id
const sessionId = crypto.randomUUID()

type FetchFn = typeof fetch

// Maximum delay before we give up retrying and surface the error.
// A retry-after longer than this signals a quota/usage-limit reset (hours away)
// rather than a transient rate limit — retrying would hang indefinitely.
// Override with OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS for longer retry windows.
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function getMaxRetryDelayMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
  fetchImpl: FetchFn = fetch,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetchImpl(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after")
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delay = Number.isNaN(parsed) ? (i + 1) * 2000 : parsed * 1000
      // If delay exceeds the cap, the server is signalling a quota/usage-limit
      // reset far in the future. Return immediately so the error surfaces to
      // the user rather than silently hanging until the reset time.
      if (delay > getMaxRetryDelayMs()) {
        log("fetch_rate_limited_quota", {
          status: res.status,
          retryAfter: retryAfter ?? "none",
          delayMs: delay,
        })
        return res
      }
      log("fetch_rate_limited", {
        status: res.status,
        attempt: i + 1,
        retryAfter: retryAfter ?? "none",
        delayMs: delay,
      })
      await new Promise((r) => setTimeout(r, delay))
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  } else if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  }

  const modelBetas = getModelBetas(modelId, excludedBetas)
  const incomingBeta = headers.get("anthropic-beta") ?? ""
  const mergedBetas = [
    ...new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ]),
  ]

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("X-Claude-Code-Session-Id", sessionId)
  for (const [key, value] of Object.entries(getStainlessHeaders())) {
    if (!headers.has(key)) headers.set(key, value)
  }
  headers.delete("x-api-key")

  return headers
}

// The installed @opencode-ai/plugin types declare a single parameter, but the
// runtime passes inline options from opencode.jsonc as a second argument -- the
// mechanism other plugins already rely on. Typed explicitly rather than left
// implicitly `any`.
/**
 * The runtime passes inline options from opencode.jsonc as a second argument --
 * the mechanism other plugins already use -- but the installed
 * @opencode-ai/plugin types declare only one. Widening the signature here keeps
 * the hooks contextually typed, where a blanket cast would make every hook
 * parameter implicitly `any`.
 */
type PluginWithOptions = (
  input: PluginInput,
  options?: unknown,
) => ReturnType<Plugin>

const plugin: PluginWithOptions = async (
  { client, directory, worktree },
  options,
) => {
  // Inline options from opencode.jsonc are only visible here, so record them
  // once; file layers are re-read on change afterwards.
  const initialConfig = primeConfig(worktree || directory, options)
  initLogger({ config: initialConfig })

  let accounts: ClaudeAccount[] = []
  try {
    accounts = readAllClaudeAccounts()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log("plugin_init_error", { error })
    console.warn(
      "opencode-claude-auth: Failed to read Claude Code credentials:",
      error,
    )
    return {}
  }

  initAccounts(accounts)

  const defaultAccountSource = accounts[0]?.source ?? null

  /**
   * Prefix a switcher row with that account's quota, e.g.
   * "[100% 1h19m] Claude Team - Team A".
   *
   * Quota is only known for accounts that have served a request on this machine,
   * since it is read from response headers. Unknown accounts are returned
   * unchanged rather than padded with a placeholder.
   */
  function prefixWithQuota(
    label: string,
    source: string,
    cache: ReturnType<typeof readQuotaCache>,
  ): string {
    try {
      const prefix = formatQuotaPrefix(quotaForAccount(source, cache))
      return prefix ? `${prefix} ${label}` : label
    } catch {
      return label
    }
  }

  /**
   * Label of the account currently serving requests, or "" if unknown.
   *
   * Reads the account list fresh: the user can switch accounts, or edit the
   * Keychain comment, without restarting OpenCode.
   */
  function activeAccountLabel(): string {
    try {
      const current = refreshAccountsList()
      const source = loadPersistedAccountSource() ?? defaultAccountSource
      const active = source
        ? (current.find((a) => a.source === source) ?? current[0])
        : current[0]
      return active?.label ?? ""
    } catch {
      // A display nicety must never break auth.
      return ""
    }
  }

  /**
   * Top up quota readings for every account.
   *
   * Detached and self-skipping: refreshQuotas ignores any account whose
   * reading is younger than quotaProbeMaxAge, so calling this often is cheap.
   * An exhausted account answers 429 and costs nothing; a healthy one spends a
   * single token.
   */
  const topUpQuota = (trigger: string) => {
    const cfg = getConfig()
    if (!cfg.quotaProbe) return
    const targets = refreshAccountsList()
      .map((a) => ({
        source: a.source,
        accessToken: a.credentials?.accessToken ?? "",
      }))
      .filter((a) => a.accessToken)
    if (targets.length === 0) return

    void refreshQuotas(targets, {
      maxAgeSeconds: Math.floor(cfg.quotaProbeMaxAge / 1000),
    })
      .then((r) => {
        if (r.probed > 0) log("quota_refreshed", { trigger, ...r })
      })
      .catch(() => {})
  }

  if (accounts.length > 0) {
    const persistedSource = loadPersistedAccountSource()
    // Auto, a chosen preset, or a preset named in the config all mean "the
    // strategy owns the choice" — so honour it at start-up rather than sitting
    // on whichever account the Keychain happened to list first.
    const managedSelection =
      persistedSource === AUTO_SOURCE ||
      persistedSource?.startsWith(PRESET_PREFIX) === true ||
      getConfig().preset !== ""
    const autoMode = persistedSource === AUTO_SOURCE
    const defaultAccount =
      (!autoMode &&
        persistedSource &&
        accounts.find((a) => a.source === persistedSource)) ||
      accounts[0]

    setActiveAccountSource(defaultAccount.source)

    log("plugin_init", {
      accountCount: accounts.length,
      sources: accounts.map((a) => a.source),
      activeSource: defaultAccount.source,
      autoMode,
      managedSelection,
    })

    // With no pin, the first account is only a starting point — let the
    // configured strategy have the first word rather than defaulting to
    // whichever account the Keychain happened to list first.
    if (managedSelection) maybeRotate("startup", { force: true })

    const initialCreds = getCachedCredentials()
    if (initialCreds) {
      syncAuthJson(initialCreds)
    } else {
      console.warn(
        "opencode-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
      )
    }

    // Surface credential events that change which account serves requests.
    // A refresh failing, or the plugin quietly falling back to a different
    // account, both happen without any user action and were previously visible
    // only in a log file nobody had enabled.
    const shownNotices = new Map<string, number>()
    setNoticeSink((notice) => {
      try {
        const advisory = noticeToToast(notice, {
          showSuccess: getConfig().toastOnRefresh,
        })
        if (!advisory) return

        // The same condition repeats every sync tick while it persists; say it
        // once, then stay quiet for a while.
        const key = noticeKey(notice)
        const last = shownNotices.get(key) ?? 0
        if (Date.now() - last < getConfig().noticeCooldown) return
        shownNotices.set(key, Date.now())

        void client.tui
          .showToast({
            body: {
              title: advisory.title,
              message: advisory.message,
              variant: advisory.variant,
              duration: advisory.variant === "error" ? 15_000 : 10_000,
            },
          })
          .catch(() => {})
        log("credential_notice_shown", {
          kind: notice.kind,
          variant: advisory.variant,
        })
      } catch (err) {
        log("credential_notice_failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Give every switcher row a figure. Passive capture only ever learns about
    // the account already serving traffic, which is the one the user already
    // knows, so filling the rest needs a probe.
    //
    // Opt-in, not opt-out: this spends a request per account with the user's own
    // tokens, and start-up is not an obvious place for unsolicited network
    // traffic -- upstream's tests stub fetch and count calls, and quite
    // reasonably did not expect init to make any. Passive capture keeps working
    // regardless; set CLAUDE_AUTH_QUOTA_PROBE=1 to fill every switcher row.
    if (getConfig().quotaProbe) {
      const probeTargets = accounts
        .map((a) => ({
          source: a.source,
          accessToken: a.credentials?.accessToken ?? "",
        }))
        .filter((a) => a.accessToken)

      void refreshQuotas(probeTargets)
        .then(async (r) => {
          log("quota_probe", r)

          // OpenCode's status bar cannot be extended -- there is no statusline
          // plugin hook or endpoint -- so an actionable state is delivered as a
          // toast. Silent unless something is worth interrupting for.
          try {
            const advisory = buildAdvisory(
              accounts.map((a) => ({ source: a.source, label: a.label })),
              readQuotaCache(),
              getActiveAccount()?.source ?? null,
            )
            if (!advisory) return
            await client.tui.showToast({
              body: {
                title: advisory.title,
                message: advisory.message,
                variant: advisory.variant,
                duration: 12_000,
              },
            })
            log("quota_advisory_shown", {
              variant: advisory.variant,
              message: advisory.message,
            })
          } catch (err) {
            // A missing TUI (headless/serve) or any client error is not fatal.
            log("quota_advisory_failed", {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })
        .catch(() => {})
    }

    // Keep auth.json synced and proactively refresh before expiry.
    // refreshIfNeeded() always resolves the currently ACTIVE account
    // (via getActiveAccount() internally) — not a closure-captured account
    // list — so this stays correct across account switches. Passing
    // PROACTIVE_REFRESH_THRESHOLD_MS (1 hour) means it triggers a real
    // OAuth refresh once the token is within that window of expiry, and
    // simply returns the untouched credentials otherwise (no-op refresh).
    // This prevents the "run `claude` to re-authenticate" message from
    // appearing mid-session when the token silently expires.
    let proactiveRefreshWarned = false

    // Rescheduled after each tick rather than a fixed setInterval, so editing
    // refreshCheckInterval takes effect without a restart -- the same promise
    // the rest of the config makes. setInterval would capture the value once.
    let syncTimer: ReturnType<typeof setTimeout>
    const scheduleSync = () => {
      syncTimer = setTimeout(() => {
        runSyncTick()
        scheduleSync()
      }, getConfig().refreshCheckInterval)
      syncTimer.unref?.()
    }

    const runSyncTick = () => {
      // Quota ages the same way credentials do, and the account switcher cannot
      // fetch on open -- its prompts getter is synchronous and OpenCode rejects
      // a promise (verified: /provider/auth 500). Keeping the cache warm here is
      // what makes the switcher current when it is opened.
      topUpQuota("sync-tick")

      // Rotate on the timer too, not only after a response. Without this a
      // spent account is discovered by the NEXT request, which pays for the
      // discovery; on an idle session the move can happen before you type.
      maybeRotate("sync-tick")

      try {
        const account = getActiveAccount()
        log("proactive_refresh_check", {
          source: account?.source ?? null,
          expiresAt: account?.credentials?.expiresAt ?? null,
          thresholdMs: getConfig().refreshBeforeExpiry,
        })

        const creds = refreshIfNeeded(
          undefined,
          getConfig().refreshBeforeExpiry,
        )
        if (creds) {
          syncAuthJson(creds)
          if (proactiveRefreshWarned) {
            log("proactive_refresh_recovered", { source: account?.source })
          }
          proactiveRefreshWarned = false
        } else {
          log("proactive_refresh_failed", { source: account?.source })
          // Only warn once per outage — otherwise this fires every
          // every check interval for as long as refresh keeps failing.
          if (!proactiveRefreshWarned) {
            proactiveRefreshWarned = true
            console.warn(
              `opencode-claude-auth: Proactive token refresh failed for ${account?.label ?? account?.source ?? "the active account"}. Run \`claude\` to re-authenticate.`,
            )
          }
        }
      } catch {
        // Non-fatal
      }
    }

    scheduleSync()
  } else {
    log("plugin_init_no_accounts", { reason: "no credentials found" })
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. Running in API key mode with transform hook enabled.",
    )
  }

  // Loaded here rather than imported at module scope: tools.ts pulls in
  // @opencode-ai/plugin for its `tool()` helper, and having that in the static
  // graph made node:test cancel 28 subtests in index.test.ts. A dynamic import
  // runs once, at init, and a failure to load costs the tools rather than the
  // plugin.
  let registeredTools: Record<string, unknown> | undefined
  if (getConfig().tools) {
    try {
      registeredTools = (await import("./tools.ts")).claudeAuthTools
      log("tools_registered", { names: Object.keys(registeredTools) })
    } catch (err) {
      log("tools_register_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    ...(registeredTools ? { tool: registeredTools } : {}),

    config: async (opencodeConfig) => {
      // Show which account is serving this session. The switcher label is
      // otherwise visible only while the switcher is open, so with several
      // accounts configured nothing on screen tells them apart.
      try {
        const placement = getAccountLabelPlacement()
        const label = activeAccountLabel()
        const applied = applyAccountLabelToConfig(
          opencodeConfig,
          label,
          placement,
        )
        log("account_label_config", {
          label: label || "(none)",
          placement,
          provider: applied.provider,
          models: applied.models,
        })
      } catch (err) {
        // Never let a cosmetic label stop the config from loading.
        log("account_label_failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.providerID !== "anthropic") {
        return
      }

      const hasIdentityPrefix = output.system.some((entry) =>
        entry.includes(SYSTEM_IDENTITY),
      )
      if (!hasIdentityPrefix) {
        output.system.unshift(SYSTEM_IDENTITY)
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        log("auth_loader_called", { authType: auth.type })
        if (auth.type !== "oauth") {
          log("auth_loader_skipped", {
            authType: auth.type,
            reason: "auth type is not oauth",
          })
          return {}
        }

        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        log("auth_loader_ready", {
          modelCount: Object.keys(provider.models).length,
        })

        return {
          apiKey: "",
          baseURL: "https://api.anthropic.com/v1",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const latest = getCachedCredentials()
            if (!latest) {
              log("fetch_no_credentials", { modelId: "unknown" })
              throw new Error(
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
              )
            }

            const requestInit = init ?? {}
            const bodyStr =
              typeof requestInit.body === "string"
                ? requestInit.body
                : undefined
            let modelId = "unknown"
            if (bodyStr) {
              try {
                modelId =
                  (JSON.parse(bodyStr) as { model?: string }).model ?? "unknown"
              } catch {}
            }

            log("fetch_credentials", {
              modelId,
              accessToken: latest.accessToken,
              expiresAt: latest.expiresAt,
            })

            // Get excluded betas for this model (from previous failed requests)
            const excluded = getExcludedBetas(modelId)
            const requestUrl = buildRequestUrl(input)
            const headers = buildRequestHeaders(
              input,
              requestInit,
              latest.accessToken,
              modelId,
              excluded,
            )
            const body = transformBody(requestInit.body)

            const headerKeys: string[] = []
            headers.forEach((_, key) => {
              headerKeys.push(key)
            })
            const betas = (headers.get("anthropic-beta") ?? "")
              .split(",")
              .filter(Boolean)
            log("fetch_headers_built", { headerKeys, betas, modelId })

            const startedAt = Date.now()
            let response = await fetchWithRetry(requestUrl, {
              ...requestInit,
              body,
              headers,
            })

            log("fetch_response", {
              status: response.status,
              modelId,
              retryAttempt: 0,
            })

            // On 401, bypass the in-memory cache to pick up credentials rotated by
            // another client, then retry once only when the access token changed.
            let preserveResponseUnchanged = false
            if (response.status === 401) {
              let refreshed: ClaudeCredentials | null = null
              try {
                refreshed = reloadCredentialsFromSource()
              } catch {}

              // The source had nothing newer, yet the server rejected this
              // token: the stored credential is itself stale, and reloading it
              // again will never help. This is the shape of a session that sat
              // idle -- overnight, or awaiting a permission prompt -- while its
              // access token was rotated or revoked out from under it. A 401 is
              // proof enough to spend a refresh, which is safe now that
              // refreshing takes a per-account lock and re-reads first.
              if (!refreshed || refreshed.accessToken === latest.accessToken) {
                try {
                  log("stale_token_forcing_refresh", {
                    reason: "401 with no newer credentials at the source",
                    modelId,
                  })
                  // A threshold of Infinity means "treat it as expired now".
                  refreshed =
                    refreshIfNeeded(undefined, Number.POSITIVE_INFINITY) ?? null
                } catch (err) {
                  log("stale_token_refresh_failed", {
                    error: err instanceof Error ? err.message : String(err),
                  })
                }
              }

              if (refreshed && refreshed.accessToken !== latest.accessToken) {
                const retryHeaders = buildRequestHeaders(
                  input,
                  requestInit,
                  refreshed.accessToken,
                  modelId,
                  excluded,
                )
                response = await fetchWithRetry(requestUrl, {
                  ...requestInit,
                  body,
                  headers: retryHeaders,
                })
              } else {
                preserveResponseUnchanged = true
              }
            }

            // Check for long-context beta errors and retry with betas excluded
            // Try up to LONG_CONTEXT_BETAS.length times, excluding one more beta each time
            for (
              let attempt = 0;
              attempt < LONG_CONTEXT_BETAS.length;
              attempt++
            ) {
              if (response.status !== 400 && response.status !== 429) {
                break
              }

              const cloned = response.clone()
              const responseBody = await cloned.text()

              if (!isLongContextError(responseBody)) {
                break
              }

              const betaToExclude = getNextBetaToExclude(modelId)
              if (!betaToExclude) {
                break // All long-context betas already excluded
              }

              addExcludedBeta(modelId, betaToExclude)
              log("fetch_beta_excluded", {
                modelId,
                excludedBeta: betaToExclude,
              })

              // Rebuild headers without the excluded beta and retry
              const currentCreds = getCachedCredentials()
              const retryToken = currentCreds?.accessToken ?? latest.accessToken
              const newExcluded = getExcludedBetas(modelId)
              const newHeaders = buildRequestHeaders(
                input,
                requestInit,
                retryToken,
                modelId,
                newExcluded,
              )

              response = await fetchWithRetry(requestUrl, {
                ...requestInit,
                body,
                headers: newHeaders,
              })
            }

            // A 429 that survived every retry above is a real exhaustion, not
            // congestion. Rotate off this account and give the request one more
            // chance on the next one, so a spent account costs a retry instead
            // of the turn. The rotation itself is hot: the token is resolved per
            // request, so nothing has to be re-registered for this to land.
            if (response.status === 429) {
              const refusedSource = getActiveAccount()?.source ?? null
              const rotated = noteRejection(refusedSource, response.headers)
              const rotatedCreds = rotated ? getCachedCredentials() : null
              if (
                rotatedCreds &&
                rotatedCreds.accessToken !== latest.accessToken
              ) {
                log("fetch_retry_after_rotate", {
                  modelId,
                  from: refusedSource,
                  to: rotated?.source,
                  strategy: rotated?.strategy,
                })
                response = await fetchWithRetry(requestUrl, {
                  ...requestInit,
                  body,
                  headers: buildRequestHeaders(
                    input,
                    requestInit,
                    rotatedCreds.accessToken,
                    modelId,
                    getExcludedBetas(modelId),
                  ),
                })
                preserveResponseUnchanged = false
              }
            }

            // Record non-200 responses without writing over OpenCode's terminal UI.
            if (!response.ok) {
              const status = response.status
              const cloned = response.clone()
              cloned
                .text()
                .then((errorBody) => {
                  let message = errorBody
                  try {
                    const parsed = JSON.parse(errorBody) as {
                      error?: { type?: string; message?: string }
                    }
                    message =
                      parsed.error?.message ?? parsed.error?.type ?? errorBody
                  } catch {}
                  log("fetch_error_response", { status, modelId, message })
                })
                .catch(() => {})
            }

            // Every Anthropic response reports this account's utilisation and
            // reset time. Recording it here is free, and the account switcher
            // builds its rows synchronously so it cannot fetch them itself.
            let observedQuota: ReturnType<typeof parseQuotaHeaders>
            try {
              const quota = parseQuotaHeaders(response.headers)
              observedQuota = quota
              const source = getActiveAccount()?.source ?? null
              if (quota && source) {
                writeQuotaForAccount(source, quota)
                log("quota_observed", {
                  source,
                  fiveHour: quota.fiveHour?.utilization,
                  sevenDay: quota.sevenDay?.utilization,
                  status: quota.fiveHour?.status,
                })
              }
            } catch {
              // Never let bookkeeping break a response.
            }

            // Usage history, which the quota cache cannot provide: it holds only
            // the latest reading per account, so it answers "how full is this
            // account" but never "how much has it served, and how often was it
            // refused". Recorded for every response, refusals included.
            const servedBy = getActiveAccount()?.source ?? null
            if (servedBy) {
              recordRequest({
                account: servedBy,
                model: modelId,
                status: response.status,
                duration_ms: Date.now() - startedAt,
                ...(observedQuota?.fiveHour
                  ? { utilization_5h: observedQuota.fiveHour.utilization }
                  : {}),
                ...(observedQuota?.sevenDay
                  ? { utilization_7d: observedQuota.sevenDay.utilization }
                  : {}),
              })
            }

            // Act on the reading just recorded. Every response is a free
            // measurement of the active account, so this is where exhaustion is
            // noticed *before* the next request is refused — the 429 path above
            // is the safety net, not the main mechanism.
            if (response.ok) {
              noteSuccess(servedBy)
              maybeRotate("quota-observed")
            }

            return preserveResponseUnchanged
              ? response
              : transformResponseStream(response)
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Switch Claude Code account",

          get prompts() {
            const currentAccounts = refreshAccountsList()
            const currentSource =
              loadPersistedAccountSource() ?? defaultAccountSource
            if (currentAccounts.length <= 1) return []
            // Read once per open, not once per row.
            const quotaCache = readQuotaCache()
            // Values shown come from the cache; this refreshes it for the next
            // open. The getter cannot await, so it cannot show its own result.
            topUpQuota("switcher-open")
            const cfgNow = getConfig()
            const autoRow: { label: string; value: string; hint?: string } = {
              label: `Auto — balance across accounts (${cfgNow.strategy})`,
              value: AUTO_SOURCE,
            }
            if (currentSource === AUTO_SOURCE) autoRow.hint = "active"

            // Presets first: an arrangement is usually what you want to switch
            // to, and picking one account out of several is the exception once
            // more than one is in play.
            const presetRows = Object.entries(cfgNow.presets).map(
              ([name, preset]) => {
                const value = `${PRESET_PREFIX}${name}`
                const count = preset.pools
                  ? preset.pools.reduce((n, p) => n + p.accounts.length, 0)
                  : (preset.accounts?.length ?? 0)
                const row: { label: string; value: string; hint?: string } = {
                  label: `${preset.label ?? name} — ${preset.strategy ?? cfgNow.strategy} over ${count}`,
                  value,
                }
                if (currentSource === value) row.hint = "active"
                return row
              },
            )

            return [
              {
                type: "select" as const,
                key: "account",
                message: "Select which Claude Code account to use:",
                // `hint` must be a string when present. Passing undefined fails
                // OpenCode's schema validation for the whole request --
                // /provider/auth answers 500, the TUI falls back to its built-in
                // "API key" prompt, and every account becomes unreachable. Omit
                // the key instead of setting it to undefined.
                options: [
                  ...presetRows,
                  autoRow,
                  ...currentAccounts.map((a) => {
                    const option: {
                      label: string
                      value: string
                      hint?: string
                    } = {
                      label: prefixWithQuota(a.label, a.source, quotaCache),
                      value: a.source,
                    }
                    if (a.source === currentSource) option.hint = "active"
                    return option
                  }),
                ],
              },
            ]
          },

          async authorize(inputs) {
            const latestAccounts = refreshAccountsList()

            // A preset and Auto differ only in which accounts are eligible, so
            // they share one path: persist the choice, let the strategy pick now.
            const chosenPreset = inputs?.account?.startsWith(PRESET_PREFIX)
              ? inputs.account.slice(PRESET_PREFIX.length)
              : null

            if (inputs?.account === AUTO_SOURCE || chosenPreset) {
              saveAccountSource(inputs!.account!)
              if (!getActiveAccount() && latestAccounts[0]) {
                setActiveAccountSource(latestAccounts[0].source)
              }
              maybeRotate(chosenPreset ? "switcher-preset" : "switcher-auto", {
                force: true,
              })

              const active =
                getActiveAccount() ?? latestAccounts[0] ?? accounts[0]
              const creds = getCachedCredentials() ?? active.credentials
              syncAuthJson(creds)

              const cfgNow = getConfig()
              const what = chosenPreset
                ? `Preset "${cfgNow.presets[chosenPreset]?.label ?? chosenPreset}"`
                : `Balancing across ${latestAccounts.length} accounts`
              const how = chosenPreset
                ? (cfgNow.presets[chosenPreset]?.strategy ?? cfgNow.strategy)
                : cfgNow.strategy

              return {
                url: "",
                instructions: `${what} (${how}) — currently ${active.label}.`,
                method: "auto",
                async callback() {
                  return {
                    type: "success",
                    provider: "anthropic",
                    access: creds.accessToken,
                    refresh: creds.refreshToken,
                    expires: creds.expiresAt,
                  }
                },
              }
            }

            const source =
              inputs?.account ?? latestAccounts[0]?.source ?? accounts[0].source
            const chosen =
              latestAccounts.find((a) => a.source === source) ??
              accounts.find((a) => a.source === source) ??
              latestAccounts[0] ??
              accounts[0]

            setActiveAccountSource(chosen.source)
            const creds = getCachedCredentials() ?? chosen.credentials

            syncAuthJson(creds)
            saveAccountSource(chosen.source)

            const sourceDescription =
              chosen.source === "file"
                ? `credentials file (${chosen.configDir ?? "~/.claude"}/.credentials.json)`
                : `macOS Keychain (${chosen.source})`

            return {
              url: "",
              instructions: `Using ${chosen.label} — credentials loaded from ${sourceDescription}.`,
              method: "auto",
              async callback() {
                return {
                  type: "success",
                  provider: "anthropic",
                  access: creds.accessToken,
                  refresh: creds.refreshToken,
                  expires: creds.expiresAt,
                }
              },
            }
          },
        },
      ],
    },
  }
}

export const ClaudeAuthPlugin = plugin as unknown as Plugin
export default ClaudeAuthPlugin
