/**
 * Tools the plugin registers with OpenCode.
 *
 * These are the `pnpm lb` / `pnpm usage` surfaces, reachable from inside a
 * session: they read and write the same selection file and usage log, so there
 * is one mechanism with two front doors rather than two implementations.
 *
 * They register through the plugin's own `tool` hook rather than a separate MCP
 * server. An MCP server would be a second process, its own lifecycle and its own
 * entry in `opencode.jsonc`, to expose functions that already live in this
 * process and read this plugin's state — the extra hop buys nothing.
 *
 * Two consequences worth being deliberate about, because they cut against
 * keeping the balancer invisible:
 *
 *   - every tool's description is in the model's context for the whole session,
 *   - the agent can call them, so it can move accounts on its own.
 *
 * Neither is free, which is why `"tools": false` turns the whole set off and
 * leaves the CLI. Selecting through these tools is still transparent in the way
 * that matters: it writes a file, so nothing is re-registered and nothing in
 * flight is cancelled — unlike choosing in `opencode auth login`.
 */

import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

import { assess, resolveRef } from "../balance/balancer.ts"
import { getConfig } from "../config.ts"
import {
  AUTO_SOURCE,
  PRESET_PREFIX,
  getActiveAccount,
  listAccounts,
  loadPersistedAccountSource,
  saveAccountSource,
} from "../credentials.ts"
import { formatQuotaPrefix, readQuotaCache } from "../balance/quota.ts"
import { parseWindowMs } from "./tools-format.ts"
import {
  credentialState,
  maybeRotate,
  resolveActiveConfig,
} from "../balance/rotate.ts"
import { readUsage, summarize } from "../balance/usage.ts"

const members = () =>
  listAccounts().map((a) => ({ source: a.source, label: a.label }))

function describeSelection(value: string | null): string {
  const cfg = getConfig()
  if (!value) return "none — the config decides"
  if (value === AUTO_SOURCE) return `auto (${cfg.strategy})`
  if (value.startsWith(PRESET_PREFIX)) {
    const name = value.slice(PRESET_PREFIX.length)
    const p = cfg.presets[name]
    return p
      ? `preset "${p.label ?? name}" (${p.strategy ?? cfg.strategy})`
      : `preset "${name}" — NOT DEFINED, so it is ignored`
  }
  return `pinned to ${members().find((m) => m.source === value)?.label ?? value}`
}

export const claudeAuthTools = {
  claude_auth_status: tool({
    description:
      "Report which Claude account is serving requests right now, what is selected (a preset, auto, or a pin), each account's quota, and whether automatic rotation is enabled. Read-only.",
    args: {},
    async execute() {
      const selection = loadPersistedAccountSource()
      const { cfg, preset } = resolveActiveConfig(getConfig(), selection)
      const active = getActiveAccount()
      const quota = readQuotaCache()

      // The balancer's own verdict, so this reports what would actually happen
      // rather than a figure the reader has to re-apply the rules to.
      const health = new Map(
        assess(
          listAccounts().map((a) => ({
            source: a.source,
            label: a.label,
            credential: credentialState(a),
          })),
          quota,
          cfg,
        ).map((h) => [h.source, h]),
      )

      const lines = [
        `serving now: ${active?.label ?? "none"}`,
        `selection:   ${describeSelection(selection)}`,
        `strategy:    ${cfg.strategy}${preset ? ` (from preset "${preset}")` : ""}`,
        `autoSwitch:  ${cfg.autoSwitch} — moves by itself at ${Math.round(cfg.switchAt * 100)}% of ${cfg.switchWindow}, on429 ${cfg.switchOn429}`,
        "",
        "accounts (* = serving now):",
      ]

      for (const m of members()) {
        const h = health.get(m.source)
        const verdict = h?.healthy ? "usable" : `unusable — ${h?.reason ?? "?"}`
        lines.push(
          `  ${m.source === active?.source ? "*" : " "} ${(m.label ?? m.source).padEnd(44)} ${(formatQuotaPrefix(quota[m.source]) || "[no reading]").padEnd(16)} ${verdict}`,
        )
      }

      const presets = Object.entries(cfg.presets)
      if (presets.length > 0) {
        lines.push("", "presets:")
        for (const [name, p] of presets) {
          const n = p.pools
            ? p.pools.reduce((t, x) => t + x.accounts.length, 0)
            : (p.accounts?.length ?? 0)
          lines.push(
            `  ${name.padEnd(20)} ${(p.strategy ?? cfg.strategy).padEnd(13)} ${n} accounts`,
          )
        }
      }

      return lines.join("\n")
    },
  }),

  claude_auth_select: tool({
    description:
      'Choose which Claude account serves requests: a preset name, an account (exact Keychain source or a unique fragment of its label), "auto" to let the strategy decide, or "clear" to fall back to the config. Applies to the next request without re-authenticating, so nothing in flight is cancelled.',
    args: {
      target: z
        .string()
        .describe(
          'preset name, account name or label fragment, "auto", or "clear"',
        ),
    },
    async execute({ target }) {
      const cfg = getConfig()
      const choice = target.trim()

      if (choice === "clear") {
        saveAccountSource("")
        maybeRotate("tool-clear", { force: true })
        return `Selection cleared — the config decides. Now on ${getActiveAccount()?.label ?? "none"}.`
      }

      if (choice === "auto") {
        saveAccountSource(AUTO_SOURCE)
        maybeRotate("tool-auto", { force: true })
        return `Auto (${cfg.strategy}). Now on ${getActiveAccount()?.label ?? "none"}.`
      }

      if (cfg.presets[choice]) {
        saveAccountSource(`${PRESET_PREFIX}${choice}`)
        maybeRotate("tool-preset", { force: true })
        const p = cfg.presets[choice]!
        return `Preset "${p.label ?? choice}" (${p.strategy ?? cfg.strategy}). Now on ${getActiveAccount()?.label ?? "none"}.`
      }

      const source = resolveRef(choice, members())
      if (!source) {
        const known = Object.keys(cfg.presets).join(", ") || "(none)"
        return `No preset or account matches "${choice}". Presets: ${known}. Accounts: ${members()
          .map((m) => m.label ?? m.source)
          .join(", ")}`
      }

      saveAccountSource(source)
      maybeRotate("tool-pin", { force: true })
      return `Pinned to ${members().find((m) => m.source === source)?.label ?? source}.`
    },
  }),

  claude_auth_usage: tool({
    description:
      "Report per-account Claude usage over a window: requests served, share, refusals, errors, average latency, and how often the balancer rotated. Read-only.",
    args: {
      window: z
        .string()
        .optional()
        .describe('time window such as "1h", "24h", "7d" (default 24h)'),
    },
    async execute({ window }) {
      const spec = window && /^\d+[smhd]$/.test(window) ? window : "24h"
      const since = Date.now() - parseWindowMs(window)
      const summary = summarize(readUsage(since), since)

      if (summary.accounts.length === 0) {
        return `No Claude requests recorded in the last ${spec}.`
      }

      const total = summary.accounts.reduce((n, a) => n + a.requests, 0)
      const lines = [`Per-account usage, last ${spec} (${total} requests)`, ""]
      for (const a of summary.accounts) {
        lines.push(
          `  ${a.account.slice(-30).padEnd(30)} ${String(a.requests).padStart(5)} ${`${Math.round((a.requests / total) * 100)}%`.padStart(5)}  429:${a.refusals} err:${a.errors} avg:${a.avg_duration_ms}ms`,
        )
      }
      lines.push("", `rotations: ${summary.rotations}`)
      for (const [trigger, n] of Object.entries(summary.by_trigger)) {
        lines.push(`  ${trigger}: ${n}`)
      }

      return lines.join("\n")
    },
  }),
}
