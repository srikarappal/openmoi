// Item-like lists inside any JSON a page carries or fetched (Next.js and Nuxt hydration state, a feed API's answer):
// the largest array of objects that mostly have something to read and a link. Each object becomes a record by
// common field names, so no spec is needed; objects without a link are left out.

import type { RawRecord } from "./types"

const MIN_ITEMS = 3
const MIN_SHARE = 0.6
const MAX_DEPTH = 12
const MAX_TEXT = 4000
const TITLE_KEYS = ["title", "headline", "name", "full_text", "text", "caption", "body", "description"]
const TEXT_KEYS = ["description", "summary", "excerpt", "body", "text", "full_text", "caption"]
const URL_KEYS = ["url", "permalink", "link", "href", "canonical_url", "share_url", "web_url"]
const ID_KEYS = ["id", "id_str", "rest_id", "uuid", "slug"]
const AUTHOR_KEYS = ["author", "user", "owner", "creator", "channel"]
const HANDLE_KEYS = ["screen_name", "username", "handle", "login"]
const TIME_KEYS = ["published_at", "publishedAt", "created_at", "createdAt", "date", "datePublished", "timestamp"]
const IMAGE_KEYS = ["image_url", "thumbnail_url", "image", "thumbnail", "cover", "picture"]

type Node = Record<string, unknown>

function is_node(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function first_string(node: Node, keys: string[]): string {
  for (const key of keys) {
    const value = node[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && (keys === TIME_KEYS || keys === ID_KEYS)) return String(value)
    if (is_node(value) && typeof value.url === "string" && keys === IMAGE_KEYS) return value.url
  }
  return ""
}

function link_of(node: Node, page_url: string): string {
  const raw = first_string(node, URL_KEYS)
  if (!raw) return ""
  try {
    const url = new URL(raw, page_url)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : ""
  } catch {
    return ""
  }
}

function readable(node: Node): boolean {
  return Boolean(first_string(node, TITLE_KEYS)) && Boolean(first_string(node, URL_KEYS) || first_string(node, ID_KEYS))
}

// Every array of objects in the JSON with how many of its objects look like items, depth first.
function candidate_lists(value: unknown, found: Node[][], depth = 0): void {
  if (depth > MAX_DEPTH) return
  if (Array.isArray(value)) {
    const nodes = value.filter(is_node)
    if (nodes.length >= MIN_ITEMS && nodes.filter(readable).length >= nodes.length * MIN_SHARE) found.push(nodes)
    for (const entry of value) candidate_lists(entry, found, depth + 1)
    return
  }
  if (is_node(value)) for (const entry of Object.values(value)) candidate_lists(entry, found, depth + 1)
}

function author_of(node: Node): { name: string; handle: string } {
  for (const key of AUTHOR_KEYS) {
    const value = node[key]
    if (typeof value === "string") return { name: value, handle: "" }
    if (is_node(value)) return { name: first_string(value, ["name", "display_name", "title"]), handle: first_string(value, HANDLE_KEYS) }
  }
  return { name: "", handle: first_string(node, HANDLE_KEYS) }
}

function record_of(node: Node, page_url: string): RawRecord | null {
  const url = link_of(node, page_url)
  const title = first_string(node, TITLE_KEYS).slice(0, MAX_TEXT)
  if (!url || !title) return null
  const text = TEXT_KEYS.map((key) => node[key]).find((value): value is string => typeof value === "string" && value.trim() !== "" && value.trim() !== title)
  const author = author_of(node)
  const record: RawRecord = { native_id: first_string(node, ID_KEYS) || url, url, title }
  const fields: Array<[string, string]> = [
    ["text", (text ?? "").trim().slice(0, MAX_TEXT)],
    ["author_name", author.name],
    ["author_handle", author.handle],
    ["published_at", first_string(node, TIME_KEYS)],
    ["image_url", first_string(node, IMAGE_KEYS)],
  ]
  for (const [key, value] of fields) if (value) record[key] = value
  return record
}

// Records from the largest item-like list in the JSON; none when nothing in it looks like items with links.
export function json_records(value: unknown, page_url: string): RawRecord[] {
  const lists: Node[][] = []
  candidate_lists(value, lists)
  const records = lists
    .map((list) => list.map((node) => record_of(node, page_url)).filter((record): record is RawRecord => record !== null))
    .sort((first, second) => second.length - first.length)[0]
  return records && records.length >= MIN_ITEMS ? records : []
}
