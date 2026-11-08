// Finding the items on a listing page: a saved extractor spec first, else one the smart model writes from the page's
// skeleton (structure only, no text), at most twice. Used by Mine and by reader tabs for any site's feed page.
import { is_good_extraction } from "../shared/extract"
import type { ExtractorSpec, RawRecord } from "../shared/types"
import type { BrainClient } from "./brain"
import { explain } from "./chat"
import type { PageDriver } from "./drivers"

const ATTEMPTS = 2

export type SpecResult = { spec: ExtractorSpec; records: RawRecord[] } | { problem: string }

function usable(records: RawRecord[]): number {
  return records.filter((record) => record.url && (record.title || record.text)).length
}

export async function find_listing_spec(brain: BrainClient, driver: PageDriver, handle: string, url: string, saved: ExtractorSpec | null): Promise<SpecResult> {
  let last_error = ""
  if (saved) {
    const records = await driver.run<RawRecord[]>(handle, "extract", { spec: saved })
    if (is_good_extraction(records)) return { spec: saved, records }
    last_error = `the saved spec v${saved.version} found ${usable(records)} items with a title and url`
  }
  const skeleton = await driver.run<string>(handle, "skeleton")
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const spec = await brain.generate_extractor(url, skeleton, last_error || undefined)
      const records = await driver.run<RawRecord[]>(handle, "extract", { spec })
      if (is_good_extraction(records)) return { spec: await brain.accept_extractor(spec), records }
      last_error = `the spec found ${usable(records)} items with a title and url; it needs at least 3`
    } catch (error) {
      last_error = explain(error)
    }
  }
  return { problem: last_error }
}
