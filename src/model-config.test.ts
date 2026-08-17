import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { config, getModelOverride } from "./model-config.ts"

describe("getModelOverride", () => {
  it("returns null for a model with no override", () => {
    assert.equal(getModelOverride("definitely-not-a-model"), null)
  })

  it("returns the override for every model the config declares", () => {
    for (const id of Object.keys(config.overrides ?? {})) {
      assert.notEqual(
        getModelOverride(id),
        null,
        `no override resolved for ${id}`,
      )
    }
  })

  it("is not confused by an empty id", () => {
    assert.equal(getModelOverride(""), null)
  })
})
