// Mine: your own version of any page, in openMoi or in your Chrome. Articles go through reader mode;
// listings through a saved or generated extractor. The page itself is only read, never changed or closed.
import { site_domain } from "../shared/address"
import type { Item, LensToHost, RawRecord, StructuredPage, ViewItem } from "../shared/types"
import type { BrainClient } from "./brain"
import { explain } from "./chat"
import type { PageDriver } from "./drivers"
import type { LensContext, LensManager } from "./lenses"
import { find_listing_spec } from "./listing_spec"

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

function ignore(): void {}

export function tab_mine_key(tab_id: number): string {
  return `tab:${tab_id}`
}

export function chrome_mine_key(page_id: number): string {
  return `chrome:${page_id}`
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

  // Lets go of the page handle too; for your own tab or Chrome page that only forgets it, the page stays open.
  disable(key: string): void {
    const page = this.pages.get(key)
    this.pages.delete(key)
    this.lenses.close(key)
    page?.target.driver.close(page.target.handle).catch(ignore)
  }

  // Reader mode for an article; a product page by its own structured data; any other page by its spec, falling back
  // to the items its structured data names before a new spec is written.
  private async read_page(target: MineTarget): Promise<{ kind: PageKind; records: RawRecord[] } | null> {
    try {
      const article = await target.driver.run<RawRecord | null>(target.handle, "readability")
      if (article) return { kind: "article", records: [article] }
      const page = await target.driver.run<StructuredPage | null>(target.handle, "structured")
      const product = page?.page_type === "product" ? page.records.find((record) => record.kind === "product") : undefined
      if (product) return { kind: "listing", records: [product] }
      const records = await this.listing_records(target, page?.records ?? [])
      return records ? { kind: "listing", records } : null
    } catch (error) {
      this.hooks.notify(`Could not read this page: ${explain(error)}`)
      return null
    }
  }

  private async listing_records(target: MineTarget, structured: RawRecord[]): Promise<RawRecord[] | null> {
    const found = await find_listing_spec(this.brain, target.driver, target.handle, target.url, await this.brain.find_extractor(target.url), null, structured)
    if ("records" in found) return found.records
    this.hooks.notify(`Could not make a Mine view of this page: ${found.problem}`)
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
