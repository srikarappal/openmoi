// Feed style views: render from cache, refresh sources, append new items, re-render after edits, forward lens events.
import { sleep } from "../shared/timing"
import type { Item, LensToHost, PageSource, RawRecord, ViewPage } from "../shared/types"
import type { Track } from "./activity"
import type { BrainClient } from "./brain"
import type { DriverKind } from "./drivers"
import type { LensContext, LensManager } from "./lenses"
import type { SourceReader } from "./sources"

const SETTLE_POLL_MS = 1_000
const SETTLE_ATTEMPTS = 30
const MORE_CURSOR = "more"
// Past the stored items the lens may ask to read the page sources further down, one more budget of scrolling each time.
const DEEPER_CURSOR = "deeper"
const MAX_DEPTH = 4

export interface ViewHooks {
  open_original(url: string): void
  notify(text: string, url?: string, tag?: string): void
  retract(tag: string): void
  echo(text: string): void
  less_like_this(view_id: string, item: Item): void
  lens_stale(view_id: string, layout_hash: string): void
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
  private readonly depths = new Map<string, number>()
  private readonly reached = new Map<string, number>()
  private readonly deepening = new Set<string>()
  private readonly reading = new Map<string, Promise<void>>()

  constructor(
    private readonly brain: BrainClient,
    private readonly lenses: LensManager,
    private readonly sources: SourceReader,
    private readonly hooks: ViewHooks,
  ) {}

  // Opens the view's lens, or re-renders an open one whose files changed since it last rendered.
  async show(view_id: string): Promise<LensContext> {
    const existing = this.lenses.get(view_lens_key(view_id))
    if (!existing) return this.lenses.open(view_lens_key(view_id), view_id, await this.brain.lens(view_id, "feed"))
    const page = await this.brain.view_page(view_id, [])
    if (page.version !== this.versions.get(view_id)) await existing.serial(() => this.render(existing))
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
    context.send({ type: "render", items: page.items, cursor: this.cursor_for(page) })
    this.versions.set(context.view_id, page.version)
    const previous = this.summaries.get(context.view_id)
    if (previous !== undefined && previous !== page.summary) this.hooks.echo(`I understood: ${page.summary}`)
    this.summaries.set(context.view_id, page.summary)
    this.report(page)
    if (page.lens_stale) this.hooks.lens_stale(context.view_id, page.layout_hash)
  }

  // The next page of stored items, else reading the page sources further down, else caught up.
  private cursor_for(page: ViewPage): string | null {
    if (page.has_more) return MORE_CURSOR
    const deeper = (this.page_sources.get(page.view_id)?.length ?? 0) > 0 && (this.depths.get(page.view_id) ?? 1) < MAX_DEPTH
    return deeper ? DEEPER_CURSOR : null
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
  async refresh(context: LensContext, force: boolean): Promise<void> {
    await this.hooks.track(`Updating ${context.view_id}`, async () => {
      const { page_sources } = await this.brain.refresh(context.view_id, force)
      this.page_sources.set(context.view_id, page_sources)
      await Promise.all([this.settle(context), this.read_and_settle(context, page_sources, force, 1)])
    })
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
      if (context) await this.read_and_settle(context, [source], true, 1)
    }
  }

  // You scrolled past everything stored: read the page sources again and further down, at the same human pace.
  // A read still running may bring the next items, so it finishes first; only then, with nothing new waiting, go deeper.
  private async go_deeper(context: LensContext): Promise<void> {
    const view_id = context.view_id
    if (this.deepening.has(view_id)) return
    this.deepening.add(view_id)
    try {
      await this.reading.get(view_id)
      const page = await this.append_next(context)
      const depth = (this.depths.get(view_id) ?? 1) + 1
      if (page.items.length || page.has_more || depth > MAX_DEPTH) return
      this.depths.set(view_id, depth)
      await this.hooks.track(`Reading further down for ${view_id}`, () => this.read_and_settle(context, this.page_sources.get(view_id) ?? [], true, depth))
    } finally {
      this.deepening.delete(view_id)
    }
  }

  // One read of a view's page sources at a time: a refresh during a read further down waits for it, so two reads never
  // scroll your Chrome at once.
  private read_and_settle(context: LensContext, sources: PageSource[], force: boolean, depth: number): Promise<void> {
    if (!sources.length) return Promise.resolve()
    const view_id = context.view_id
    const run = (this.reading.get(view_id) ?? Promise.resolve()).catch(ignore).then(() => this.read_once(context, sources, force, depth))
    this.reading.set(view_id, run)
    return run.finally(() => {
      if (this.reading.get(view_id) === run) this.reading.delete(view_id)
    })
  }

  // A read further down that reached no more records than the one before means the page has nothing more: caught up.
  private async read_once(context: LensContext, sources: PageSource[], force: boolean, depth: number): Promise<void> {
    const view_id = context.view_id
    if (depth === 1) this.depths.set(view_id, 1)
    const reached = await this.read_sources(context, sources, force, depth)
    const previous = depth > 1 ? (this.reached.get(view_id) ?? 0) : 0
    this.reached.set(view_id, reached)
    if (depth > 1 && reached <= previous) this.depths.set(view_id, MAX_DEPTH)
    await this.settle(context)
  }

  // A notice about a source is replaced by its latest read, so one that worked leaves nothing behind. Returns the records reached.
  private async read_sources(context: LensContext, sources: PageSource[], force: boolean, depth: number): Promise<number> {
    let reached = 0
    for (const source of sources) {
      const tag = source_tag(source.source_id)
      const outcome = await this.hooks.track(`Reading ${source.source_id}`, () =>
        this.sources.read(
          source,
          force,
          (records) => {
            this.hooks.retract(tag)
            return this.ingest_batch(context, source, records)
          },
          depth,
        ),
      )
      if (outcome.status === "skipped") continue
      this.hooks.retract(tag)
      if (outcome.status === "read") {
        reached += outcome.count
      } else if (outcome.status === "challenge") {
        if (outcome.driver === "openmoi") this.waiting_for_chrome.set(`${context.view_id}\0${source.source_id}`, { view_id: context.view_id, source })
        this.hooks.notify(challenge_text(source.source_id, outcome.driver), outcome.url, tag)
      } else if (outcome.status === "failed") {
        this.hooks.notify(`${source.source_id} could not be read: ${outcome.error}`, undefined, tag)
      }
    }
    return reached
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

  private async ingest_batch(context: LensContext, source: PageSource, records: RawRecord[]): Promise<void> {
    await this.brain.ingest(source.source_id, records, source.start_url)
    await this.append_next(context)
  }

  private append_next(context: LensContext): Promise<ViewPage> {
    return context.serial(async () => {
      const page = await this.brain.view_page(context.view_id, [...context.rendered.keys()])
      if (page.items.length || !page.has_more) context.send({ type: "append", items: page.items, cursor: this.cursor_for(page) })
      this.report(page)
      return page
    })
  }

  async on_event(context: LensContext, message: LensToHost): Promise<void> {
    const item = "item_id" in message ? context.rendered.get(message.item_id) : undefined
    if (message.type === "open" && item) {
      await this.brain.events([{ view_id: context.view_id, item_id: item.item_id, event_kind: "open" }])
      this.hooks.open_original(item.url)
    } else if (message.type === "less_like_this" && item) {
      await this.brain.events([{ view_id: context.view_id, item_id: item.item_id, event_kind: "less_like_this" }])
      this.hooks.less_like_this(context.view_id, item)
    } else if (message.type === "more" && message.cursor === DEEPER_CURSOR) {
      await this.go_deeper(context)
    } else if (message.type === "more") {
      await this.append_next(context)
    } else if (message.type === "seen") {
      const known = message.item_ids.filter((item_id) => context.rendered.has(item_id))
      if (known.length) await this.brain.events(known.map((item_id) => ({ view_id: context.view_id, item_id, event_kind: "seen" })))
    }
  }
}
