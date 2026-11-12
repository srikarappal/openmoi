// Reader tabs: one tab per page source (the X timeline, an Instagram feed, any site's feed page) kept open in your
// Chrome, or in openMoi's own session as a fallback and scrolled further each time a view needs more items.
// Scrolling goes at human pace and within a daily budget per source; a feed that stops giving new items has ended.
// A page whose posts come newest first is complete once its reader reaches two posts in a row read before: nothing
// newer than them was missed. One old post alone (a pinned one) does not count.
import { record_key } from "../shared/extract"
import { Throttle, sleep } from "../shared/timing"
import type { ExtractorSpec, ItemContent, PageSource, PageText, RawRecord, TranscriptSource } from "../shared/types"
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
// After a sign in wall or a check, a source rests this long unless you ask for it yourself.
const CHALLENGE_BACKOFF_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAILY_STEPS = 200
// Items read in full (to summarize them or note them) each day, over all sites.
const DAILY_CONTENT_READS = 50
const CONTENT_BUDGET = "content"
const DEFAULT_STEP_PX = 900
// Read from the top, a newest first page goes on past what was wanted, until it reaches what was read before; this caps it.
const MAX_COMPLETE_RECORDS = 300
// Each pause between scrolls is the source's interval plus up to half of it again, so the pace is never mechanical.
const JITTER = 0.5

export type FillOutcome =
  | { status: "read"; delivered: number; driver: DriverKind }
  | { status: "skipped" }
  | { status: "ended"; delivered: number; driver: DriverKind }
  | { status: "exhausted"; delivered: number; driver: DriverKind }
  // A newest first page reached posts read before: since is when the newest of them was posted, if the page said.
  | { status: "complete"; delivered: number; driver: DriverKind; since: string | null }
  | { status: "challenge"; url: string; driver: DriverKind }
  // final: retrying cannot help (the page has no items a spec can find), so no second attempt is made.
  | { status: "failed"; error: string; driver: DriverKind; final?: boolean }

export type ContentOutcome = { status: "read"; content: ItemContent } | { status: "failed"; error: string }

export type TextOutcome = { status: "read"; page: PageText; driver: DriverKind } | { status: "skipped" } | { status: "challenge"; url: string; driver: DriverKind } | { status: "failed"; error: string; driver: DriverKind }

// Receives each batch of new records as soon as it is extracted, so the first items show before scrolling ends.
// It may answer with the positions of records the brain had stored before.
export type BatchHandler = (records: RawRecord[]) => Promise<number[] | void>

interface ReaderTab {
  source_id: string
  driver: PageDriver
  handle: string
  spec: ExtractorSpec
  last_used: number
  idle_timer: ReturnType<typeof setTimeout> | null
  // Records read before this tab opened at the top, here or in an earlier run of openMoi: reaching them ends a newest first page.
  read_before: Set<string>
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
  private readonly resting = new Map<string, number>()

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
    if (this.rests(source, force) || !this.throttle.allow(source.source_id, force)) return { status: "skipped" }
    if (from_top) await this.close(source.source_id)
    const outcome = this.note_challenge(source, await this.attempt(source, wanted, on_batch, from_top))
    if (outcome.status !== "failed" || outcome.driver !== "chrome" || outcome.final) return outcome
    // Chrome may have restarted the extension mid read: try once more through the connection it has now.
    await this.close(source.source_id)
    await sleep(RETRY_PAUSE_MS)
    return this.attempt(source, wanted, on_batch, from_top)
  }

  // One look at a watched page: opened in its own quiet tab, given a moment to load, its text read, the tab closed.
  // It spends one step of the source's daily budget; automatic looks keep to the 10 minute pace.
  async read_text(source: PageSource, force: boolean): Promise<TextOutcome> {
    if (this.rests(source, force) || !this.throttle.allow(source.source_id, force)) return { status: "skipped" }
    const driver = await this.driver_for()
    if (!this.spend_step(source)) return { status: "failed", error: "today's budget for this page is used", driver: driver.kind }
    let handle: string | null = null
    try {
      handle = await driver.open(source.start_url, true)
      await sleep(SPEC_SETTLE_MS)
      if (await driver.run<boolean>(handle, "challenge")) return this.note_challenge<TextOutcome>(source, { status: "challenge", url: await driver.url(handle), driver: driver.kind })
      return { status: "read", page: await driver.run<PageText>(handle, "text"), driver: driver.kind }
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error), driver: driver.kind }
    } finally {
      if (handle) await driver.close(handle).catch(ignore)
    }
  }

  // One item read in full in a quiet tab that closes again: an article's text, or a video page's captions address.
  // At most 50 a day over all sites.
  async read_content(url: string, video: boolean): Promise<ContentOutcome> {
    if (!this.spend(CONTENT_BUDGET, DAILY_CONTENT_READS)) return { status: "failed", error: "today's budget for reading items in full is used" }
    const driver = await this.driver_for()
    let handle: string | null = null
    try {
      handle = await driver.open(url, true)
      await sleep(SPEC_SETTLE_MS)
      if (await driver.run<boolean>(handle, "challenge")) return { status: "failed", error: "a sign in or check is in the way" }
      if (video) {
        const source = await driver.run<TranscriptSource>(handle, "transcript")
        return { status: "read", content: { title: source.title, text: source.description, caption_url: source.caption_url } }
      }
      const article = await driver.run<RawRecord | null>(handle, "readability")
      if (article) return { status: "read", content: { title: article.title ?? "", text: article.text ?? "", caption_url: null } }
      const page = await driver.run<PageText>(handle, "text")
      return { status: "read", content: { title: page.title, text: page.text, caption_url: null } }
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (handle) await driver.close(handle).catch(ignore)
    }
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

  // From the top, a newest first page reads on past wanted until it reaches what was read before.
  private async attempt(source: PageSource, wanted: number, on_batch: BatchHandler, from_top: boolean): Promise<FillOutcome> {
    const driver = await this.driver_for()
    try {
      const opened = await this.tab_for(source, driver)
      if ("challenge" in opened) return { status: "challenge", url: opened.challenge, driver: driver.kind }
      const { tab, first } = opened
      const goal = source.chronological && from_top ? Math.max(wanted, MAX_COMPLETE_RECORDS) : wanted
      let delivered = await this.deliver(tab, first, on_batch)
      let reached = this.reached(source, tab, first)
      let empty = 0
      while (reached === undefined && delivered < goal) {
        if (tab.spec.pagination.kind !== "scroll") return { status: "ended", delivered, driver: driver.kind }
        if (!this.spend_step(source)) return { status: "exhausted", delivered, driver: driver.kind }
        await driver.run(tab.handle, "scroll", { step_px: tab.spec.pagination.step_px || DEFAULT_STEP_PX })
        await sleep(source.budget.min_step_interval_ms * (1 + this.random() * JITTER))
        const records = await driver.run<RawRecord[]>(tab.handle, "extract", { spec: tab.spec })
        const fresh = await this.deliver(tab, records, on_batch)
        delivered += fresh
        reached = this.reached(source, tab, records)
        empty = fresh ? 0 : empty + 1
        if (reached === undefined && empty >= EMPTY_STEPS_TO_END) return { status: "ended", delivered, driver: driver.kind }
      }
      if (reached !== undefined) return { status: "complete", delivered, driver: driver.kind, since: reached }
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
    const read_before = new Set(this.known.get(source.source_id) ?? [])
    const tab: ReaderTab = { source_id: source.source_id, driver, handle, spec: first.spec, last_used: this.clock(), idle_timer: null, read_before }
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

  // New records go to the brain; those it says it had stored before count as read before this tab opened.
  private async deliver(tab: ReaderTab, records: RawRecord[], on_batch: BatchHandler): Promise<number> {
    const known = this.known.get(tab.source_id) ?? new Set<string>()
    this.known.set(tab.source_id, known)
    const fresh = records.filter((record) => !known.has(record_key(record)))
    for (const record of fresh) known.add(record_key(record))
    if (!fresh.length) return 0
    const stored = await on_batch(fresh)
    for (const index of stored ?? []) if (fresh[index]) tab.read_before.add(record_key(fresh[index]))
    return fresh.length
  }

  // On a newest first page, two records in a row read before mean the reader is back where an earlier read was:
  // the answer is when the newer of the two was posted (null if the page did not say). undefined means not yet.
  private reached(source: PageSource, tab: ReaderTab, records: RawRecord[]): string | null | undefined {
    if (!source.chronological) return undefined
    let previous: RawRecord | null = null
    for (const record of records) {
      const old = tab.read_before.has(record_key(record))
      if (old && previous) return previous.published_at || null
      previous = old ? record : null
    }
    return undefined
  }

  // A source that hit a sign in wall or check rests a day from automatic reads; reading it yourself ends the rest.
  private rests(source: PageSource, force: boolean): boolean {
    if (force) this.resting.delete(source.source_id)
    return (this.resting.get(source.source_id) ?? 0) > this.clock()
  }

  private note_challenge<T extends { status: string }>(source: PageSource, outcome: T): T {
    if (outcome.status === "challenge") this.resting.set(source.source_id, this.clock() + CHALLENGE_BACKOFF_MS)
    return outcome
  }

  private spend_step(source: PageSource): boolean {
    return this.spend(source.source_id, source.budget.daily_steps ?? DEFAULT_DAILY_STEPS)
  }

  private spend(key: string, daily: number): boolean {
    const today = day_of(this.clock())
    const used = this.steps.get(key)?.day === today ? (this.steps.get(key)?.used ?? 0) : 0
    if (used >= daily) return false
    this.steps.set(key, { day: today, used: used + 1 })
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
