import { log } from "./logger.ts"
import {
  DEFAULT_PLACEMENT,
  isAccountLabelPlacement,
  type AccountLabelPlacement,
} from "./display.ts"

/**
 * Plugin settings that can be set via opencode.json as an alternative
 * to environment variables.
 *
 * Priority: environment variable > opencode.json config > hardcoded default
 *
 * In opencode.json (project-level or ~/.config/opencode/opencode.json):
 *
 * ```json
 * {
 *   "agent": {
 *     "build": {
 *       "enable1mContext": true
 *     }
 *   }
 * }
 * ```
 */
export interface PluginSettings {
  enable1mContext?: boolean
  /** Where to show the active Claude account: provider | model | both | off. */
  accountLabel?: AccountLabelPlacement
}

let settings: PluginSettings = {}

/**
 * Extract plugin settings from the opencode Config object.
 *
 * Scans all agent configs for our plugin-specific keys. AgentConfig has
 * a catch-all `[key: string]: unknown` index signature, so arbitrary
 * keys placed in agent configs are preserved through OpenCode's
 * config parser and passed to the plugin via the `config` hook.
 *
 * NOTE: OpenCode's Zod schema may relocate unknown top-level agent keys
 * into `agent.options`. We check both locations defensively so this
 * survives future config parser changes.
 *
 * The first boolean value found (in any agent) wins — even if `false`.
 */
export function applyOpencodeConfig(config: unknown): void {
  if (!config || typeof config !== "object") return

  const cfg = config as Record<string, unknown>
  const agents = cfg.agent as Record<string, unknown> | undefined

  if (!agents || typeof agents !== "object") return

  for (const agentConfig of Object.values(agents)) {
    if (!agentConfig || typeof agentConfig !== "object") continue
    const agent = agentConfig as Record<string, unknown>
    const options = agent.options as Record<string, unknown> | undefined

    // Check top-level first, then fall back to options (where OpenCode's
    // Zod transform may relocate unknown keys)
    if (settings.enable1mContext === undefined) {
      const val = agent.enable1mContext ?? options?.enable1mContext
      if (typeof val === "boolean") {
        settings.enable1mContext = val
        log("config_loaded", { enable1mContext: val })
      } else if (val !== undefined) {
        log("config_invalid_type", {
          key: "enable1mContext",
          expectedType: "boolean",
          actualType: typeof val,
        })
      }
    }

    if (settings.accountLabel === undefined) {
      const val = agent.accountLabel ?? options?.accountLabel
      if (isAccountLabelPlacement(val)) {
        settings.accountLabel = val
        log("config_loaded", { accountLabel: val })
      } else if (val !== undefined) {
        log("config_invalid_value", {
          key: "accountLabel",
          expected: "provider | model | both | off",
          actual: String(val),
        })
      }
    }
  }

  if (
    settings.enable1mContext === undefined &&
    settings.accountLabel === undefined
  ) {
    log("config_no_plugin_keys", {
      agentCount: Object.keys(agents).length,
    })
  }
}

/**
 * Whether 1M context should be enabled.
 *
 * Priority: ANTHROPIC_ENABLE_1M_CONTEXT env var > opencode.json > false
 */
export function isEnable1mContext(): boolean {
  const envVal = process.env.ANTHROPIC_ENABLE_1M_CONTEXT
  if (envVal !== undefined) return envVal === "true"
  return settings.enable1mContext === true
}

/**
 * Where the active account label should be shown.
 *
 * Priority: CLAUDE_AUTH_ACCOUNT_LABEL env var > opencode.json > "both".
 */
export function getAccountLabelPlacement(): AccountLabelPlacement {
  const envVal = process.env.CLAUDE_AUTH_ACCOUNT_LABEL
  if (isAccountLabelPlacement(envVal)) return envVal
  return settings.accountLabel ?? DEFAULT_PLACEMENT
}

export function resetPluginSettings(): void {
  settings = {}
}

export function getPluginSettings(): Readonly<PluginSettings> {
  return { ...settings }
}
