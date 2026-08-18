/**
 * Surfacing the active Claude account in the OpenCode UI.
 *
 * The account switcher already labels each account (e.g. "Claude Team - Jack
 * Test"), but that label is only visible while the switcher is open. Once a
 * session is running there is nothing on screen saying which account is
 * serving it, which matters when several are configured and they differ in
 * plan or rate limits.
 *
 * Both `Provider.name` and `Model.name` are rendered by the TUI, so the label
 * is appended to one or both. The same label the switcher shows is reused
 * rather than inventing a second scheme, so the two always agree.
 */

/** Where the active account label should appear. */
export type AccountLabelPlacement = "provider" | "model" | "both" | "off"

export const DEFAULT_PLACEMENT: AccountLabelPlacement = "both"

const PLACEMENTS = new Set<string>(["provider", "model", "both", "off"])

export function isAccountLabelPlacement(
  value: unknown,
): value is AccountLabelPlacement {
  return typeof value === "string" && PLACEMENTS.has(value)
}

/**
 * Marker introducing the account label.
 *
 * A bare "(...)" suffix cannot be told apart from a name that legitimately ends
 * in parentheses -- "Claude Haiku 4.5 (latest)" is a real model name, and
 * treating it as a stale label silently ate the "(latest)". The marker makes
 * detection exact and also tells the reader what the text means.
 */
const MARKER = "acct: "

// Must match every marker this module can write. When it only knew "acct:",
// adding an "LB:" marker made the two accumulate instead of replacing.
const LABEL_SUFFIX = /\s\((?:acct|LB): [^()]*\)$/

/**
 * Append `label` to `name` as a marked, parenthesised suffix.
 *
 * Idempotent: config can be loaded more than once, and a plain append would
 * compound the suffix each time. Returns `name` unchanged when the label is
 * empty or already present.
 */
export function decorateName(name: string, label: string): string {
  // A provider or model without a name is not worth crashing over: this is a
  // cosmetic label, and the auth loader it runs inside must keep working.
  if (typeof name !== "string") return name
  const trimmed = typeof label === "string" ? label.trim() : ""
  if (!trimmed) return name

  // A caller may supply its own marker ("LB: ..."), because what is being named
  // is not always an account: with balancing on there is no single account, and
  // labelling an arrangement "acct:" would be a small lie in the one place the
  // user looks to see what is serving them.
  const carriesMarker = /^[a-z]+:\s/i.test(trimmed)
  const suffix = carriesMarker ? ` (${trimmed})` : ` (${MARKER}${trimmed})`
  if (name.endsWith(suffix)) return name

  // A different label was applied earlier -- the user switched accounts. Replace
  // ours; anything else in trailing parentheses is the name's own text.
  if (LABEL_SUFFIX.test(name)) return name.replace(LABEL_SUFFIX, suffix)

  return name + suffix
}

export function shouldDecorateProvider(p: AccountLabelPlacement): boolean {
  return p === "provider" || p === "both"
}

export function shouldDecorateModel(p: AccountLabelPlacement): boolean {
  return p === "model" || p === "both"
}

/**
 * Apply the label to the OpenCode *config* object.
 *
 * The auth loader is handed a provider object that is not the one served to the
 * UI: decorating it reported success while `/config/providers` kept returning
 * the undecorated name. Config is the seam that actually reaches the model
 * picker and status line.
 *
 * Only `name` is written, and only under the given provider id, so an existing
 * user configuration is left otherwise intact.
 */
export function applyAccountLabelToConfig(
  config: unknown,
  label: string,
  placement: AccountLabelPlacement = DEFAULT_PLACEMENT,
  providerId = "anthropic",
): { provider: boolean; models: number } {
  const result = { provider: false, models: 0 }
  if (placement === "off") return result
  if (typeof label !== "string" || !label.trim()) return result
  if (!config || typeof config !== "object") return result

  const cfg = config as Record<string, unknown>
  const providers = (cfg.provider ??= {}) as Record<string, unknown>
  const entry = (providers[providerId] ??= {}) as Record<string, unknown>

  if (shouldDecorateProvider(placement)) {
    const base = typeof entry.name === "string" ? entry.name : "Anthropic"
    const next = decorateName(base, label)
    if (next !== entry.name) {
      entry.name = next
      result.provider = true
    }
  }

  // Models are only renamed where the user already declared them; inventing
  // entries here would add models that do not exist for this account.
  if (shouldDecorateModel(placement)) {
    const models = entry.models as Record<string, unknown> | undefined
    if (models && typeof models === "object") {
      for (const model of Object.values(models)) {
        if (!model || typeof model !== "object") continue
        const m = model as Record<string, unknown>
        if (typeof m.name !== "string") continue
        const next = decorateName(m.name, label)
        if (next !== m.name) {
          m.name = next
          result.models++
        }
      }
    }
  }

  return result
}

/**
 * Where the active account label should appear.
 *
 * Resolved through the config layers (file, inline, environment) rather than
 * read from the environment directly, so it can be changed without a restart.
 * Imported lazily to keep display.ts free of a cycle: config.ts needs the
 * placement validator from here.
 */
export function getAccountLabelPlacement(): AccountLabelPlacement {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require("./config.ts") as {
      getConfig: () => { accountLabel: AccountLabelPlacement }
    }
    return getConfig().accountLabel
  } catch {
    return DEFAULT_PLACEMENT
  }
}
