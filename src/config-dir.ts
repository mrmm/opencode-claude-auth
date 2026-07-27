/**
 * Mapping a Keychain credential entry back to the CLAUDE_CONFIG_DIR that owns it.
 *
 * Claude Code names its Keychain item after the config directory in use:
 *
 *   service = "Claude Code-credentials-" + sha256(CLAUDE_CONFIG_DIR).slice(0, 8)
 *
 * with the directory including its trailing slash. Verified against a live
 * multi-account setup:
 *
 *   sha256("~/.claude-team-1/") -> 780bcd9b
 *   sha256("~/.claude-team-2/") -> 04bd82dd
 *   sha256("~/.claude-team-3/") -> e534bce6
 *
 * The default directory (~/.claude) uses the unsuffixed service name.
 *
 * This matters for the CLI refresh fallback. Running bare `claude` refreshes
 * whichever account the default config points at, so with several accounts
 * configured it would refresh the wrong one -- silently, since the command
 * succeeds either way. Pointing CLAUDE_CONFIG_DIR at the owning directory makes
 * the refresh hit the intended account.
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const PRIMARY_SERVICE = "Claude Code-credentials"

/** The Keychain service name Claude Code uses for a given config directory. */
export function serviceForConfigDir(configDir: string): string {
  const withSlash = configDir.endsWith("/") ? configDir : `${configDir}/`
  const hash = createHash("sha256").update(withSlash).digest("hex").slice(0, 8)
  return `${PRIMARY_SERVICE}-${hash}`
}

/** The 8-hex discriminator in a service name, or null for the default entry. */
export function suffixOfService(service: string): string | null {
  const m = /^Claude Code-credentials-([0-9a-f]{8})$/.exec(service ?? "")
  return m ? m[1] : null
}

/**
 * Candidate config directories: every `.claude*` directory in the home folder.
 *
 * Derived rather than configured, so a newly added account is picked up without
 * touching this plugin.
 */
export function candidateConfigDirs(home: string = homedir()): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(".claude"))
      .map((e) => join(home, e.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * The config directory owning `service`, or null when it cannot be identified.
 *
 * Null is meaningful: refreshing with the wrong directory is worse than not
 * refreshing, because it consumes tokens and leaves the target still expired
 * while appearing to have succeeded.
 */
export function configDirForService(
  service: string,
  dirs: string[] = candidateConfigDirs(),
): string | null {
  const suffix = suffixOfService(service)
  if (!suffix) {
    // The default entry belongs to ~/.claude, if that is where it lives.
    const fallback = join(homedir(), ".claude")
    return existsSync(fallback) ? fallback : null
  }

  for (const dir of dirs) {
    if (serviceForConfigDir(dir).endsWith(suffix)) return dir
  }
  return null
}
