/**
 * Enforce the rules in AGENTS.md.
 *
 * Written because a convention that is only documented is a convention that
 * rots: the fork/upstream layout rule in particular is invisible at review time
 * — moving a file looks tidy and costs merge pain months later, to someone else.
 *
 * Run by `pnpm lint`, so it fails before a commit rather than after a merge.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SRC = join(ROOT, "src")

const problems: string[] = []
const notes: string[] = []

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

const all = walk(SRC).filter((f) => f.endsWith(".ts"))
const rel = (f: string) => relative(SRC, f).split("\\").join("/")
const prod = all.filter((f) => !f.endsWith(".test.ts"))

// --- which files does upstream own? ----------------------------------------
// Absent upstream ref (a fresh clone with no `upstream` remote) is not a
// failure: the rule simply cannot be checked, and saying so is better than
// passing silently.
let upstreamFiles: Set<string> | null = null
try {
  const listed = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "upstream/main", "src/"],
    { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  )
  upstreamFiles = new Set(
    listed
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/^src\//, "")),
  )
} catch {
  notes.push(
    "upstream/main not available — skipped the 'never move an upstream-owned file' check (git fetch upstream)",
  )
}

// --- rule 1: upstream-owned files stay at src/'s root ----------------------
if (upstreamFiles) {
  for (const f of all) {
    const r = rel(f)
    const base = r.split("/").pop()!
    // A domain barrel is a new file that happens to be named index.ts, not
    // upstream's entry point relocated.
    const isBarrel = /^\w+\/index\.ts$/.test(r)
    if (r.includes("/") && !isBarrel && upstreamFiles.has(base)) {
      problems.push(
        `${r}: upstream owns this file — moving it makes every future merge conflict. Keep it at src/${base}.`,
      )
    }
  }
}

// --- rule 2: every production module has a test beside it ------------------
// Barrels have nothing of their own to test. ui/tools.ts is thin glue over the
// SDK: everything decidable was extracted to ui/tools-format.ts, which IS
// tested, precisely because importing tools.ts would pull the SDK into a test
// graph and cancel subtests.
const EXEMPT = new Set([
  "index.ts",
  "balance/index.ts",
  "ui/index.ts",
  "ui/tools.ts",
])
for (const f of prod) {
  const r = rel(f)
  if (EXEMPT.has(r)) continue
  const testPath = f.replace(/\.ts$/, ".test.ts")
  if (!all.includes(testPath)) {
    problems.push(`${r}: no ${r.replace(/\.ts$/, ".test.ts")} beside it`)
  }
}

// --- rule 3: the SDK may only be imported for a value dynamically ----------
for (const f of prod) {
  const text = readFileSync(f, "utf-8")
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.includes("@opencode-ai/plugin")) continue
    const isType = /^\s*import\s+type\b/.test(line)
    const isDynamic = line.includes("await import") || line.includes("import(")
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line)
    // ui/tools.ts is loaded by a dynamic import in index.ts and by nothing
    // else, so its own static import cannot reach a statically-loaded graph.
    // The rule is about reachability, and this file is the boundary.
    const isDynamicOnlyModule = rel(f) === "ui/tools.ts"
    if (!isType && !isDynamic && !isComment && !isDynamicOnlyModule) {
      problems.push(
        `${rel(f)}:${i + 1}: static value import of @opencode-ai/plugin — it lands in every test's module graph and cancels subtests. Use a dynamic import.`,
      )
    }
  }
}

// --- rule 4: upstream-owned files reach a domain only through its barrel ---
// The barrel exists to keep the fork's footprint inside a file upstream also
// edits down to one import line. Fork-owned files importing each other
// precisely is better than dragging a whole domain in through a barrel, so the
// rule applies only where the merge cost is real.
const DOMAINS = ["balance", "ui"]
for (const f of all) {
  const r = rel(f)
  if (r.includes("/")) continue
  if (upstreamFiles && !upstreamFiles.has(r)) continue
  const text = readFileSync(f, "utf-8")
  for (const m of text.matchAll(/from\s+"\.\/(\w+)\/([\w-]+)\.ts"/g)) {
    const [, domain, mod] = m
    if (DOMAINS.includes(domain!) && mod !== "index" && mod !== "tools") {
      problems.push(
        `${r}: upstream also edits this file — reach ./${domain} through its barrel, not ./${domain}/${mod}.ts, so a merge touches one line.`,
      )
    }
  }
}

// --- rule 5: log payloads stay flat, because redaction is shallow ----------
for (const f of prod) {
  const text = readFileSync(f, "utf-8")
  for (const [i, line] of text.split("\n").entries()) {
    if (
      /\blog\([^)]*\{[^}]*\.\.\./.test(line) &&
      /cred|token|account:/i.test(line)
    ) {
      problems.push(
        `${rel(f)}:${i + 1}: spreads a credential-bearing object into a log payload — redaction is by key name at the top level only.`,
      )
    }
  }
}

for (const n of notes) console.log(`note: ${n}`)
if (problems.length === 0) {
  console.log(
    `structure: OK (${prod.length} modules, ${all.length - prod.length} test files)`,
  )
  process.exit(0)
}
console.error(`\nstructure: ${problems.length} problem(s)\n`)
for (const p of problems) console.error(`  - ${p}`)
console.error("\nRules and their reasons: AGENTS.md\n")
process.exit(1)
