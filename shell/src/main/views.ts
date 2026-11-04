// Feed style views: first render from cache, refresh sources, append new items, forward lens events.
import { sleep } from "../shared/timing"
import type { LensToHost, PageSource, RawRecord, ViewPage } from "../shared/types"
import type { BrainClient } from "./brain"
import type { LensContext, LensManager } from "./lenses"
import type { SourceReader } from "./sources"

const SETTLE_POLL_MS = 1_000
const SETTLE_ATTEMPTS = 30

export interface ViewHooks {
  open_tab(url: string): void
  notify(text: string, url?: string): void
}

export function view_lens_key(view_id: string): string {
  return `view:${view_id}`
}

function cursor_for(page: ViewPage): string | null {
  return page.has_more ? "more" : null
}

export class ViewController {
  constructor(
    private readonly brain: BrainClient,
    private readonly lenses: LensManager,
    private readonly sources: SourceReader,
    private readonly hooks: ViewHooks,
  ) {}

  async show(view_id: string): Promise<LensContext> {
    const existing = this.lenses.get(view_lens_key(view_id))
    if (existing) return existing
    return this.lenses.open(view_lens_key(view_id), view_id, await this.brain.lens(view_id, "feed"))
  }

  owns(context: LensContext): boolean {
    return context.key === view_lens_key(context.view_id)
  }

  on_ready(context: LensContext): void {
    context
      .serial(() => this.render_first(context))
      .then(() => this.refresh(context, false))
      .catch((error) => this.hooks.notify(`${context.view_id} could not load: ${error}`))
  }

  private async render_first(context: LensContext): Promise<void> {
    const page = await this.brain.view_page(context.view_id, [])
    context.send({ type: "render", items: page.items, cursor: cursor_for(page) })
    for (const warning of page.warnings) this.hooks.notify(warning)
  }

  // Reads page sources in your session, then appends whatever is new until the brain finishes its own feeds.
  async refresh(context: LensContext, force: boolean): Promise<void> {
    const { page_sources } = await this.brain.refresh(context.view_id, force)
    for (const source of page_sources) {
      const outcome = await this.sources.read(source, force, (records) => this.ingest_batch(context, source, records))
      if (outcome.status === "challenge") this.hooks.notify(`${source.source_id} needs you: sign in or finish the check, then refresh.`, outcome.url)
      else if (outcome.status === "failed") this.hooks.notify(`${source.source_id} could not be read: ${outcome.error}`)
    }
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      const page = await this.append_next(context)
      if (!page.refreshing) return
      await sleep(SETTLE_POLL_MS)
    }
  }

  private async ingest_batch(context: LensContext, source: PageSource, records: RawRecord[]): Promise<void> {
    await this.brain.ingest(source.source_id, records, source.start_url)
    await this.append_next(context)
  }

  private append_next(context: LensContext): Promise<ViewPage> {
    return context.serial(async () => {
      const page = await this.brain.view_page(context.view_id, [...context.rendered.keys()])
      if (page.items.length || !page.has_more) context.send({ type: "append", items: page.items, cursor: cursor_for(page) })
      return page
    })
  }

  async on_event(context: LensContext, message: LensToHost): Promise<void> {
    if (message.type === "open") {
      const item = context.rendered.get(message.item_id)
      if (!item) return
      await this.brain.events([{ view_id: context.view_id, item_id: item.item_id, event_kind: "open" }])
      this.hooks.open_tab(item.url)
    } else if (message.type === "more") {
      await this.append_next(context)
    } else if (message.type === "seen") {
      const known = message.item_ids.filter((item_id) => context.rendered.has(item_id))
      if (known.length) await this.brain.events(known.map((item_id) => ({ view_id: context.view_id, item_id, event_kind: "seen" })))
    }
  }
}
