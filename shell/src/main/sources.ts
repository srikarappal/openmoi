// Reads page sources (such as your X home timeline) in hidden views inside your own session, at human pace.
import { WebContentsView } from "electron"
import { Throttle, sleep } from "../shared/timing"
import type { PageSource, RawRecord } from "../shared/types"
import type { ViewHost } from "./host"
import { call_page } from "./page_rpc"
import { web_preferences } from "./sessions"

const AUTO_INTERVAL_MS = 10 * 60 * 1000
const FIRST_ITEMS_TIMEOUT_MS = 10_000
const POLL_MS = 400

export type SourceOutcome =
  | { status: "read"; count: number }
  | { status: "skipped" }
  | { status: "challenge"; url: string }
  | { status: "failed"; error: string }

// Receives each batch of records as soon as it is extracted, so the first items show before scrolling ends.
export type BatchHandler = (records: RawRecord[]) => Promise<void>

function record_key(record: RawRecord): string {
  return record.native_id ?? record.url ?? JSON.stringify(record)
}

async function deliver(records: RawRecord[], collected: Map<string, RawRecord>, on_batch: BatchHandler): Promise<void> {
  const fresh = records.filter((record) => !collected.has(record_key(record)))
  for (const record of fresh) collected.set(record_key(record), record)
  if (fresh.length) await on_batch(fresh)
}

export class SourceReader {
  private readonly views = new Map<string, WebContentsView>()

  constructor(
    private readonly host: ViewHost,
    private readonly throttle = new Throttle(AUTO_INTERVAL_MS),
  ) {}

  // One page load plus the budgeted scrolls; automatic reads at most every 10 minutes per source.
  async read(source: PageSource, force: boolean, on_batch: BatchHandler): Promise<SourceOutcome> {
    if (!this.throttle.allow(source.source_id, force)) return { status: "skipped" }
    const view = this.view_for(source.source_id)
    try {
      await view.webContents.loadURL(source.start_url)
      const first = await this.first_records(view, source)
      if (first === null) return { status: "challenge", url: view.webContents.getURL() }
      const collected = new Map<string, RawRecord>()
      await deliver(first, collected, on_batch)
      const steps = source.spec.pagination.kind === "scroll" && first.length ? source.budget.scroll_steps : 0
      for (let step = 0; step < steps; step++) {
        await call_page(view.webContents, "scroll", { step_px: source.spec.pagination.step_px })
        await sleep(source.budget.min_step_interval_ms)
        await deliver(await call_page<RawRecord[]>(view.webContents, "extract", { spec: source.spec }), collected, on_batch)
      }
      return { status: "read", count: collected.size }
    } catch (error) {
      return { status: "failed", error: String(error) }
    }
  }

  // Waits for the page to render its first items; null means a login wall or check is in the way.
  private async first_records(view: WebContentsView, source: PageSource): Promise<RawRecord[] | null> {
    const deadline = Date.now() + FIRST_ITEMS_TIMEOUT_MS
    for (;;) {
      const records = await call_page<RawRecord[]>(view.webContents, "extract", { spec: source.spec })
      if (records.length) return records
      if (await call_page<boolean>(view.webContents, "challenge")) return null
      if (Date.now() >= deadline) return []
      await sleep(POLL_MS)
    }
  }

  private view_for(source_id: string): WebContentsView {
    const existing = this.views.get(source_id)
    if (existing) return existing
    const view = new WebContentsView({ webPreferences: web_preferences(this.host.page_preload, true) })
    view.webContents.setAudioMuted(true)
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    this.host.attach_behind(view)
    this.views.set(source_id, view)
    return view
  }
}
