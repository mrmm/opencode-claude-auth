/**
 * Everything the user actually sees: the account label, advisory toasts, and
 * the tools exposed to a session.
 *
 * Barrelled for the same reason as ./balance — one import line in shared files.
 */
export * from "./advisory.ts"
export * from "./display.ts"
