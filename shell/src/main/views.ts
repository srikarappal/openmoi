// Feed style views: render from cache, refresh sources, append new items, re-render after edits, forward lens events.
import { sleep } from "../shared/timing"
import type { Item, LensToHost, PageSource, RawRecord, ViewPage } from "../shared/types"
import type { BrainClient } from "./brain"
import type { DriverKind } from "./drivers"
import type { LensContext, LensManager } from "./lenses"
import type { SourceReader } from "./sources"

const SETTLE_POLL_MS = 1_000
const SETTLE_ATTEMPTS = 30

export interface ViewHooks {
  open_original(url: string): void
  notify(text: string, url?: string, tag?: string): void
  retract(tag: string): void
  echo(text: string): void
  less_like_this(view_id: string, item: Item): void
  lens_stale(view_id: string, layout_hash: string): void
}

export function view_lens_key(view_id: string): string {
  return `view:${view_id}`
}

// In Chrome you only need to sign in; without the relay, openMoi's own session is the one missing the sign in.
function challenge_text(source_id: string, driver: DriverKind): string {
  if (driver === "chrome") return `${source_id} needs you in Chrome: sign in or finish the check there, then refresh.`
  return `${source_id} needs your Chrome sign in: open Chrome with the openMoi extension and it loads by itself, or sign in here, then refresh.`
}

function source_tag(source_id: string): string {
  return `source:${source_id}`
}

function cursor_for(page: ViewPage): string | null {
  return page.has_more ? "more" : null
}

export class ViewController {
  private readonly versions = new Map<string, string>()
  private readonly summaries = new Map<string, string>()
  private readonly reported = new Set<string>()
  private readonly waiting_for_chrome = new Map<string, { view_id: string; source: PageSource }>()

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
    context.send({ type: "render", items: page.items, cursor: cursor_for(page) })
    this.versions.set(context.view_id, page.version)
    const previous = this.summaries.get(context.view_id)
    if (previous !== undefined && previous !== page.summary) this.hooks.echo(`I understood: ${page.summary}`)
    this.summaries.set(context.view_id, page.summary)
    this.report(page)
    if (page.lens_stale) this.hooks.lens_stale(context.view_id, page.layout_hash)
  }

  // Each warning shows once per view, so a notice you dismissed stays dismissed.
  private report(page: ViewPage): void {
    for (const warning of page.warnings) {
      const key = `${page.view_id}\0${page.version}\0${warning}`
      if (this.reported.has(key)) continue
      this.reported.add(key)
      this.hooks.notify(warning)
    }
  }

  // The brain's feeds show as they arrive while page sources load in your session, which may wait for Chrome.
  async refresh(context: LensContext, force: boolean): Promise<void> {
    const { page_sources } = await this.brain.refresh(context.view_id, force)
    await Promise.all([this.settle(context), this.read_sources(context, page_sources, force)])
  }

  // Chrome connected after a read had to use openMoi's own session: read those sources again in Chrome.
  async chrome_connected(): Promise<void> {
    const waiting = [...this.waiting_for_chrome.values()]
    this.waiting_for_chrome.clear()
    for (const { view_id, source } of waiting) {
      const context = this.lenses.get(view_lens_key(view_id))
      if (context) await this.read_sources(context, [source], true)
    }
  }

  // A notice about a source is replaced by its latest read, so one that worked leaves nothing behind.
  private async read_sources(context: LensContext, sources: PageSource[], force: boolean): Promise<void> {
    for (const source of sources) {
      const tag = source_tag(source.source_id)
      const outcome = await this.sources.read(source, force, (records) => {
        this.hooks.retract(tag)
        return this.ingest_batch(context, source, records)
      })
      if (outcome.status === "skipped") continue
      this.hooks.retract(tag)
      if (outcome.status === "challenge") {
        if (outcome.driver === "openmoi") this.waiting_for_chrome.set(`${context.view_id}\0${source.source_id}`, { view_id: context.view_id, source })
        this.hooks.notify(challenge_text(source.source_id, outcome.driver), outcome.url, tag)
      } else if (outcome.status === "failed") {
        this.hooks.notify(`${source.source_id} could not be read: ${outcome.error}`, undefined, tag)
      }
    }
    if (sources.length) await this.settle(context)
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
    await context.serial(() => this.render(context))
    if (await this.waited_for_brain(view_id)) await context.serial(() => this.render(context))
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
      if (page.items.length || !page.has_more) context.send({ type: "append", items: page.items, cursor: cursor_for(page) })
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
    } else if (message.type === "more") {
      await this.append_next(context)
    } else if (message.type === "seen") {
      const known = message.item_ids.filter((item_id) => context.rendered.has(item_id))
      if (known.length) await this.brain.events(known.map((item_id) => ({ view_id: context.view_id, item_id, event_kind: "seen" })))
    }
  }
}
