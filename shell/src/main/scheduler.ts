// Runs the reads editions need when they are due and says when an edition comes out. It looks every minute and
// whenever the Mac wakes; a read the Mac slept through is due late and runs then. Reads go one view at a time each.
import type { ContentWanted, PageSource, ViewSchedule } from "../shared/types"
import type { BrainClient } from "./brain"

const TICK_MS = 60_000
// The pack channel is asked for a newer pack every 30 ticks (half an hour), so a site the kill switch removes stops
// being read within the hour.
const PACK_CHECK_TICKS = 30
// Keys of reads that are not a view's: a view id never holds a NUL or a colon.
const SUMMARIES = "\0summaries"

export interface SchedulerHooks {
  read(view_id: string): Promise<void>
  // A watched page is due for another look.
  watch(source: PageSource): Promise<void>
  // An item a summarize rule wants read in full.
  summarize(wanted: ContentWanted): Promise<void>
  // An edition came out while openMoi was running.
  edition_out(schedule: ViewSchedule): void
  // A read for an edition finished and the edition is marked read.
  read_done(view_id: string): void
  // What the half hourly look at the pack channel found.
  packs(status: string): void
  failed(text: string): void
}

function ignore(): void {}

export class Scheduler {
  schedules: ViewSchedule[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly running = new Map<string, Promise<void>>()
  // The edition each view showed at the last look, so only a new one is announced.
  private readonly editions = new Map<string, string>()
  private looking: Promise<void> | null = null
  private packs_checked_at = -Infinity

  constructor(
    private readonly brain: BrainClient,
    private readonly hooks: SchedulerHooks,
    private readonly tick_ms = TICK_MS,
  ) {}

  start(): void {
    this.stop()
    this.timer = setInterval(() => this.tick().catch(ignore), this.tick_ms)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // One look at the schedule; a look already under way is shared rather than doubled.
  tick(): Promise<void> {
    this.looking ??= this.look().finally(() => {
      this.looking = null
    })
    return this.looking
  }

  // Reads still running, for tests and for a clean quit.
  idle(): Promise<void> {
    return Promise.all(this.running.values()).then(ignore)
  }

  private async look(): Promise<void> {
    try {
      this.schedules = await this.brain.schedule()
    } catch (error) {
      this.hooks.failed(`The schedule could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const schedule of this.schedules) {
      if (schedule.read_for && !this.running.has(schedule.view_id)) this.read(schedule.view_id, schedule.read_for)
      // An edition whose own read is still due (the Mac slept through it) is announced once that read is done.
      if (schedule.edition && schedule.read_for === schedule.edition) continue
      const previous = this.editions.get(schedule.view_id)
      if (schedule.edition && previous !== undefined && previous !== schedule.edition) this.hooks.edition_out(schedule)
      if (schedule.edition) this.editions.set(schedule.view_id, schedule.edition)
    }
    await this.look_at_watches()
    this.summarize_wanted()
    this.check_packs()
  }

  private check_packs(): void {
    if (Date.now() - this.packs_checked_at < this.tick_ms * PACK_CHECK_TICKS) return
    this.packs_checked_at = Date.now()
    this.brain
      .update_packs()
      .then(({ status }) => this.hooks.packs(status))
      .catch((error) => this.hooks.failed(`The pack channel could not be checked: ${error instanceof Error ? error.message : String(error)}`))
  }

  // Items to summarize are read one at a time, in the background, a few each minute.
  private summarize_wanted(): void {
    if (this.running.has(SUMMARIES)) return
    const run = this.brain
      .content_wanted()
      .then(async (wanted) => {
        for (const item of wanted) await this.hooks.summarize(item)
      })
      .catch((error) => this.hooks.failed(`Summaries could not be made: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.running.delete(SUMMARIES))
    this.running.set(SUMMARIES, run)
  }

  // Each due watched page gets one look at a time; a failed look waits for the next minute.
  private async look_at_watches(): Promise<void> {
    let due: PageSource[]
    try {
      due = await this.brain.watches_due()
    } catch (error) {
      this.hooks.failed(`Watched pages could not be checked: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const source of due) {
      const key = `watch:${source.start_url}`
      if (this.running.has(key)) continue
      const run = this.hooks
        .watch(source)
        .catch((error) => this.hooks.failed(`Looking at ${source.start_url} failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.running.delete(key))
      this.running.set(key, run)
    }
  }

  // The edition is marked read even when a source failed (its notice says why), so a dead source is not retried
  // every minute until the edition comes out; it shows what the other sources found.
  private read(view_id: string, edition: string): void {
    const run = this.hooks
      .read(view_id)
      .catch((error) => this.hooks.failed(`Reading for ${view_id} failed: ${error instanceof Error ? error.message : String(error)}`))
      .then(() => this.brain.schedule_done(view_id, edition))
      .then(
        () => this.hooks.read_done(view_id),
        (error) => this.hooks.failed(`Could not mark the ${view_id} edition read: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => this.running.delete(view_id))
    this.running.set(view_id, run)
  }
}
