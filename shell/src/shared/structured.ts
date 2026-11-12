// Rung 2: what a page already says about itself in structured data, read without any extractor. JSON-LD, OpenGraph,
// microdata and the hydration state that Next.js and Nuxt pages ship, plus the feeds a page advertises. Records come
// from items the data names (an ItemList, products, articles), so a page can be read before or without a spec.
import type { RawRecord } from "./types"

const MAX_RECORDS = 200
const MAX_DEPTH = 12
const FEED_TYPES = ["application/rss+xml", "application/atom+xml", "application/feed+json"]
const ITEM_TYPES = new Set(["Product", "Article", "NewsArticle", "BlogPosting", "VideoObject", "SocialMediaPosting", "Event", "Recipe", "CreativeWork"])
// Types whose url, when they have none, is the page itself: the page's main thing.
const MAIN_TYPES = new Set(["Product", "Article", "NewsArticle", "BlogPosting", "VideoObject", "Event", "Recipe"])

export interface Structured {
  json_ld: unknown[]
  open_graph: Record<string, string>
  microdata: unknown[]
  hydration: unknown[]
  feeds: Array<{ title: string; url: string }>
}

type Node = Record<string, unknown>

function is_node(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parse_json(text: string | null | undefined): unknown {
  try {
    return JSON.parse(text ?? "")
  } catch {
    return null
  }
}

function microdata_value(element: Element): unknown {
  if (element.hasAttribute("itemscope")) return microdata_item(element)
  const attribute = ["content", "href", "src", "datetime"].find((name) => element.hasAttribute(name))
  return (attribute ? element.getAttribute(attribute) : element.textContent?.trim()) ?? ""
}

// One itemscope element as {"@type": ..., property: value}, nested items included, its own descendants only.
function microdata_item(root: Element): Node {
  const type = (root.getAttribute("itemtype") ?? "").split("/").pop() ?? ""
  const item: Node = { "@type": type }
  for (const element of Array.from(root.querySelectorAll("[itemprop]"))) {
    if (element.parentElement?.closest("[itemscope]") !== root) continue
    const value = microdata_value(element)
    for (const name of (element.getAttribute("itemprop") ?? "").split(/\s+/).filter(Boolean)) item[name] = value
  }
  return item
}

export function read_structured(doc: Document, page_url: string): Structured {
  const json_ld = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))
    .map((script) => parse_json(script.textContent))
    .filter((value) => value !== null)
  const open_graph: Record<string, string> = {}
  for (const meta of Array.from(doc.querySelectorAll('meta[property^="og:"], meta[name^="og:"]'))) {
    const key = (meta.getAttribute("property") ?? meta.getAttribute("name") ?? "").slice(3)
    if (key && !(key in open_graph)) open_graph[key] = meta.getAttribute("content") ?? ""
  }
  const microdata = Array.from(doc.querySelectorAll("[itemscope]"))
    .filter((element) => !element.parentElement?.closest("[itemscope]"))
    .map(microdata_item)
  const hydration = ["script#__NEXT_DATA__", "script#__NUXT_DATA__"].map((selector) => parse_json(doc.querySelector(selector)?.textContent)).filter((value) => value !== null)
  const feeds = Array.from(doc.querySelectorAll("link[rel~=alternate][href]"))
    .filter((link) => FEED_TYPES.includes((link.getAttribute("type") ?? "").toLowerCase()))
    .map((link) => ({ title: link.getAttribute("title") ?? "", url: absolute(link.getAttribute("href") ?? "", page_url) }))
    .filter((feed) => feed.url)
  return { json_ld, open_graph, microdata, hydration, feeds }
}

function text_of(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number") return String(value)
  if (is_node(value)) return text_of(value.name ?? value["@id"] ?? value.url ?? "")
  if (Array.isArray(value)) return text_of(value[0])
  return ""
}

function types_of(node: Node): string[] {
  const type = node["@type"]
  return (Array.isArray(type) ? type : [type]).filter((value): value is string => typeof value === "string")
}

function absolute(url: string, page_url: string): string {
  try {
    return url ? new URL(url, page_url).href : ""
  } catch {
    return ""
  }
}

// One schema.org item as a record: its name, link, text, picture, author, time, price and rating where it says. A main
// item at the top of the page's data without a link of its own is the page itself.
function record_of(node: Node, page_url: string, top_level: boolean): RawRecord | null {
  const inner = is_node(node.item) ? node.item : node
  const raw = text_of(inner.url ?? inner["@id"] ?? node.url)
  const url = raw ? absolute(raw, page_url) : top_level && types_of(inner).some((type) => MAIN_TYPES.has(type)) ? page_url : ""
  const title = text_of(inner.name ?? inner.headline)
  if (!url || !title) return null
  const offers = (Array.isArray(inner.offers) ? inner.offers[0] : inner.offers) as Node | undefined
  const rating = inner.aggregateRating as Node | undefined
  const record: RawRecord = { native_id: url, url, title }
  const fields: Array<[string, string]> = [
    ["text", text_of(inner.description)],
    ["image_url", absolute(text_of(inner.image), page_url)],
    ["author_name", text_of(inner.author)],
    ["published_at", text_of(inner.datePublished ?? inner.uploadDate ?? inner.startDate)],
    ["extra.price_text", offers ? `${text_of(offers.priceCurrency)} ${text_of(offers.price)}`.trim() : ""],
    ["extra.rating_text", rating ? `${text_of(rating.ratingValue)} out of ${text_of(rating.bestRating) || "5"}` : ""],
  ]
  for (const [key, value] of fields) if (value) record[key] = value
  if (types_of(inner).includes("Product")) record.kind = "product"
  else if (types_of(inner).includes("VideoObject")) record.kind = "video"
  return record
}

interface Found {
  node: Node
  top_level: boolean
}

// Every node in a JSON value that names an item type, depth first. An ItemList's members count (a member that only
// names an item and its link too); breadcrumbs never do.
// nested: inside another typed node (an ItemList, a page), so not the page's own main thing.
function item_nodes(value: unknown, found: Found[], depth = 0, in_list = false, nested = false): void {
  if (depth > MAX_DEPTH || found.length >= MAX_RECORDS) return
  if (Array.isArray(value)) {
    for (const entry of value) item_nodes(entry, found, depth + 1, in_list, nested)
    return
  }
  if (!is_node(value)) return
  const types = types_of(value)
  if (types.includes("BreadcrumbList")) return
  if (types.some((type) => ITEM_TYPES.has(type))) {
    found.push({ node: value, top_level: !nested })
    return
  }
  if (types.includes("ListItem") && in_list) {
    if (is_node(value.item) && types_of(value.item).some((type) => ITEM_TYPES.has(type))) found.push({ node: value.item, top_level: false })
    else found.push({ node: value, top_level: false })
    return
  }
  for (const entry of Object.values(value)) item_nodes(entry, found, depth + 1, in_list || types.includes("ItemList"), nested || types.length > 0)
}

// Records the structured data names, each URL once in page order; a second node for the same URL fills what the first
// left out (a product's price, say).
export function structured_records(structured: Structured, page_url: string): RawRecord[] {
  const found: Found[] = []
  item_nodes([...structured.json_ld, ...structured.microdata], found)
  const by_url = new Map<string, RawRecord>()
  for (const { node, top_level } of found) {
    const record = record_of(node, page_url, top_level)
    if (!record) continue
    const existing = by_url.get(record.url)
    if (existing) for (const [key, value] of Object.entries(record)) existing[key] ??= value
    else by_url.set(record.url, record)
  }
  return [...by_url.values()]
}
