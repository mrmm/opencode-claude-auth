# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)
[![Socket Badge](https://socket.dev/api/badge/npm/package/opencode-claude-auth)](https://socket.dev/npm/package/opencode-claude-auth)

Self-contained Anthropic auth provider for OpenCode using your Claude Code credentials — no separate login or API key needed.

## How it works

The plugin registers its own auth provider with a custom fetch handler that intercepts all Anthropic API requests. It reads OAuth tokens from the macOS Keychain (or `~/.claude/.credentials.json` — or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set — on other platforms), caches them in memory with a 30-second TTL, and handles the full request lifecycle — no builtin Anthropic auth plugin required. On macOS, multiple Claude Code accounts are detected automatically and can be switched via `opencode auth login`.

It also syncs credentials to OpenCode's `auth.json` as a fallback (on Windows, it writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json` to cover all installation methods). If a token is near expiry, it refreshes directly via Anthropic's OAuth endpoint (zero LLM tokens consumed), falling back to the Claude CLI if the direct refresh fails. Background re-sync runs every 5 minutes.

## Prerequisites

- Claude Code installed and authenticated (run `claude` at least once)
- OpenCode installed

macOS is preferred (uses Keychain). Linux and Windows work via the credentials file fallback.

## Installation

**For Humans**

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-claude-auth plugin and configure it by following: https://raw.githubusercontent.com/griffinmartin/opencode-claude-auth/main/installation.md
```

**Option B: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugin": ["opencode-claude-auth@latest"]
   }
   ```

   > The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

2. **Use it** — just run OpenCode. The plugin handles auth automatically using your Claude Code credentials.

**For LLM Agents**

See [installation.md](installation.md) for step-by-step agent instructions.

## Usage

Just run OpenCode. The plugin handles auth automatically — it reads your Claude Code credentials, provides them to the Anthropic API, and refreshes them in the background. If your credentials aren't OAuth-based, the plugin falls through to standard API key auth.

## Supported models

13 supported models. Run `pnpm run test:models` to verify against your account.

| Model                      |
| -------------------------- |
| claude-fable-5             |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-opus-4-7            |
| claude-opus-4-8            |
| claude-opus-5              |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |
| claude-sonnet-5            |

## Credential sources

The plugin checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms; if `CLAUDE_CONFIG_DIR` is set, reads `$CLAUDE_CONFIG_DIR/.credentials.json` instead)

## Multiple accounts (macOS)

If you have [multiple Claude Code accounts](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2) authenticated on macOS, the plugin detects all of them from the Keychain automatically. Each account is labeled by its subscription tier (Claude Pro, Claude Max, etc.).

To switch accounts:

```bash
opencode auth login
```

Select "Switch Claude Code account" and pick the account you want to use. Your selection is persisted across sessions.

If only one account is found, the switcher is hidden and the plugin uses it directly.

## Balancing across accounts

The switcher's first row is **Auto — balance across accounts**. Pick it and the
plugin chooses the account itself, moving off one when it runs out of quota.
Pick a named account instead and that choice is pinned and persisted, exactly as
before.

Switching is hot. The access token is resolved per request, so a move takes
effect on the very next call — no provider reload, no OpenCode restart. Nothing
rotates until you turn it on:

```jsonc
{
  "autoSwitch": true, // off by default
  "switchAt": 0.95, // abandon an account at this utilisation
  "switchWindow": "binding", // "5h" | "7d" | "binding" (whichever is closer to its limit)
  "switchOn429": true, // also move when Anthropic actually refuses
  "strategy": "sticky",
}
```

### Strategies

| Strategy       | Chooses                                          |
| -------------- | ------------------------------------------------ |
| `sticky`       | the current account until it is spent (default)  |
| `priority`     | the first listed that is usable                  |
| `least-loaded` | whichever has the most quota headroom            |
| `least-used`   | whichever has served fewest requests (usage log) |
| `round-robin`  | the next one each time, in listed order          |
| `weighted`     | by `weights`, interleaved (smooth weighted RR)   |
| `random`       | uniform choice                                   |
| `p2c`          | samples two at random, keeps the emptier         |

`least-loaded` reads Anthropic's view of consumption; `least-used` reads ours.
They differ usefully: utilisation is weighted by how expensive each request was
and a request count is not, so one spreads spend and the other spreads turns.
`p2c` avoids the herd effect when several OpenCode windows decide independently
and would otherwise all pile onto whichever account currently looks emptiest.

**List order is priority order.** `priority` takes the first usable account,
`round-robin` walks them in that order, and ties break that way throughout.

The rotating strategies keep their cursor **per process**, so a series of short
`opencode run` invocations each start at the first account; spreading happens
across the requests within one session.

`sticky` is the default on purpose: Anthropic's prompt cache is **per account**,
so every move starts the new account's cache cold. The rotating strategies
spread load at the cost of cache hits — worth it when headroom matters more than
latency and input-token spend, and a bad trade otherwise.

### Pools and fallback

Pools are failover tiers, tried in order. A tier is only reached when every
account above it is spent, so "balance across these two, fall back to that one"
is:

```jsonc
{
  "autoSwitch": true,
  "pools": [
    {
      "name": "primary",
      "strategy": "least-loaded",
      "accounts": [
        "Claude Code-credentials-aaaa1111",
        "Claude Code-credentials-bbbb2222",
      ],
    },
    { "name": "reserve", "accounts": ["Claude Code-credentials"] },
  ],
}
```

A pool may override `strategy` and set per-account `weights`. Omit `pools`
entirely and every account forms one tier; set `accounts` instead to use a
subset, in preference order. Account names are Keychain sources — the values
`opencode auth login` shows, listable with
`security dump-keychain | grep 'Claude Code'`.

### Presets

A preset is a named arrangement — which accounts, in what order, under which
strategy — offered as a row in `opencode auth login` above the individual
accounts. Selecting one is remembered, and beats `preset` in the config.

```jsonc
"presets": {
  "rr-12": {
    "label": "LB round-robin Team 1,2",
    "strategy": "round-robin",
    "accounts": ["Team A", "Team B"]
  },
  "tiered": {
    "label": "Team 1+2, fall back to Team 3",
    "pools": [
      { "name": "primary", "strategy": "least-loaded", "accounts": ["Team A", "Team B"] },
      { "name": "reserve", "accounts": ["Team C"] }
    ]
  }
},
"preset": ""
```

An account is named either by its exact Keychain source or by any **unique
fragment of its label**, which is why the above reads `Team B` rather than
`Claude Code-credentials-bbbb2222`. A fragment matching more than one account is
refused rather than guessed. A preset declares either `accounts` or `pools`,
never both, so the effective set never depends on settings the preset did not
mention. An unknown preset name is ignored rather than fatal — a typo must not
silently narrow which accounts may serve requests.

`CLAUDE_AUTH_PRESET=<name>` selects one for a single run.

### Usage telemetry

Every response is recorded — which account served it, the model, status,
duration, and the utilisation the headers reported — to
`~/.local/share/opencode/claude-auth-usage.jsonl`, along with every rotation.
The quota cache holds only the newest reading per account, so it answers "how
full is this account" but never "how much has it served, and how often was it
refused".

```
pnpm usage            # last 24h
pnpm usage -- 7d      # last 7 days
pnpm usage -- 1h --json
```

```
account                               reqs    share    429    err       avg     quota  last used
Claude Code-credentials-cccc3333         4      40%      0      0     835ms        0%  3m ago
Claude Code-credentials-aaaa1111         3      30%      0      0     718ms       97%  12s ago
Claude Code-credentials-bbbb2222         3      30%      0      0    1007ms        2%  9s ago

rotations: 11
  startup: 5
  quota-observed: 6
```

Storage is append-only JSONL rather than SQLite, unlike the token-optimizer
plugin: this plugin has no runtime dependencies and keeps none, and it is loaded
by OpenCode, which ships as a Bun binary, while its own tests run under
`node --test`. A native SQLite module risks failing to load in the first, and
`bun:sqlite` does not exist in the second. The file is capped and rolls over to
`.1`; `least-used` reads it through a 30s cache so telemetry never costs more
than the thing it measures.

### When an account is spent

Health is derived from the rate-limit headers Anthropic returns on every
response, so nothing extra is stored and nothing expires by guesswork: an
account is spent when `utilization >= switchAt` or the server says `rejected`,
and it is healthy again once the window's own reset time passes. A refusal that
arrives without a reset time gets a bounded ejection instead, backing off on
each consecutive failure (`ejectFor`, default 5m).

When every account in every tier is spent, the plugin stays put rather than
thrashing — moving would only start a cold prompt cache on an account that will
refuse the request too. That decision is recorded as `rotate_skipped_all_spent`
in the debug log, naming the account that frees up first; the existing quota
advisory toast is what surfaces it on screen.

Rotation is evaluated after each response and after a refusal, so a spent
account is noticed on the next request rather than while the session sits idle.

Every automatic move raises a toast naming the new account, because the
provider/model label is applied once when OpenCode loads its config and cannot
be rewritten mid-session — without the toast the switch would be invisible.

A rotation is deliberately **not** persisted. The file behind the switcher holds
the account _you_ chose; letting one OpenCode window's exhaustion rewrite it
would move every other window too, and would erase a pin you set on purpose.

## Troubleshooting

| Problem                                             | Solution                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| "Credentials not found"                             | Run `claude` to authenticate with Claude Code first                                                                                       |
| "Keychain is locked"                                | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                                                      |
| "Token expired and refresh failed"                  | The plugin runs `claude` CLI to refresh automatically. If this fails, re-authenticate manually by running `claude`                        |
| Not working on Linux/Windows                        | Ensure `~/.claude/.credentials.json` exists (or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set). Run `claude` to create it |
| Keychain access denied                              | Grant access when macOS prompts you                                                                                                       |
| Keychain read timed out                             | Restart Keychain Access (can happen on macOS Tahoe)                                                                                       |
| "Credentials are unavailable or expired"            | Run `claude` to refresh your Claude Code credentials                                                                                      |
| "Extra usage is required for long context requests" | Your conversation exceeded 200k tokens. See [Long context (1M)](#long-context-1m) below                                                   |
| Plugin not updating to latest version               | Delete the cached package: `rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/` then restart OpenCode                         |

### Diagnostic logging

If you're hitting auth errors that are hard to reproduce, enable debug logging to capture the full auth flow:

```bash
export CLAUDE_AUTH_DEBUG=1
```

Restart OpenCode and reproduce the issue. The plugin writes structured JSON logs to `~/.local/share/opencode/claude-auth-debug.log`. All secrets (tokens, API keys) are automatically redacted — the log file is safe to paste into a GitHub issue.

To write logs to a custom path:

```bash
export CLAUDE_AUTH_DEBUG=/tmp/claude-auth-debug.log
```

Disable when done:

```bash
unset CLAUDE_AUTH_DEBUG
```

## Configuration

Settings live in `~/.config/opencode/claude-auth.jsonc`. Edits apply within a
few seconds — no new shell, no OpenCode restart, which is the main reason to
prefer it over environment variables.

```jsonc
{
  "debug": true, // true, false, or a log file path
  "logLevel": "info", // info | warn | error
  "logEvents": "", // "refresh,quota", "*_failed", "-keychain", "errors"
  "logMaxSize": "5MB",
  "logKeep": 3,
  "quotaProbe": true, // fill every switcher row with quota
  "toastOnRefresh": false, // failures always toast; this adds successes
  "accountLabel": "both", // provider | model | both | off
}
```

Precedence, least specific first:

1. defaults
2. `~/.config/opencode/claude-auth.jsonc`
3. `<project>/claude-auth.jsonc`
4. inline options in `opencode.jsonc` — `["...opencode-claude-auth", { "quotaProbe": true }]`
5. `CLAUDE_AUTH_*` environment variables

Environment stays highest so a single command can override without editing
anything (`CLAUDE_AUTH_DEBUG_EVENTS=refresh opencode`), but it is no longer
where configuration is expected to live. A malformed file contributes nothing
rather than failing the plugin.

### Log format

Each line is one JSON object with a fixed envelope, so a log can be filtered and
aggregated without knowing the event vocabulary:

```json
{
  "v": 1,
  "ts": "2026-07-30T16:38:47.440Z",
  "sid": "0ehcaahc",
  "level": "info",
  "group": "keychain",
  "event": "keychain_list",
  "servicesFound": ["..."]
}
```

| field   | meaning                                                        |
| ------- | -------------------------------------------------------------- |
| `v`     | schema version                                                 |
| `sid`   | per-process id — several opencode processes append to one file |
| `level` | `info` / `warn` / `error`, derived from the event name         |
| `group` | event family (`refresh`, `keychain`, `quota`, …)               |

`CLAUDE_AUTH_DEBUG_LEVEL=warn` (or `error`) drops everything below that level.

### Choosing what to log

A start-up logs around thirty lines across a dozen event types, most of which are
irrelevant to any given question — a single keychain read alone fires eight times.
`CLAUDE_AUTH_DEBUG_EVENTS` narrows it to a comma-separated list of patterns:

```bash
export CLAUDE_AUTH_DEBUG_EVENTS=quota              # one group
export CLAUDE_AUTH_DEBUG_EVENTS=refresh,quota      # several
export CLAUDE_AUTH_DEBUG_EVENTS='*_failed'         # glob on the whole name
export CLAUDE_AUTH_DEBUG_EVENTS=errors             # alias: failure-shaped events
export CLAUDE_AUTH_DEBUG_EVENTS=-keychain,-cache   # everything except these
export CLAUDE_AUTH_DEBUG_EVENTS=refresh,-refresh_started
```

A bare name matches its whole group, so `refresh` covers `refresh_started`,
`refresh_success` and so on — but not `proactive_refresh_check`, which is its own
group. Exclusions (`-` or `!`) always win. Leaving the variable unset logs
everything, so existing setups are unchanged.

Groups: `account`, `auth`, `cache`, `credentials`, `fetch`, `keychain`, `plugin`,
`proactive_refresh`, `quota`, `refresh`, `sync`, `writeback`.

Logs are written to a file, never to the terminal, so they cannot corrupt the TUI.

### Notifications

Some credential events change which account serves your requests without any
action on your part, and were previously visible only in the log. These raise a
toast:

- a refresh that failed on every path,
- a silent fallback to a different account because the intended one could not be
  refreshed.

A successful refresh is routine and stays quiet unless
`CLAUDE_AUTH_TOAST_REFRESH=1` is set. Repeats of the same condition are
suppressed for ten minutes, so a persistent failure notifies once rather than
every sync tick.

## Long context (1M)

1M token context is supported natively — the API no longer requires a beta flag for it, so the plugin doesn't send the legacy `context-1m-2025-08-07` header.

If your plan doesn't cover long context billing, requests beyond the standard window fail with "Extra usage is required for long context requests". When a long context error is caused by a beta flag (e.g. one added via `ANTHROPIC_BETA_FLAGS`), the plugin retries without the offending flag.

## Validating OAuth refresh

To verify the direct OAuth token refresh works with your credentials:

```bash
pnpm run validate:oauth           # refresh + write-back (safe, keeps credentials valid)
pnpm run validate:oauth -- --dry-run  # show what would be sent without making the request
```

This reads your stored credentials, calls Anthropic's OAuth token endpoint, and writes the new tokens back to storage. Refresh tokens rotate on each use, so write-back is enabled by default to keep your stored credentials valid.

## Environment variable overrides

All configurable parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable                            | Description                                                                                                                                                                            | Default                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ANTHROPIC_CLI_VERSION`             | Claude CLI version for user-agent and billing headers                                                                                                                                  | `config.ccVersion` in [`src/model-config.ts`](src/model-config.ts) |
| `ANTHROPIC_USER_AGENT`              | Full User-Agent string (overrides CLI version)                                                                                                                                         | `claude-cli/{version} (external, sdk-cli)`                         |
| `ANTHROPIC_BETA_FLAGS`              | Comma-separated beta feature flags                                                                                                                                                     | `baseBetas` list in [`src/model-config.ts`](src/model-config.ts)   |
| `CLAUDE_AUTH_DEBUG`                 | Enable diagnostic logging (`1` for default path, or a custom file path)                                                                                                                | disabled                                                           |
| `CLAUDE_CONFIG_DIR`                 | Claude Code config directory used for the credentials-file fallback (reads `$CLAUDE_CONFIG_DIR/.credentials.json`). macOS still checks the Keychain first.                             | `~/.claude`                                                        |
| `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS` | Max ms the plugin waits when honouring a 429/529 `retry-after` header. Beyond this cap the response surfaces immediately so OpenCode doesn't appear to hang on hour-long quota resets. | `30000`                                                            |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
```

## How it works (technical)

- Registers an `auth.loader` with a custom `fetch` that intercepts all Anthropic API requests
- Sets `Authorization: Bearer` with fresh OAuth tokens (cached in memory, 30s TTL, updated in-place after refresh)
- Translates tool names between OpenCode and Anthropic API formats (adds/strips `mcp_` prefix)
- Buffers SSE response streams at event boundaries for reliable tool name translation
- Injects Claude Code identity into system prompts via `experimental.chat.system.transform`
- Sets required API headers (beta flags, billing, user-agent) with model-aware selection
- On macOS, enumerates all `Claude Code-credentials*` Keychain entries and labels them by subscription tier
- Provides an account switcher via `opencode auth login` when multiple accounts are found; persists selection to `~/.local/share/opencode/claude-account-source.txt`
- Syncs credentials to `auth.json` on startup and every 5 minutes as a fallback (sync never triggers refresh; refresh is lazy, only on API requests)
- On Windows, writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json`
- Retries API requests on 429 (rate limit) and 529 (overloaded) with exponential backoff, respecting `retry-after` headers
- When a token is within 60 seconds of expiry, refreshes directly via `POST https://claude.ai/v1/oauth/token` (no LLM tokens consumed). Falls back to `claude` CLI if the direct refresh fails. New tokens are written back to Keychain (macOS) or credentials file (Linux/Windows) to keep stored credentials in sync with rotated refresh tokens
- If credentials aren't OAuth-based, the auth loader returns `{}` and falls through to API key auth
- If credentials are unavailable or unreadable, the plugin disables itself and OpenCode continues without Claude auth

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
