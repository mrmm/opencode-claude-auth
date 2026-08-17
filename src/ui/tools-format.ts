/**
 * The parts of the tools that are just logic.
 *
 * Split out from tools.ts because that module statically imports
 * @opencode-ai/plugin for its `tool()` helper, and anything importing it drags
 * the SDK into the module graph — which silently cancels node:test subtests.
 * Keeping the decisions here means they can be asserted; tools.ts is left as
 * thin glue between those decisions and the SDK.
 */

export type SelectionKind =
  | { kind: "none" }
  | { kind: "auto" }
  | { kind: "preset"; name: string; known: boolean }
  | { kind: "pin"; source: string }

export const AUTO = "__auto__"
export const PRESET = "preset:"

export function classifySelection(
  value: string | null,
  knownPresets: readonly string[],
): SelectionKind {
  if (!value) return { kind: "none" }
  if (value === AUTO) return { kind: "auto" }
  if (value.startsWith(PRESET)) {
    const name = value.slice(PRESET.length)
    return { kind: "preset", name, known: knownPresets.includes(name) }
  }
  return { kind: "pin", source: value }
}

/**
 * Parse a window like "24h". Anything unrecognised falls back rather than
 * throwing: a malformed argument from a model should produce a sane report, not
 * an error the model then has to reason about.
 */
export function parseWindowMs(
  spec: string | undefined,
  fallback = "24h",
): number {
  const units: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }
  const use = spec && /^\d+[smhd]$/.test(spec) ? spec : fallback
  const n = Number.parseInt(use, 10)
  const unit = units[use.slice(-1)] ?? units.h!
  return n * unit
}
