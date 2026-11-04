// Mine: your own version of any page, in openMoi or in your Chrome. Articles go through reader mode;
// listings through a saved or generated extractor. The page itself is only read, never changed or closed.
import { site_domain } from "../shared/address"
import { is_good_extraction } from "../shared/extract"
import type { ExtractorSpec, Item, LensToHost, RawRecord, ViewItem } from "../shared/types"
import type { BrainClient } from "./brain"
import { explain } from "./chat"
import type { PageDriver } from "./drivers"
import type { LensContext, LensManager } from "./lenses"

const ATTEMPTS = 2
type PageKind = "article" | "listing"

// The page to read: its lens key, the driver that reaches it and the driver's handle for it.
export interface MineTarget {
  key: string
  driver: PageDriver
  handle: string
  url: string
}

interface MinePage {
  target: MineTarget
  view_id: string
  source_id: string
  kind: PageKind
  records: RawRecord[]
  view_items: ViewItem[]
}

export interface MineHooks {
  notify(text: string): void
  open_original(key: string, url: string): void
  lens_stale(view_id: string, kind: PageKind, layout_hash: string): void
  less_like_this(view_id: string, item: Item): void
}

export function tab_mine_key(tab_id: number): string {
  return `tab:${tab_id}`
}

export function chrome_mine_key(page_id: number): string {
  return `chrome:${page_id}`
}

function usable(records: RawRecord[]): number {
  return records.filter((record) => record.url && (record.title || record.text)).length
}

function extract(target: MineTarget, spec: ExtractorSpec): Promise<RawRecord[]> {
  return target.driver.run<RawRecord[]>(target.handle, "extract", { spec })
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

  view_for(key: string): string | undefined {
    return this.pages.get(key)?.view_id
  }

  // Builds the Mine view of the target page; false when the page could not be read.
  async enable(target: MineTarget): Promise<boolean> {
    const found = await this.read_page(target)
    if (!found) return false
    const domain = site_domain(target.url)
    const page: MinePage = { target, view_id: `site_${domain}`, source_id: `site:${domain}`, ...found, view_items: [] }
    await this.rank(page)
    this.pages.set(target.key, page)
    const html = await this.brain.lens(page.view_id, page.kind)
    const existing = this.lenses.get(target.key)
    if (existing) await this.lenses.load(existing, html)
    else await this.lenses.open(target.key, page.view_id, html)
    return true
  }

  disable(key: string): void {
    this.pages.delete(key)
    this.lenses.close(key)
  }

  private async read_page(target: MineTarget): Promise<{ kind: PageKind; records: RawRecord[] } | null> {
    try {
      const article = await target.driver.run<RawRecord | null>(target.handle, "readability")
      if (article) return { kind: "article", records: [article] }
      const records = await this.listing_records(target)
      return records ? { kind: "listing", records } : null
    } catch (error) {
      this.hooks.notify(`Could not read this page: ${explain(error)}`)
      return null
    }
  }

  // The saved spec first; a missing or broken one is regenerated from the page skeleton, at most twice.
  private async listing_records(target: MineTarget): Promise<RawRecord[] | null> {
    const saved = await this.brain.find_extractor(target.url)
    let last_error: string | undefined
    if (saved) {
      const records = await extract(target, saved)
      if (is_good_extraction(records)) return records
      last_error = `the saved spec v${saved.version} found ${usable(records)} items with a title and url`
    }
    const skeleton = await target.driver.run<string>(target.handle, "skeleton")
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        const spec = await this.brain.generate_extractor(target.url, skeleton, last_error)
        const records = await extract(target, spec)
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
    const result = await this.brain.ingest(page.source_id, page.records, page.target.url, page.view_id, page.kind)
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
      this.hooks.open_original(context.key, item.url)
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
