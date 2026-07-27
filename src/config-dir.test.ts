import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  candidateConfigDirs,
  configDirForService,
  serviceForConfigDir,
  suffixOfService,
} from "./config-dir.ts"

/** Verified against the live setup this was built from. */
const KNOWN: Array<[string, string]> = [
  ["/Users/you/.claude-team-1/", "780bcd9b"],
  ["/Users/you/.claude-team-2/", "04bd82dd"],
  ["/Users/you/.claude-team-3/", "e534bce6"],
]

describe("serviceForConfigDir", () => {
  it("reproduces the service names Claude Code actually created", () => {
    for (const [dir, suffix] of KNOWN) {
      assert.equal(
        serviceForConfigDir(dir),
        `Claude Code-credentials-${suffix}`,
      )
    }
  })

  it("treats a missing trailing slash as equivalent", () => {
    // The hash is over the path WITH its trailing slash.
    assert.equal(
      serviceForConfigDir("/Users/you/.claude-team-1"),
      serviceForConfigDir("/Users/you/.claude-team-1/"),
    )
  })

  it("gives different directories different services", () => {
    const seen = new Set(KNOWN.map(([d]) => serviceForConfigDir(d)))
    assert.equal(seen.size, 3)
  })
})

describe("suffixOfService", () => {
  it("extracts the discriminator", () => {
    assert.equal(
      suffixOfService("Claude Code-credentials-780bcd9b"),
      "780bcd9b",
    )
  })

  it("returns null for the default entry", () => {
    assert.equal(suffixOfService("Claude Code-credentials"), null)
  })

  it("rejects anything that is not an 8-hex suffix", () => {
    for (const s of [
      "Claude Code-credentials-XYZ",
      "Claude Code-credentials-340807b",
      "",
      "other",
    ]) {
      assert.equal(suffixOfService(s), null)
    }
  })
})

describe("candidateConfigDirs", () => {
  it("finds .claude* directories and ignores everything else", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"))
    mkdirSync(join(home, ".claude"))
    mkdirSync(join(home, ".claude-work"))
    mkdirSync(join(home, ".config"))
    writeFileSync(join(home, ".claude-file"), "not a dir")

    const dirs = candidateConfigDirs(home).map((d) => d.replace(`${home}/`, ""))
    assert.deepEqual(dirs, [".claude", ".claude-work"])
  })

  it("returns empty rather than throwing on an unreadable home", () => {
    assert.deepEqual(candidateConfigDirs("/definitely/not/here"), [])
  })
})

describe("configDirForService", () => {
  it("maps a suffixed service back to its directory", () => {
    const dirs = KNOWN.map(([d]) => d.replace(/\/$/, ""))
    assert.equal(
      configDirForService("Claude Code-credentials-04bd82dd", dirs),
      "/Users/you/.claude-team-2",
    )
  })

  it("returns null when no candidate matches", () => {
    // Guessing would refresh the wrong account: tokens spent, target still expired.
    assert.equal(
      configDirForService(
        "Claude Code-credentials-deadbeef",
        KNOWN.map(([d]) => d),
      ),
      null,
    )
  })

  it("returns null when there are no candidates at all", () => {
    assert.equal(
      configDirForService("Claude Code-credentials-780bcd9b", []),
      null,
    )
  })
})
