// Mine: your own version of any page. Articles go through reader mode; listings through a saved or generated extractor.
import type { WebContents } from "electron"
import { site_domain } from "../shared/address"
import { is_good_extraction } from "../shared/extract"
import type { ExtractorSpec, Item, LensToHost, RawRecord, ViewItem } from "../shared/types"
import type { BrainClient } from "./brain"
import { explain } from "./chat"
import type { LensContext, LensManager } from "./lenses"
import { call_page } from "./page_rpc"
import type { Tab } from "./tabs"

const ATTEMPTS = 2
type PageKind = "article" | "listing"

interface MinePage {
  tab_id: number
  url: string
  view_id: string
  source_id: string
  kind: PageKind
  records: RawRecord[]
  view_items: ViewItem[]
}

export interface MineHooks {
  notify(text: string): void
  open_in_tab(tab_id: number, url: string): void
  lens_stale(view_id: string, kind: PageKind, layout_hash: string): void
  less_like_this(view_id: string, item: Item): void
}

export function mine_lens_key(tab_id: number): string {
  return `tab:${tab_id}`
}

function usable(records: RawRecord[]): number {
  return records.filter((record) => record.url && (record.title || record.text)).length
}

function extract(contents: WebContents, spec: ExtractorSpec): Promise<RawRecord[]> {
  return call_page<RawRecord[]>(contents, "extract", { spec })
}

export class MineController {
  private readonly pages = new Map<string, MinePage>()

  constructor(
    private readonly brain: BrainClient,
    private readonly lenses: LensManager,
    private readonly hooks: MineHooks,
  ) {}

  owns(context: LensContext): boolean {
    return this.pages.has(context.key)
  }

  view_for_tab(tab_id: number): string | undefined {
    return this.pages.get(mine_lens_key(tab_id))?.view_id
  }

  // Builds the Mine view of the tab's page; false when the page could not be read.
  async enable(tab: Tab): Promise<boolean> {
    const contents = tab.view.webContents
    const url = contents.getURL()
    const found = await this.read_page(contents, url)
    if (!found) return false
    const domain = site_domain(url)
    const page: MinePage = { tab_id: tab.tab_id, url, view_id: `site_${domain}`, source_id: `site:${domain}`, ...found, view_items: [] }
    await this.rank(page)
    const key = mine_lens_key(tab.tab_id)
    this.pages.set(key, page)
    const html = await this.brain.lens(page.view_id, page.kind)
    const existing = this.lenses.get(key)
    if (existing) await this.lenses.load(existing, html)
    else await this.lenses.open(key, page.view_id, html)
    return true
  }

  disable(tab_id: number): void {
    this.pages.delete(mine_lens_key(tab_id))
    this.lenses.close(mine_lens_key(tab_id))
  }

  private async read_page(contents: WebContents, url: string): Promise<{ kind: PageKind; records: RawRecord[] } | null> {
    const article = await call_page<RawRecord | null>(contents, "readability")
    if (article) return { kind: "article", records: [article] }
    const records = await this.listing_records(contents, url)
    return records ? { kind: "listing", records } : null
  }

  // The saved spec first; a missing or broken one is regenerated from the page skeleton, at most twice.
  private async listing_records(contents: WebContents, url: string): Promise<RawRecord[] | null> {
    const saved = await this.brain.find_extractor(url)
    let last_error: string | undefined
    if (saved) {
      const records = await extract(contents, saved)
      if (is_good_extraction(records)) return records
      last_error = `the saved spec v${saved.version} found ${usable(records)} items with a title and url`
    }
    const skeleton = await call_page<string>(contents, "skeleton")
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        const spec = await this.brain.generate_extractor(url, skeleton, last_error)
        const records = await extract(contents, spec)
        if (is_good_extraction(records)) {
          await this.brain.accept_extractor(spec)
          return records
        }
        last_error = `the spec found ${usable(records)} items with a title and url; it needs at least 3`
      } catch (error) {
        last_error = explain(error)
      }
    }
    this.hooks.notify(`Could not make a Mine view of this page: ${last_error}`)
    return null
  }

  private async rank(page: MinePage): Promise<void> {
    const result = await this.brain.ingest(page.source_id, page.records, page.url, page.view_id, page.kind)
    page.view_items = result.view_items
    if (result.lens_stale) this.hooks.lens_stale(page.view_id, page.kind, result.layout_hash)
  }

  on_ready(context: LensContext): void {
    const page = this.pages.get(context.key)
    if (page) context.send({ type: "render", items: page.view_items, cursor: null })
  }

  async on_event(context: LensContext, message: LensToHost): Promise<void> {
    const page = this.pages.get(context.key)
    const item = "item_id" in message ? context.rendered.get(message.item_id) : undefined
    if (!page || !item) return
    if (message.type === "open") {
      await this.brain.events([{ view_id: page.view_id, item_id: item.item_id, event_kind: "open" }])
      this.hooks.open_in_tab(page.tab_id, item.url)
    } else if (message.type === "less_like_this") {
      this.hooks.less_like_this(page.view_id, item)
    }
  }

  // A site view's rules changed: rank every open page of that site again.
  async after_edit(view_id: string): Promise<void> {
    for (const [key, page] of this.pages) {
      if (page.view_id !== view_id) continue
      await this.rank(page)
      this.lenses.get(key)?.send({ type: "render", items: page.view_items, cursor: null })
    }
  }

  async reload_lens(view_id: string): Promise<void> {
    for (const [key, page] of this.pages) {
      const context = this.lenses.get(key)
      if (page.view_id === view_id && context) await this.lenses.load(context, await this.brain.lens(view_id, page.kind))
    }
  }
}
