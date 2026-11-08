// Reads page sources (such as your X home timeline) through a page driver: your Chrome when connected, at human pace.
import { record_key } from "../shared/extract"
import { Throttle, sleep } from "../shared/timing"
import type { PageSource, RawRecord } from "../shared/types"
import type { DriverKind, PageDriver } from "./drivers"

const AUTO_INTERVAL_MS = 10 * 60 * 1000
const FIRST_ITEMS_TIMEOUT_MS = 10_000
const POLL_MS = 400
const RETRY_PAUSE_MS = 2_000

export type SourceOutcome =
  | { status: "read"; count: number; driver: DriverKind }
  | { status: "skipped" }
  | { status: "challenge"; url: string; driver: DriverKind }
  | { status: "failed"; error: string; driver: DriverKind }

// Receives each batch of records as soon as it is extracted, so the first items show before scrolling ends.
export type BatchHandler = (records: RawRecord[]) => Promise<void>

async function deliver(records: RawRecord[], collected: Map<string, RawRecord>, on_batch: BatchHandler): Promise<void> {
  const fresh = records.filter((record) => !collected.has(record_key(record)))
  for (const record of fresh) collected.set(record_key(record), record)
  if (fresh.length) await on_batch(fresh)
}

function ignore(): void {}

export class SourceReader {
  constructor(
    private readonly driver_for: () => PageDriver | Promise<PageDriver>,
    private readonly throttle = new Throttle(AUTO_INTERVAL_MS),
  ) {}

  // One page load plus the budgeted scrolls, times depth when you scroll past the end; automatic reads at most every 10 minutes per source.
  async read(source: PageSource, force: boolean, on_batch: BatchHandler, depth = 1): Promise<SourceOutcome> {
    if (!this.throttle.allow(source.source_id, force)) return { status: "skipped" }
    const collected = new Map<string, RawRecord>()
    const outcome = await this.attempt(await this.driver_for(), source, collected, on_batch, depth)
    if (outcome.status !== "failed" || outcome.driver !== "chrome") return outcome
    // Chrome may have restarted the extension mid read: try once more through the connection it has now.
    await sleep(RETRY_PAUSE_MS)
    return this.attempt(await this.driver_for(), source, collected, on_batch, depth)
  }

  // Records already delivered stay in collected, so a retry never hands the same record over twice.
  private async attempt(driver: PageDriver, source: PageSource, collected: Map<string, RawRecord>, on_batch: BatchHandler, depth: number): Promise<SourceOutcome> {
    let handle: string | null = null
    try {
      handle = await driver.open(source.start_url, true)
      const first = await this.first_records(driver, handle, source)
      if (first === null) return { status: "challenge", url: await driver.url(handle), driver: driver.kind }
      await deliver(first, collected, on_batch)
      const steps = source.spec.pagination.kind === "scroll" && first.length ? source.budget.scroll_steps * depth : 0
      for (let step = 0; step < steps; step++) {
        await driver.run(handle, "scroll", { step_px: source.spec.pagination.step_px })
        await sleep(source.budget.min_step_interval_ms)
        await deliver(await driver.run<RawRecord[]>(handle, "extract", { spec: source.spec }), collected, on_batch)
      }
      return { status: "read", count: collected.size, driver: driver.kind }
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error), driver: driver.kind }
    } finally {
      if (handle) await driver.close(handle).catch(ignore)
    }
  }

  // Waits for the page to render its first items; null means a login wall or check is in the way.
  private async first_records(driver: PageDriver, handle: string, source: PageSource): Promise<RawRecord[] | null> {
    const deadline = Date.now() + FIRST_ITEMS_TIMEOUT_MS
    for (;;) {
      const records = await driver.run<RawRecord[]>(handle, "extract", { spec: source.spec })
      if (records.length) return records
      if (await driver.run<boolean>(handle, "challenge")) return null
      if (Date.now() >= deadline) return []
      await sleep(POLL_MS)
    }
  }
}
