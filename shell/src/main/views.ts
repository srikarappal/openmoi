// Feed style views: render from cache, refresh sources, append new items, re-render after edits, forward lens events.
// Page sources read ahead of you: as you near the end of what is shown, their reader tabs scroll further, enough to
// refill the view after your rules hide some, so the feed goes on like the site's own until a source ends.
import { sleep } from "../shared/timing"
import type { ContentWanted, Item, LensToHost, Notice, PageSource, RawRecord, ViewPage, WatchAlert } from "../shared/types"
import type { Track } from "./activity"
import type { BrainClient } from "./brain"
import type { DriverKind } from "./drivers"
import type { LensContext, LensManager } from "./lenses"
import type { ReaderPool } from "./readers"

const SETTLE_POLL_MS = 1_000
const SETTLE_ATTEMPTS = 30
const MORE_CURSOR = "more"
// Past the stored items the lens may ask for more: the reader tabs then scroll their sources further.
const DEEPER_CURSOR = "deeper"
// Fewer than READ_AHEAD_ITEMS filtered items left below the furthest one you saw: top the view up to BUFFER_ITEMS.
const READ_AHEAD_ITEMS = 20
const BUFFER_ITEMS = 30
const FIRST_FILL_RECORDS = 30
const MAX_FILL_RECORDS = 120
// A source whose items your rules almost all hide is still read at most ten raw items for each one wanted.
const MIN_KEEP_RATE = 0.1
// A read for an edition goes deeper than a look: it is the only read the edition gets.
const EDITION_RECORDS = 120
// A list of the accounts you follow is read to its end, within the daily budget.
const FOLLOW_RECORDS = 2000
const MAX_TITLE = 80

export interface ViewHooks {
  open_original(url: string): void
  // Plays a video item in the host's player; false when it cannot (not a YouTube video).
  play(item: Item): boolean
  notify(text: string, url?: string, tag?: string, action?: Notice["action"]): void
  retract(tag: string): void
  echo(text: string): void
  less_like_this(view_id: string, item: Item): void
  lens_stale(view_id: string, layout_hash: string): void
  // A watched page changed in a way a view keeps.
  alert(alert: WatchAlert): void
  track: Track
}

export function view_lens_key(view_id: string): string {
  return `view:${view_id}`
}

// In Chrome you only need to sign in; without the relay, openMoi's own session is the one missing the sign in.
function challenge_text(source_id: string, driver: DriverKind): string {
  if (driver === "chrome") return `${source_id} needs you in Chrome: sign in or finish the check there, then refresh.`
  return `${source_id} needs your Chrome sign in: open Chrome with the openMoi extension and it loads by itself, or sign in here, then refresh.`
}

function ignore(): void {}

// A time of day as your clock shows it, such as 7:00 AM.
export function clock_time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

// A moment as your clock shows it, with the day when it is not today.
function moment_text(iso: string): string {
  const moment = new Date(iso)
  if (moment.toDateString() === new Date().toDateString()) return clock_time(iso)
  return moment.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
}

function and_list(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("")
}

// What a lens shows changes with its files and, for a view in editions, with the edition on show.
function render_version(page: ViewPage): string {
  return `${page.version}@${page.edition ?? ""}`
}

function label_of(item: Item): string {
  return item.title || item.text?.slice(0, MAX_TITLE) || item.url
}

function source_tag(source_id: string): string {
  return `source:${source_id}`
}

function warning_tag(warning: string): string {
  return `warning:${warning}`
}

export class ViewController {
  private readonly versions = new Map<string, string>()
  private readonly summaries = new Map<string, string>()
  private readonly reported = new Set<string>()
  private readonly warned = new Map<string, string[]>()
  private readonly waiting_for_chrome = new Map<string, { view_id: string; source: PageSource }>()
  private readonly page_sources = new Map<string, PageSource[]>()
  private readonly keep_rates = new Map<string, Record<string, number>>()
  // Sources that ended or used today's budget: no more reading ahead from them until a refresh.
  private readonly finished = new Map<string, Set<string>>()
  // Per lens, the position of the furthest item you have seen, in the order the lens shows them.
  private readonly furthest = new Map<string, number>()
  private readonly reading = new Map<string, Promise<void>>()
  // Views that come out in editions: what they show is fixed until the next one, so they never read ahead.
  private readonly editioned = new Set<string>()
  private readonly edition_told = new Set<string>()
  // What you saw in each view and when, for the end of a visit.
  private readonly seen_log = new Map<string, Array<{ at: number; label: string }>>()
  // Per view, the newest first sources whose reader got back to what was read before, with since when.
  private readonly complete = new Map<string, Map<string, string | null>>()
  private readonly complete_told = new Set<string>()

  constructor(
    private readonly brain: BrainClient,
    private readonly lenses: LensManager,
    private readonly readers: ReaderPool,
    private readonly hooks: ViewHooks,
  ) {}

  // Opens the view's lens, or re-renders an open one whose files changed since it last rendered.
  async show(view_id: string): Promise<LensContext> {
    const existing = this.lenses.get(view_lens_key(view_id))
    if (!existing) return this.lenses.open(view_lens_key(view_id), view_id, await this.brain.lens(view_id, "feed"))
    const page = await this.brain.view_page(view_id, [])
    if (render_version(page) !== this.versions.get(view_id)) await existing.serial(() => this.render(existing))
    return existing
  }

  owns(context: LensContext): boolean {
    return context.key === view_lens_key(context.view_id)
  }

  on_ready(context: LensContext): void {
    context
      .serial(() => this.render(context))
      .then(() => this.refresh(context, false))
      .catch((error) => this.hooks.notify(`${context.view_id} could not load: ${error}`))
  }

  private async render(context: LensContext): Promise<void> {
    const page = await this.brain.view_page(context.view_id, [])
    this.furthest.delete(context.key)
    context.send({ type: "render", items: page.items, cursor: this.cursor_for(page) })
    this.versions.set(context.view_id, render_version(page))
    const previous = this.summaries.get(context.view_id)
    if (previous !== undefined && previous !== page.summary) this.hooks.echo(`I understood: ${page.summary}`)
    this.summaries.set(context.view_id, page.summary)
    this.report(page)
    this.edition_end(page)
    if (page.lens_stale) this.hooks.lens_stale(context.view_id, page.layout_hash)
  }

  // The next page of stored items, else reading the page sources further, else caught up. An edition never reads further.
  private cursor_for(page: ViewPage): string | null {
    if (page.edition) this.editioned.add(page.view_id)
    else this.editioned.delete(page.view_id)
    if (page.has_more) return MORE_CURSOR
    return !page.edition && this.open_sources(page.view_id).length ? DEEPER_CURSOR : null
  }

  // Once you have read all of an edition, say so once and when the next one comes out.
  private edition_end(page: ViewPage): void {
    if (!page.caught_up || !page.edition || !page.next_edition) return
    const key = `${page.view_id}@${page.edition}`
    if (this.edition_told.has(key)) return
    this.edition_told.add(key)
    this.hooks.notify(
      `That is all of the ${clock_time(page.edition)} edition of ${page.view_id}. The next one comes out at ${clock_time(page.next_edition)}.`,
      undefined,
      `edition:${page.view_id}`,
      { label: "Open anyway", command: { type: "open_early", view_id: page.view_id } },
    )
  }

  // Caught up, with every newest first source read back to where an earlier read was: say once that nothing was missed.
  private completeness(page: ViewPage): void {
    const ordered = (this.page_sources.get(page.view_id) ?? []).filter((source) => source.chronological)
    const complete = this.complete.get(page.view_id) ?? new Map<string, string | null>()
    if (!page.caught_up || !ordered.length || this.complete_told.has(page.view_id) || ordered.some((source) => !complete.has(source.source_id))) return
    this.complete_told.add(page.view_id)
    const parts = ordered.map((source) => {
      const since = complete.get(source.source_id)
      return `${source.source_id.replace(/^page:/, "")}${since ? ` since ${moment_text(since)}` : ""}`
    })
    this.hooks.notify(`Nothing missed: everything new on ${and_list(parts)} is in this view.`, undefined, `complete:${page.view_id}`)
  }

  // Labels of the items you saw in a view since a moment, oldest first and each once.
  seen_since(view_id: string, since: number): string[] {
    return [...new Set((this.seen_log.get(view_id) ?? []).filter((entry) => entry.at >= since).map((entry) => entry.label))]
  }

  // A page source that offers a feed: say once that the feed reads without a tab.
  offer_feeds(source: PageSource, feeds: Array<{ title: string; url: string }>): void {
    const [feed] = feeds
    this.hooks.notify(`${source.start_url} also offers a feed${feed.title ? `, ${feed.title}` : ""}: add "RSS: ${feed.url}" to Sources to read it without a tab.`, feed.url, `feed:${source.source_id}`)
  }

  // Feed sources that may still give more; following lists and watched pages are looked at, never read ahead.
  private open_sources(view_id: string): PageSource[] {
    const finished = this.finished.get(view_id) ?? new Set<string>()
    return (this.page_sources.get(view_id) ?? []).filter((source) => (source.purpose ?? "items") === "items" && !finished.has(source.source_id))
  }

  // One look at a watched page: its text goes to the brain, which says whether it changed and whether a view keeps the
  // change; an open lens shows it and the shell is told so it can alert you.
  async check_watch(source: PageSource, force: boolean): Promise<void> {
    const tag = source_tag(source.source_id)
    const outcome = await this.hooks.track(`Looking at ${source.start_url}`, () => this.readers.read_text(source, force))
    if (outcome.status === "skipped") return
    if (outcome.status === "challenge") {
      this.hooks.notify(challenge_text(source.source_id, outcome.driver), outcome.url, tag)
      return
    }
    if (outcome.status === "failed") {
      this.hooks.notify(`${source.start_url} could not be looked at: ${outcome.error}`, undefined, tag)
      return
    }
    this.hooks.retract(tag)
    const report = await this.brain.watch_report(source.start_url, outcome.page.title, outcome.page.text)
    if (!report.changed) return
    for (const context of this.lenses_reading(source.source_id)) await this.append_next(context)
    if (report.alert) this.hooks.alert(report.alert)
  }

  // An item a summarize rule wants: read in full, then summarized by the brain onto its card for the next time it shows.
  async summarize(wanted: ContentWanted): Promise<void> {
    const outcome = await this.hooks.track(`Reading ${wanted.url} in full`, () => this.readers.read_content(wanted.url, wanted.video))
    if (outcome.status === "failed" && outcome.budget) return
    const content = outcome.status === "read" ? outcome.content : { title: "", text: "", caption_url: null }
    const result = await this.brain.add_content(wanted.item_id, "summary", content.title, content.text, content.caption_url)
    if (!result.item) return
    for (const context of this.lenses.all()) {
      if (context.rendered.has(wanted.item_id)) context.send({ type: "update", items: [{ item: result.item, reasons: [] }], cursor: null })
    }
  }

  // An item you opened that a note rule covers: read in full and noted in today's journal.
  private async take_note(item: Item): Promise<void> {
    const outcome = await this.readers.read_content(item.url, false)
    if (outcome.status !== "read") return
    await this.brain.add_content(item.item_id, "note", outcome.content.title || label_of(item), outcome.content.text, outcome.content.caption_url)
  }

  // Open view lenses whose sources include this one.
  private lenses_reading(source_id: string): LensContext[] {
    const found: LensContext[] = []
    for (const [view_id, sources] of this.page_sources) {
      const context = this.lenses.get(view_lens_key(view_id))
      if (context && sources.some((source) => source.source_id === source_id)) found.push(context)
    }
    return found
  }

  private wanted_first(sources: PageSource[], records: number): Map<string, number> {
    return new Map(sources.map((source) => [source.source_id, source.purpose === "follows" ? FOLLOW_RECORDS : records]))
  }

  // Each warning shows once per view and version, so a notice you dismissed stays dismissed; one that no longer holds goes away
  // and shows again if it comes back.
  private report(page: ViewPage): void {
    for (const warning of this.warned.get(page.view_id) ?? []) {
      if (page.warnings.includes(warning)) continue
      this.hooks.retract(warning_tag(warning))
      for (const key of this.reported) if (key.startsWith(`${page.view_id}\0`) && key.endsWith(`\0${warning}`)) this.reported.delete(key)
    }
    this.warned.set(page.view_id, page.warnings)
    for (const warning of page.warnings) {
      const key = `${page.view_id}\0${page.version}\0${warning}`
      if (this.reported.has(key)) continue
      this.reported.add(key)
      this.hooks.notify(warning, undefined, warning_tag(warning))
    }
  }

  // The brain's feeds show as they arrive while page sources load in your session, which may wait for Chrome.
  // An edition opened by itself reads nothing: what it shows was read for it on schedule.
  async refresh(context: LensContext, force: boolean): Promise<void> {
    await this.hooks.track(`Updating ${context.view_id}`, async () => {
      const { page_sources } = await this.brain.refresh(context.view_id, force)
      this.page_sources.set(context.view_id, page_sources)
      this.finished.delete(context.view_id)
      this.complete.delete(context.view_id)
      if (this.complete_told.delete(context.view_id)) this.hooks.retract(`complete:${context.view_id}`)
      const reads = this.editioned.has(context.view_id) && !force ? page_sources.filter((source) => source.purpose === "follows") : page_sources
      const wanted = this.wanted_first(reads, FIRST_FILL_RECORDS)
      await Promise.all([this.settle(context), this.read_and_settle(context, reads, force, wanted, true)])
    })
  }

  // A scheduled read for an edition: the brain's feeds, then every page source from the top and deeper than a look.
  // It needs no open lens; it ends once the brain has fetched its feeds, so the edition can be marked read.
  async read_for_edition(view_id: string): Promise<void> {
    await this.hooks.track(`Reading for the next ${view_id} edition`, async () => {
      const { page_sources } = await this.brain.refresh(view_id, true)
      const wanted = this.wanted_first(page_sources, EDITION_RECORDS)
      // Not forced: a source read minutes ago, or resting after a sign in check, is not read again for the edition.
      await this.queued(view_id, () => this.read_sources(view_id, page_sources, false, wanted, true))
      await this.feeds_fetched(view_id)
    })
  }

  private async feeds_fetched(view_id: string): Promise<void> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      if (!(await this.brain.view_page(view_id, [])).reading) return
      await sleep(SETTLE_POLL_MS)
    }
  }

  // After a model change: follow the brain while it retries tagging, so warnings that no longer hold go away.
  async recheck(view_id: string): Promise<void> {
    const context = this.lenses.get(view_lens_key(view_id))
    if (context) await this.hooks.track(`Checking ${view_id} with the new model`, () => this.settle(context))
  }

  // Chrome connected after a read had to use openMoi's own session: read those sources again in Chrome.
  async chrome_connected(): Promise<void> {
    const waiting = [...this.waiting_for_chrome.values()]
    this.waiting_for_chrome.clear()
    for (const { view_id, source } of waiting) {
      const context = this.lenses.get(view_lens_key(view_id))
      if (context) await this.read_and_settle(context, [source], true, new Map([[source.source_id, FIRST_FILL_RECORDS]]), true)
      else await this.queued(view_id, () => this.read_sources(view_id, [source], true, new Map([[source.source_id, FIRST_FILL_RECORDS]]), true))
    }
  }

  // You are near the end of what is shown (or at it, when the lens asks for more): top the view up from the sources
  // that have more, asking each for enough raw items to fill the buffer after your rules hide some of them.
  // A read already going will append what it finds, so this one waits its turn rather than starting another.
  private async read_ahead(context: LensContext, at_end: boolean): Promise<void> {
    const view_id = context.view_id
    const sources = this.open_sources(view_id)
    if (!sources.length || this.reading.has(view_id) || this.editioned.has(view_id)) return
    const below = at_end ? 0 : context.rendered.size - 1 - (this.furthest.get(context.key) ?? -1)
    if (below >= READ_AHEAD_ITEMS) return
    const per_source = Math.ceil((BUFFER_ITEMS - below) / sources.length)
    const rates = this.keep_rates.get(view_id) ?? {}
    const wanted = new Map(sources.map((source) => [source.source_id, Math.min(MAX_FILL_RECORDS, Math.ceil(per_source / Math.max(rates[source.source_id] ?? 1, MIN_KEEP_RATE)))]))
    await this.hooks.track(`Reading ahead for ${view_id}`, () => this.read_and_settle(context, sources, true, wanted, false))
  }

  private read_and_settle(context: LensContext, sources: PageSource[], force: boolean, wanted: Map<string, number>, from_top: boolean): Promise<void> {
    if (!sources.length) return Promise.resolve()
    return this.queued(context.view_id, async () => {
      await this.read_sources(context.view_id, sources, force, wanted, from_top)
      await this.settle(context)
    })
  }

  // One read of a view's page sources at a time: a refresh during a read ahead or a scheduled read waits for it,
  // so two reads never scroll your Chrome at once.
  private queued(view_id: string, work: () => Promise<void>): Promise<void> {
    const run = (this.reading.get(view_id) ?? Promise.resolve()).catch(ignore).then(work)
    this.reading.set(view_id, run)
    return run.finally(() => {
      if (this.reading.get(view_id) === run) this.reading.delete(view_id)
    })
  }

  // A page read only while you browse it yourself: nothing to scroll; it needs a spec, which Mine in Chrome makes once.
  private assist(view_id: string, source: PageSource): void {
    this.finished.set(view_id, (this.finished.get(view_id) ?? new Set<string>()).add(source.source_id))
    const tag = source_tag(source.source_id)
    if (source.spec) {
      this.hooks.retract(tag)
      return
    }
    this.hooks.notify(
      `${source.start_url} is read only while you browse it yourself: open it in Chrome and press Mine once, so openMoi learns the page.`,
      source.start_url,
      tag,
    )
  }

  // A notice about a source is replaced by its latest read, so one that worked leaves nothing behind.
  private async read_sources(view_id: string, sources: PageSource[], force: boolean, wanted: Map<string, number>, from_top: boolean): Promise<void> {
    for (const source of sources) {
      if (source.purpose === "watch") {
        await this.check_watch(source, force)
        continue
      }
      if (source.mode === "assist") {
        this.assist(view_id, source)
        continue
      }
      const tag = source_tag(source.source_id)
      const outcome = await this.hooks.track(`Reading ${source.source_id}`, () =>
        this.readers.fill(
          source,
          wanted.get(source.source_id) ?? FIRST_FILL_RECORDS,
          (records) => {
            this.hooks.retract(tag)
            return source.purpose === "follows" ? this.store_follows(view_id, source, records) : this.ingest_batch(view_id, source, records)
          },
          force,
          from_top,
        ),
      )
      if (outcome.status === "skipped") continue
      this.hooks.retract(tag)
      if (outcome.status === "ended" || outcome.status === "exhausted" || outcome.status === "complete") {
        this.finished.set(view_id, (this.finished.get(view_id) ?? new Set<string>()).add(source.source_id))
        if (outcome.status === "complete") this.complete.set(view_id, (this.complete.get(view_id) ?? new Map<string, string | null>()).set(source.source_id, outcome.since))
      } else if (outcome.status === "challenge") {
        if (outcome.driver === "openmoi") this.waiting_for_chrome.set(`${view_id}\0${source.source_id}`, { view_id, source })
        this.hooks.notify(challenge_text(source.source_id, outcome.driver), outcome.url, tag)
      } else if (outcome.status === "failed") {
        this.hooks.notify(`${source.source_id} could not be read: ${outcome.error}`, undefined, tag)
      }
    }
  }

  // Appends whatever is new until the brain has finished fetching and tagging.
  private async settle(context: LensContext): Promise<void> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      const page = await this.append_next(context)
      if (!page.refreshing) return
      await sleep(SETTLE_POLL_MS)
    }
  }

  // After an edit: re-render now, then once more if the brain was still retagging items for new rules.
  async after_edit(view_id: string): Promise<void> {
    const context = this.lenses.get(view_lens_key(view_id))
    if (!context) return
    await this.hooks.track(`Updating ${view_id} with your change`, async () => {
      await context.serial(() => this.render(context))
      if (await this.waited_for_brain(view_id)) await context.serial(() => this.render(context))
    })
  }

  // Loads the view's current lens HTML; the lens announces ready and gets a fresh render.
  async reload_lens(view_id: string): Promise<void> {
    const context = this.lenses.get(view_lens_key(view_id))
    if (context) await this.lenses.load(context, await this.brain.lens(view_id, "feed"))
  }

  private async waited_for_brain(view_id: string): Promise<boolean> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      if (!(await this.brain.view_page(view_id, [])).refreshing) return attempt > 0
      await sleep(SETTLE_POLL_MS)
    }
    return true
  }

  // Who you follow changes who counts as a stranger, so an open lens shows the view again by the new circles.
  private async store_follows(view_id: string, source: PageSource, records: RawRecord[]): Promise<number[]> {
    await this.brain.follows(source.start_url, records)
    const context = this.lenses.get(view_lens_key(view_id))
    if (context) await context.serial(() => this.render(context))
    return []
  }

  // A lens open now (or opened during a scheduled read) gets what each batch adds. The reader learns which records the
  // brain had before, so a newest first page stops where an earlier read was.
  private async ingest_batch(view_id: string, source: PageSource, records: RawRecord[]): Promise<number[]> {
    const result = await this.brain.ingest(source.source_id, records, source.start_url)
    const context = this.lenses.get(view_lens_key(view_id))
    if (context) await this.append_next(context)
    return result?.already ?? []
  }

  private append_next(context: LensContext): Promise<ViewPage> {
    return context.serial(async () => {
      const page = await this.brain.view_page(context.view_id, [...context.rendered.keys()])
      if (page.keep_rate) this.keep_rates.set(context.view_id, page.keep_rate)
      if (page.items.length || !page.has_more) context.send({ type: "append", items: page.items, cursor: this.cursor_for(page) })
      this.report(page)
      this.edition_end(page)
      this.completeness(page)
      return page
    })
  }

  async on_event(context: LensContext, message: LensToHost): Promise<void> {
    const item = "item_id" in message ? context.rendered.get(message.item_id) : undefined
    if (message.type === "open" && item) {
      const recorded = await this.brain.events([{ view_id: context.view_id, item_id: item.item_id, event_kind: "open" }])
      this.hooks.open_original(item.url)
      if (recorded?.notes?.includes(item.item_id)) this.take_note(item).catch((error) => this.hooks.notify(`No note was taken: ${error}`))
    } else if (message.type === "play" && item) {
      await this.brain.events([{ view_id: context.view_id, item_id: item.item_id, event_kind: "open" }])
      if (!this.hooks.play(item)) this.hooks.open_original(item.url)
    } else if (message.type === "less_like_this" && item) {
      await this.brain.events([{ view_id: context.view_id, item_id: item.item_id, event_kind: "less_like_this" }])
      this.hooks.less_like_this(context.view_id, item)
    } else if (message.type === "more" && message.cursor === DEEPER_CURSOR) {
      await this.read_ahead(context, true)
    } else if (message.type === "more") {
      await this.append_next(context)
    } else if (message.type === "seen") {
      const known = message.item_ids.filter((item_id) => context.rendered.has(item_id))
      if (!known.length) return
      const log = this.seen_log.get(context.view_id) ?? []
      for (const item_id of known) log.push({ at: Date.now(), label: label_of(context.rendered.get(item_id) as Item) })
      this.seen_log.set(context.view_id, log)
      await this.brain.events(known.map((item_id) => ({ view_id: context.view_id, item_id, event_kind: "seen" })))
      const order = [...context.rendered.keys()]
      this.furthest.set(context.key, Math.max(this.furthest.get(context.key) ?? -1, ...known.map((item_id) => order.indexOf(item_id))))
      await this.read_ahead(context, false)
    }
  }
}
