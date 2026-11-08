// Reader tabs: one tab per page source (the X timeline, an Instagram feed, any site's feed page) kept open in your
// Chrome, or in openMoi's own session as a fallback and scrolled further each time a view needs more items.
// Scrolling goes at human pace and within a daily budget per source; a feed that stops giving new items has ended.
import { record_key } from "../shared/extract"
import { Throttle, sleep } from "../shared/timing"
import type { ExtractorSpec, PageSource, RawRecord } from "../shared/types"
import type { BrainClient } from "./brain"
import type { DriverKind, PageDriver } from "./drivers"
import { find_listing_spec } from "./listing_spec"

const AUTO_INTERVAL_MS = 10 * 60 * 1000
const IDLE_MS = 10 * 60 * 1000
const MAX_TABS = 4
const FIRST_ITEMS_TIMEOUT_MS = 10_000
const SPEC_SETTLE_MS = 2_000
const POLL_MS = 400
const EMPTY_STEPS_TO_END = 3
const RETRY_PAUSE_MS = 2_000
const DEFAULT_DAILY_STEPS = 200
const DEFAULT_STEP_PX = 900
// Each pause between scrolls is the source's interval plus up to half of it again, so the pace is never mechanical.
const JITTER = 0.5

export type FillOutcome =
  | { status: "read"; delivered: number; driver: DriverKind }
  | { status: "skipped" }
  | { status: "ended"; delivered: number; driver: DriverKind }
  | { status: "exhausted"; delivered: number; driver: DriverKind }
  | { status: "challenge"; url: string; driver: DriverKind }
  // final: retrying cannot help (the page has no items a spec can find), so no second attempt is made.
  | { status: "failed"; error: string; driver: DriverKind; final?: boolean }

// Receives each batch of new records as soon as it is extracted, so the first items show before scrolling ends.
export type BatchHandler = (records: RawRecord[]) => Promise<void>

interface ReaderTab {
  source_id: string
  driver: PageDriver
  handle: string
  spec: ExtractorSpec
  last_used: number
  idle_timer: ReturnType<typeof setTimeout> | null
}

type Opened = { tab: ReaderTab; first: RawRecord[] } | { challenge: string }

function ignore(): void {}

class ItemsNotFound extends Error {}

function day_of(moment: number): string {
  return new Date(moment).toDateString()
}

export class ReaderPool {
  private readonly tabs = new Map<string, ReaderTab>()
  // Records each source already handed over, kept when its tab closes so a reopened tab skips them quickly.
  private readonly known = new Map<string, Set<string>>()
  private readonly steps = new Map<string, { day: string; used: number }>()

  constructor(
    private readonly driver_for: () => PageDriver | Promise<PageDriver>,
    private readonly brain: BrainClient,
    private readonly throttle = new Throttle(AUTO_INTERVAL_MS),
    private readonly clock: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  // Reads until `wanted` new records arrived, the feed ends or today's budget for the source is used.
  // Automatic fills of a source happen at most every 10 minutes; forced ones (you refreshing or scrolling) always.
  // from_top starts the source over (a refresh wants what is new); otherwise its tab continues where it stopped.
  async fill(source: PageSource, wanted: number, on_batch: BatchHandler, force: boolean, from_top = false): Promise<FillOutcome> {
    if (!this.throttle.allow(source.source_id, force)) return { status: "skipped" }
    if (from_top) await this.close(source.source_id)
    const outcome = await this.attempt(source, wanted, on_batch)
    if (outcome.status !== "failed" || outcome.driver !== "chrome" || outcome.final) return outcome
    // Chrome may have restarted the extension mid read: try once more through the connection it has now.
    await this.close(source.source_id)
    await sleep(RETRY_PAUSE_MS)
    return this.attempt(source, wanted, on_batch)
  }

  async close_all(): Promise<void> {
    await Promise.all([...this.tabs.keys()].map((source_id) => this.close(source_id)))
  }

  open_tabs(): string[] {
    return [...this.tabs.keys()]
  }

  steps_used(source_id: string): number {
    const today = this.steps.get(source_id)
    return today?.day === day_of(this.clock()) ? today.used : 0
  }

  private async attempt(source: PageSource, wanted: number, on_batch: BatchHandler): Promise<FillOutcome> {
    const driver = await this.driver_for()
    try {
      const opened = await this.tab_for(source, driver)
      if ("challenge" in opened) return { status: "challenge", url: opened.challenge, driver: driver.kind }
      const { tab, first } = opened
      let delivered = await this.deliver(source.source_id, first, on_batch)
      let empty = 0
      while (delivered < wanted) {
        if (tab.spec.pagination.kind !== "scroll") return { status: "ended", delivered, driver: driver.kind }
        if (!this.spend_step(source)) return { status: "exhausted", delivered, driver: driver.kind }
        await driver.run(tab.handle, "scroll", { step_px: tab.spec.pagination.step_px || DEFAULT_STEP_PX })
        await sleep(source.budget.min_step_interval_ms * (1 + this.random() * JITTER))
        const fresh = await this.deliver(source.source_id, await driver.run<RawRecord[]>(tab.handle, "extract", { spec: tab.spec }), on_batch)
        delivered += fresh
        empty = fresh ? 0 : empty + 1
        if (empty >= EMPTY_STEPS_TO_END) return { status: "ended", delivered, driver: driver.kind }
      }
      return { status: "read", delivered, driver: driver.kind }
    } catch (error) {
      await this.close(source.source_id)
      const failed: FillOutcome = { status: "failed", error: error instanceof Error ? error.message : String(error), driver: driver.kind }
      return error instanceof ItemsNotFound ? { ...failed, final: true } : failed
    } finally {
      this.touch(source.source_id)
    }
  }

  // The source's open tab where it left off, or a fresh one; a tab you closed or navigated away is opened again.
  private async tab_for(source: PageSource, driver: PageDriver): Promise<Opened> {
    const existing = this.tabs.get(source.source_id)
    if (existing && existing.driver === driver && (await this.still_there(existing, source))) {
      return { tab: existing, first: await driver.run<RawRecord[]>(existing.handle, "extract", { spec: existing.spec }) }
    }
    if (existing) await this.close(source.source_id)
    await this.make_room()
    const handle = await driver.open(source.start_url, true)
    const first = await this.first_records(driver, handle, source)
    if (first === null) {
      const challenge = await driver.url(handle)
      await driver.close(handle).catch(ignore)
      return { challenge }
    }
    const tab: ReaderTab = { source_id: source.source_id, driver, handle, spec: first.spec, last_used: this.clock(), idle_timer: null }
    this.tabs.set(source.source_id, tab)
    return { tab, first: first.records }
  }

  private async still_there(tab: ReaderTab, source: PageSource): Promise<boolean> {
    try {
      return (await tab.driver.url(tab.handle)).startsWith(new URL(source.start_url).origin)
    } catch {
      return false
    }
  }

  // Waits for the page to render its first items; null means a sign in wall or check is in the way.
  // A page without a saved spec gets one made from its skeleton once its content had a moment to load.
  private async first_records(driver: PageDriver, handle: string, source: PageSource): Promise<{ spec: ExtractorSpec; records: RawRecord[] } | null> {
    if (!source.spec) {
      await sleep(SPEC_SETTLE_MS)
      if (await driver.run<boolean>(handle, "challenge")) return null
      const found = await find_listing_spec(this.brain, driver, handle, source.start_url, null)
      if ("problem" in found) throw new ItemsNotFound(`could not find the items on ${source.start_url}: ${found.problem}`)
      return found
    }
    const deadline = this.clock() + FIRST_ITEMS_TIMEOUT_MS
    for (;;) {
      const records = await driver.run<RawRecord[]>(handle, "extract", { spec: source.spec })
      if (records.length) return { spec: source.spec, records }
      if (await driver.run<boolean>(handle, "challenge")) return null
      if (this.clock() >= deadline) return { spec: source.spec, records }
      await sleep(POLL_MS)
    }
  }

  private async deliver(source_id: string, records: RawRecord[], on_batch: BatchHandler): Promise<number> {
    const known = this.known.get(source_id) ?? new Set<string>()
    this.known.set(source_id, known)
    const fresh = records.filter((record) => !known.has(record_key(record)))
    for (const record of fresh) known.add(record_key(record))
    if (fresh.length) await on_batch(fresh)
    return fresh.length
  }

  private spend_step(source: PageSource): boolean {
    const today = day_of(this.clock())
    const used = this.steps.get(source.source_id)?.day === today ? (this.steps.get(source.source_id)?.used ?? 0) : 0
    if (used >= (source.budget.daily_steps ?? DEFAULT_DAILY_STEPS)) return false
    this.steps.set(source.source_id, { day: today, used: used + 1 })
    return true
  }

  // A tab nobody needed for a while closes; the next fill opens it again at the top.
  private touch(source_id: string): void {
    const tab = this.tabs.get(source_id)
    if (!tab) return
    tab.last_used = this.clock()
    if (tab.idle_timer) clearTimeout(tab.idle_timer)
    tab.idle_timer = setTimeout(() => this.close(source_id).catch(ignore), IDLE_MS)
  }

  private async make_room(): Promise<void> {
    if (this.tabs.size < MAX_TABS) return
    const [oldest] = [...this.tabs.values()].sort((first, second) => first.last_used - second.last_used)
    await this.close(oldest.source_id)
  }

  private async close(source_id: string): Promise<void> {
    const tab = this.tabs.get(source_id)
    if (!tab) return
    this.tabs.delete(source_id)
    if (tab.idle_timer) clearTimeout(tab.idle_timer)
    await tab.driver.close(tab.handle).catch(ignore)
  }
}
