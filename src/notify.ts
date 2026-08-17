/**
 * A seam between the credential layer and the UI.
 *
 * Refreshing is synchronous and knows nothing about a client; raising a toast is
 * asynchronous and needs one. Rather than thread a client through the credential
 * code, notable moments are emitted here and whoever can render them subscribes.
 *
 * These are the moments the log showed you cannot see from inside a session: a
 * refresh failing (2,873 times before it was fixed), and the plugin quietly
 * serving a *different* account because the intended one could not be refreshed
 * (304 times). Both change which credentials your requests use, so both are
 * worth surfacing rather than leaving in a file.
 */

export type Notice =
  | {
      kind: "refresh-succeeded"
      source: string
      /** Minutes of validity gained; 0 when the expiry did not move. */
      extendedByMinutes: number
      via: string
    }
  | {
      kind: "refresh-failed"
      source: string
      reason: string
    }
  | {
      kind: "account-switched"
      /** The account that could not be refreshed. */
      failedSource: string
      /** The account actually serving requests now. */
      usedSource: string
    }
  | {
      /**
       * The balancer moved on purpose. Distinct from `account-switched`, which
       * reports a broken credential: here the previous account was fine, it was
       * simply spent, and saying "could not be refreshed" would be untrue.
       */
      kind: "account-rotated"
      fromSource: string
      toSource: string
      /** Already human-readable, e.g. "at 96% of 5h". */
      reason: string
      pool: string
      strategy: string
    }
  | {
      /** Every account is spent; the plugin stayed put rather than thrash. */
      kind: "accounts-exhausted"
      /** The account whose window frees up first. */
      soonestSource: string
      /** Unix seconds it frees up, when known. */
      resetsAt?: number
    }

export type NoticeSink = (notice: Notice) => void

let sink: NoticeSink | null = null

export function setNoticeSink(fn: NoticeSink | null): void {
  sink = fn
}

export function clearNoticeSink(): void {
  sink = null
}

/**
 * Emit a notice. Never throws and never blocks: this runs inside the credential
 * path, where a failed notification must not become a failed refresh.
 */
export function emitNotice(notice: Notice): void {
  if (!sink) return
  try {
    sink(notice)
  } catch {
    // A sink that throws is the sink's problem, not the caller's.
  }
}
