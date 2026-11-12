// What kind of page this is, from what the page says about itself and its shape: Mine picks reader mode, a product
// view or a listing by it. Checks run from the most specific kind to the most general.
import type { Structured } from "./structured"

export type PageType = "video" | "product" | "search" | "profile" | "thread" | "article" | "feed" | "listing"

const SEARCH_PARAMS = ["q", "query", "k", "keywords", "search_query", "search"]
const COMMENTS = '[itemprop="comment"], [role="comment"], [data-testid*="comment" i], .comment, .reply'
const MIN_COMMENTS = 5
const MIN_POSTS = 5

function main_types(structured: Structured): string[] {
  const types: string[] = []
  for (const value of [...structured.json_ld, ...structured.microdata]) {
    const nodes = Array.isArray(value) ? value : [value]
    for (const node of nodes) {
      const type = typeof node === "object" && node !== null ? (node as Record<string, unknown>)["@type"] : undefined
      for (const entry of Array.isArray(type) ? type : [type]) if (typeof entry === "string") types.push(entry)
    }
  }
  return types
}

function is_search(url: URL): boolean {
  return /\/search\b|\/s$/.test(url.pathname) || SEARCH_PARAMS.some((param) => url.searchParams.has(param))
}

function is_video(url: URL, og_type: string, types: string[]): boolean {
  const host = url.hostname.replace(/^(www|m)\./, "")
  return og_type.startsWith("video") || (host === "youtube.com" && url.pathname === "/watch") || host === "youtu.be" || types.includes("VideoObject")
}

export function classify_page(doc: Document, page_url: string, structured: Structured, readerable: boolean): PageType {
  const url = new URL(page_url)
  const og_type = (structured.open_graph.type ?? "").toLowerCase()
  const types = main_types(structured)
  if (is_video(url, og_type, types)) return "video"
  if (og_type.includes("product") || (types.includes("Product") && !types.includes("ItemList"))) return "product"
  if (is_search(url) || types.includes("SearchResultsPage")) return "search"
  if (og_type === "profile" || types.includes("ProfilePage") || types.includes("Person")) return "profile"
  if (doc.querySelectorAll(COMMENTS).length >= MIN_COMMENTS || types.includes("DiscussionForumPosting")) return "thread"
  // A page that lists items (with an article teaser among them, say) is a listing, not an article.
  if (types.includes("ItemList") || types.includes("CollectionPage")) return "listing"
  if (readerable || og_type === "article" || types.some((type) => type.endsWith("Article") || type === "BlogPosting")) return "article"
  if (doc.querySelector('[role="feed"]') || doc.querySelectorAll('article, [role="article"]').length >= MIN_POSTS) return "feed"
  return "listing"
}
