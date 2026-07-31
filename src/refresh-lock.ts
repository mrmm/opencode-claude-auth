/**
 * Cross-process coordination for token refresh.
 *
 * Refreshing rotates the refresh token and revokes the access tokens previously
 * issued for that account. With several OpenCode processes running, each holding
 * its own copy of the credentials in memory, that is mutually destructive:
 * process A refreshes, B and C are silently revoked, both refresh with a copy
 * that is now stale, and the cycle repeats. One log showed fifty refresh attempts
 * in an hour with zero successes.
 *
 * Two things prevent it, and both are needed:
 *
 *   1. Only one process refreshes an account at a time (this lock).
 *   2. Before refreshing, re-read the source -- the holder of the lock has very
 *      likely just written a perfectly good token, in which case nobody else
 *      needs to refresh at all.
 *
 * The lock is a file containing a pid and a timestamp. It is advisory: a stale
 * lock is broken after a timeout so a crashed process cannot wedge auth
 * permanently, which matters more here than strict mutual exclusion.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** A refresh that has not completed in this long is presumed dead. */
export const LOCK_STALE_MS = 30_000

export function lockDir(): string {
  return join(homedir(), ".local", "share", "opencode", "claude-auth-locks")
}

/** One lock per account, so unrelated accounts never block each other. */
export function lockPathFor(source: string, dir: string = lockDir()): string {
  const safe = source.replace(/[^A-Za-z0-9._-]/g, "_")
  return join(dir, `${safe}.lock`)
}

export type LockInfo = { pid: number; at: number }

export function readLock(path: string): LockInfo | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>
    if (typeof parsed?.pid !== "number" || typeof parsed?.at !== "number") {
      return null
    }
    return { pid: parsed.pid, at: parsed.at }
  } catch {
    return null
  }
}

/** Whether a lock should be disregarded: too old, or its owner is gone. */
export function isStale(
  lock: LockInfo | null,
  now: number = Date.now(),
  alive: (pid: number) => boolean = processAlive,
): boolean {
  if (!lock) return true
  if (now - lock.at > LOCK_STALE_MS) return true
  // Our own pid means a previous attempt in this process did not clean up.
  if (lock.pid === process.pid) return true
  return !alive(lock.pid)
}

export function processAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Try to take the lock for `source`.
 *
 * Returns a release function on success, or null when another live process holds
 * it. Never throws: if the lock cannot be written, refreshing unlocked is better
 * than not refreshing at all.
 */
export function acquireRefreshLock(
  source: string,
  options: {
    dir?: string
    now?: () => number
    alive?: (pid: number) => boolean
  } = {},
): (() => void) | null {
  const { dir = lockDir(), now = Date.now, alive = processAlive } = options
  const path = lockPathFor(source, dir)

  try {
    const existing = readLock(path)
    if (existing && !isStale(existing, now(), alive)) return null

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: now() }), "utf8")

    // Confirm we own it: a racing process may have written between the check
    // and the write. Last writer wins, and the loser backs off.
    const after = readLock(path)
    if (after?.pid !== process.pid) return null

    return () => {
      try {
        const current = readLock(path)
        if (current?.pid === process.pid) rmSync(path, { force: true })
      } catch {
        // A lock we cannot remove will be treated as stale soon enough.
      }
    }
  } catch {
    // Unable to coordinate; proceed rather than block authentication.
    return () => {}
  }
}
