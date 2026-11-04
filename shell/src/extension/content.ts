// Injected into a Chrome tab: the shared page operations, plus the passive watcher for source pages you browse yourself.
import { extract_records, record_key } from "../shared/extract"
import { run_page_op } from "../shared/page_ops"
import type { ExtractorSpec } from "../shared/types"

const WATCH_INTERVAL_MS = 3_000

interface MoiPage {
  moi_page_op?: typeof run_page_op
  moi_watch?: (source_id: string, url_prefix: string, spec: ExtractorSpec) => void
  moi_watching?: boolean
}

const page = globalThis as MoiPage

function ignore(): void {}

// Sends items that appeared since the last scan, while the page is still the source page.
function scan(source_id: string, url_prefix: string, spec: ExtractorSpec, sent: Set<string>): void {
  if (!location.href.startsWith(url_prefix)) return
  const fresh = extract_records(document, spec, location.href).filter((record) => !sent.has(record_key(record)))
  for (const record of fresh) sent.add(record_key(record))
  if (fresh.length) chrome.runtime.sendMessage({ type: "passive_records", source_id, page_url: location.href, records: fresh }).catch(ignore)
}

function watch(source_id: string, url_prefix: string, spec: ExtractorSpec): void {
  if (page.moi_watching) return
  page.moi_watching = true
  const sent = new Set<string>()
  scan(source_id, url_prefix, spec, sent)
  setInterval(() => scan(source_id, url_prefix, spec, sent), WATCH_INTERVAL_MS)
}

page.moi_page_op = run_page_op
page.moi_watch = watch
