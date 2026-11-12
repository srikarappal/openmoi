// Rung 2: what a page already says about itself in structured data, read without any extractor. JSON-LD, OpenGraph,
// microdata and the hydration state that Next.js and Nuxt pages ship, plus the feeds a page advertises. Records come
// from items the data names (an ItemList, products, articles), so a page can be read before or without a spec.
import type { RawRecord } from "./types"

const MAX_RECORDS = 200
const MAX_DEPTH = 12
const FEED_TYPES = ["application/rss+xml", "application/atom+xml", "application/feed+json"]
const ITEM_TYPES = new Set(["Product", "Article", "NewsArticle", "BlogPosting", "VideoObject", "SocialMediaPosting", "Event", "Recipe", "Offer", "ListItem", "CreativeWork"])

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
    .map((link) => ({ title: link.getAttribute("title") ?? "", url: new URL(link.getAttribute("href") ?? "", page_url).href }))
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

// One schema.org item as a record: its name, link, text, picture, author, time, price and rating where it says.
function record_of(node: Node, page_url: string): RawRecord | null {
  const inner = is_node(node.item) ? node.item : node
  const url = absolute(text_of(inner.url ?? inner["@id"] ?? node.url), page_url)
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

// Every node in a JSON value that names an item type, depth first, with ItemList members unwrapped.
function item_nodes(value: unknown, found: Node[], depth = 0): void {
  if (depth > MAX_DEPTH || found.length >= MAX_RECORDS) return
  if (Array.isArray(value)) {
    for (const entry of value) item_nodes(entry, found, depth + 1)
    return
  }
  if (!is_node(value)) return
  if (types_of(value).some((type) => ITEM_TYPES.has(type))) {
    found.push(value)
    return
  }
  for (const entry of Object.values(value)) item_nodes(entry, found, depth + 1)
}

// Records the structured data names, each URL once, in page order.
export function structured_records(structured: Structured, page_url: string): RawRecord[] {
  const nodes: Node[] = []
  item_nodes([...structured.json_ld, ...structured.microdata], nodes)
  const seen = new Set<string>()
  const records: RawRecord[] = []
  for (const node of nodes) {
    const record = record_of(node, page_url)
    if (record && !seen.has(record.url)) {
      seen.add(record.url)
      records.push(record)
    }
  }
  return records
}
