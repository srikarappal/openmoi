// Golden pages: each shipped spec against a saved page modeled on its site, measured field by field.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { extract_records } from "../../src/shared/extract"
import type { ExtractorSpec, RawRecord } from "../../src/shared/types"

const REPO_DIR = path.resolve(__dirname, "..", "..", "..")
const GOLDEN = ["amazon_search", "facebook_feed"]
const MIN_ACCURACY = 0.95

interface Golden {
  url: string
  spec: string
  records: RawRecord[]
}

// Share of expected fields the spec read exactly, over every expected record.
function field_accuracy(found: RawRecord[], expected: RawRecord[]): number {
  let total = 0
  let right = 0
  for (const [index, record] of expected.entries()) {
    for (const [field, value] of Object.entries(record)) {
      total += 1
      if (found[index]?.[field] === value) right += 1
    }
  }
  return right / total
}

describe("shipped specs on golden pages", () => {
  it.each(GOLDEN)("%s reads at least 95% of fields right and no extra items", (name) => {
    const golden: Golden = JSON.parse(readFileSync(path.join(REPO_DIR, "fixtures", "golden", `${name}.expected.json`), "utf-8"))
    const spec: ExtractorSpec = JSON.parse(readFileSync(path.join(REPO_DIR, "extractors", golden.spec), "utf-8"))
    const doc = new DOMParser().parseFromString(readFileSync(path.join(REPO_DIR, "fixtures", "golden", `${name}.html`), "utf-8"), "text/html")
    const found = extract_records(doc, spec, golden.url)
    expect(found).toHaveLength(golden.records.length)
    expect(field_accuracy(found, golden.records)).toBeGreaterThanOrEqual(MIN_ACCURACY)
  })
})
