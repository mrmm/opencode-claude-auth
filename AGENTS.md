# Contributing rules

Read `llms.txt` first for what the modules are. This file is what a change must
obey. Every rule here is checked by `pnpm check:structure`, which runs as part of
`pnpm lint`; a rule that is only written down is a rule that rots.

## 1. This is a fork, and layout follows from that

`upstream` is `griffinmartin/opencode-claude-auth` and it is active — it ships
OAuth and compatibility fixes you want. Every merge is cheap or expensive
depending on how much of _its_ files you moved or rewrote.

- **Never move or rename a file that exists upstream.** A path rename plus a
  content change is the worst possible merge case, and it is paid on every pull,
  forever. `check:structure` fails if an upstream-owned file leaves `src/`'s root.
- **Prefer adding a module over editing one upstream owns.** New behaviour goes
  in `src/balance/` or `src/ui/`, which upstream has never heard of and therefore
  cannot conflict with.
- **When you must touch a shared file, keep the footprint to one line.** That is
  what the barrels are for: `src/index.ts` reaches the whole balancing domain
  through `./balance/…` rather than four separate imports.
- Check divergence before starting anything large:
  `git fetch upstream && git rev-list --count HEAD..upstream/main`.

## 2. Module layout

```
src/
  index.ts          plugin entry — upstream-owned, keep edits small
  config.ts         layered config; imported by nearly everything
  logger.ts         structured logging + redaction
  credentials.ts keychain.ts refresh-lock.ts signing.ts    upstream: credentials
  transforms.ts betas.ts model-config.ts                   upstream: request shaping
  notify.ts         notice types — root, because credentials.ts imports it
  balance/          fork-owned: who serves the next request
  ui/               fork-owned: what the operator sees
```

- A module does one thing and says so in a header comment explaining **why** it
  exists, not what each function does.
- **Decide in pure functions, act in a thin shell.** `balance/balancer.ts` takes
  `(members, quota, config, now)` and returns a decision; `balance/rotate.ts`
  performs it. This is why the policy is testable without a Keychain, a network,
  or a clock — keep new logic on that side of the line.
- Cross-domain imports go through the folder's barrel (`./balance`, `./ui`), not
  at a file inside it. Within a folder, import files directly.

## 3. TypeScript

- `strict` is on and stays on. No `any`; no non-null `!` outside tests.
- Import specifiers end in `.ts` (`allowImportingTsExtensions`), and `tsc`
  rewrites them for `dist/`.
- Exhaustive records over loose maps: `Record<BalanceStrategy, StrategyFn>` makes
  a forgotten strategy a compile error rather than a runtime `undefined`.
- Prefer a discriminated union to a boolean pair. `CredentialState` is
  `"ok" | "refreshable" | "unusable"` because "expired but recoverable" is a real
  third state, and two booleans would have allowed a fourth that means nothing.
- No runtime dependencies. `@opencode-ai/plugin` is a peer and may only be
  imported for a **value** behind a dynamic import — a static one puts the SDK in
  every test's module graph and silently cancels subtests.

## 4. Tests

- Every production module has a `*.test.ts` beside it. `check:structure` fails
  otherwise.
- `node --test --experimental-strip-types` must pass with **0 failed and 0
  cancelled**. Cancelled is not a pass: it means a module failed to load and its
  assertions never ran.
- `src/index.test.ts` copies sources into a temp directory and imports from
  there, so it must copy **every** module `index.ts` can reach, recursively.
  Omitting one produces cancellations with only `ERR_MODULE_NOT_FOUND` to go on.
  This has bitten four times; the collector is derived, keep it that way.
- Anything touching real accounts belongs in `scripts/test-*-headless.ts`, and
  must **skip**, not fail, when the machine's state cannot produce the case. A
  green run that asserted nothing is worse than an honest skip.

## 5. Logging and secrets

- Never log a credential. `logger.ts` redacts `accessToken`, `refreshToken` and
  `x-api-key` **by key name, at the top level only** — so a nested object or a
  differently-named field would leak silently, and Claude OAuth tokens do not
  match the JWT fallback pattern. Keep log payloads flat scalars.
- Errors on the credential path are swallowed deliberately, but each `catch {}`
  says why. A silent one is a bug.

## 6. Behaviour that must not regress

- **Switching accounts must never re-authenticate.** The token is resolved per
  request inside the plugin's `fetch`; changing the active account is enough.
  Going through the `auth` hook's `authorize()` re-initialises the provider and
  cancels in-flight subagents — that is why `pnpm lb` writes a file instead.
- **`autoSwitch` governs only self-initiated moves.** An explicit selection is
  obeyed whatever its value, or choosing a preset would appear to do nothing.
- **A rotation is never persisted.** The selection file holds what the operator
  chose; one window's exhaustion must not rewrite it for every other window.
- **Default off.** Anything that spends a different subscription's quota ships
  disabled and is opted into.

## 7. Checks

```bash
pnpm lint             # oxlint + oxfmt + check:structure
pnpm test             # unit tests
pnpm check:structure  # the rules on this page
pnpm build            # dist/ — OpenCode loads this, not src/
```
