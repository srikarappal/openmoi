// Finding the items on a listing page, most trusted first: the saved spec, then its earlier versions, then (for a
// page read once, such as Mine) the items its own structured data names, then a spec the smart model writes from the
// page's skeleton (structure only, no text), at most twice. Every spec run is reported for its health check, so a
// spec that drifted (no items, links missing, far fewer than usual) gives way to the next step on its own.
import { is_good_extraction } from "../shared/extract"
import type { ExtractorSpec, RawRecord, RunReport } from "../shared/types"
import type { BrainClient } from "./brain"
import { explain } from "./chat"
import type { PageDriver } from "./drivers"

const ATTEMPTS = 2
const SAMPLES = 6
const CHECKED_FIELDS = ["url", "title", "text"]

export type SpecResult = { spec: ExtractorSpec | null; records: RawRecord[] } | { problem: string }

// A saved spec that already failed on this page: the search starts from its earlier versions.
export interface Failed {
  spec: ExtractorSpec
  problem: string
}

function usable(records: RawRecord[]): number {
  return records.filter((record) => record.url && (record.title || record.text)).length
}

export function run_report(spec: ExtractorSpec, records: RawRecord[], page: string): RunReport {
  const missing = Object.fromEntries(CHECKED_FIELDS.map((field) => [field, records.filter((record) => !record[field]).length]))
  const samples = records.slice(0, SAMPLES).map((record) => ({ title: (record.title || record.text || "").slice(0, 200), url: record.url ?? "" }))
  return { domain: spec.domain, path_pattern: spec.path_pattern, version: spec.version, count: records.length, missing, samples, page }
}

// Runs a spec and its health check; the problem is empty when it read the page well.
async function checked_run(brain: BrainClient, driver: PageDriver, handle: string, spec: ExtractorSpec, url: string): Promise<{ records: RawRecord[]; problem: string }> {
  const records = await driver.run<RawRecord[]>(handle, "extract", { spec })
  const verdict = await brain.report_extractor(run_report(spec, records, url))
  const problem = verdict.healthy ? (is_good_extraction(records) ? "" : `found ${usable(records)} items with a title and url`) : verdict.problem
  return { records, problem }
}

export async function find_listing_spec(
  brain: BrainClient,
  driver: PageDriver,
  handle: string,
  url: string,
  saved: ExtractorSpec | null,
  failed: Failed | null = null,
  structured: RawRecord[] = [],
): Promise<SpecResult> {
  let last_error = failed ? `the saved spec v${failed.spec.version} ${failed.problem}` : ""
  const latest = failed?.spec ?? saved
  const tried = failed ? [] : saved ? [saved] : []
  const candidates = [...tried, ...(latest ? await brain.previous_extractors(url, latest.version) : [])]
  for (const spec of candidates) {
    const { records, problem } = await checked_run(brain, driver, handle, spec, url)
    if (!problem) return { spec, records }
    last_error = `the saved spec v${spec.version} ${problem}`
  }
  if (is_good_extraction(structured)) return { spec: null, records: structured }
  const skeleton = await driver.run<string>(handle, "skeleton")
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const spec = await brain.generate_extractor(url, skeleton, last_error || undefined)
      const records = await driver.run<RawRecord[]>(handle, "extract", { spec })
      if (is_good_extraction(records)) {
        const accepted = await brain.accept_extractor(spec)
        const verdict = await brain.report_extractor(run_report(accepted, records, url))
        if (verdict.healthy) return { spec: accepted, records }
        last_error = `the new spec ${verdict.problem}`
        continue
      }
      last_error = `the spec found ${usable(records)} items with a title and url; it needs at least 3`
    } catch (error) {
      last_error = explain(error)
    }
  }
  return { problem: last_error }
}
