// Everything about turning untrusted lens HTML into a safe document and trusting nothing it sends back.
import { createHash } from "node:crypto"
import type { LensToHost, ViewItem } from "./types"

// What a lens may load: nothing to connect to, images and media only through the media proxy or data URLs. Scripts
// run only when they are the lens's own <script> blocks, each allowed by its hash, so an event handler written into
// the page (say from an item title set as HTML: <img onerror=...>) never runs.
export const LENS_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src moi-media: data:; font-src data:; media-src moi-media: data:"
const MAX_IDS_PER_MESSAGE = 200
const MAX_ID_LENGTH = 200
const MAX_TEXT_LENGTH = 5_000
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi
// Runs before the lens: printing would put up a native dialog the lens could repeat forever, so it does nothing.
const GUARD_SCRIPT = `Object.defineProperty(window, "print", { value: function print() {}, writable: false, configurable: false })`

function script_hash(script: string): string {
  return `'sha256-${createHash("sha256").update(script, "utf-8").digest("base64")}'`
}

// The full policy for one lens: the base policy plus the hash of each of its own inline scripts and of the guard.
export function lens_csp(html: string): string {
  const hashes = [GUARD_SCRIPT, ...Array.from(html.matchAll(INLINE_SCRIPT), (match) => match[1])].map(script_hash)
  return `${LENS_CSP}; script-src ${[...new Set(hashes)].join(" ")}`
}

// Puts the CSP before anything else in the document, right after the doctype, so it applies before any lens
// script runs, then the guard, then the shared design tokens, so the lens's own styles come after them; the parser
// files them into head wherever the lens's own html and head tags come.
export function wrap_lens(html: string, tokens = ""): string {
  const lens = html.replace(/^\s*<!doctype[^>]*>/i, "")
  const meta = `<meta http-equiv="Content-Security-Policy" content="${lens_csp(lens)}">`
  const style = tokens ? `<style id="moi_tokens">${tokens.replace(/<\//g, "<\\/")}</style>` : ""
  return `<!doctype html>${meta}<script>${GUARD_SCRIPT}</script>${style}${lens}`
}

export function lens_data_url(html: string, tokens = ""): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(wrap_lens(html, tokens), "utf-8").toString("base64")}`
}

// The lens session loads only its own document, data URLs and the moi-media tokens it was given; any other address
// (say an "image" whose query carries your items to someone's server) is refused.
export function lens_request_allowed(url: string): boolean {
  return url.startsWith("data:") || url.startsWith("moi-media:")
}

// Items as a lens gets them: each image (the item's and those of a reader article) through the media proxy, so the lens
// never sees a web address it could load; an image the proxy will not take is left out.
export function with_media(items: ViewItem[], to_media: (url: string) => string | null): ViewItem[] {
  return items.map((view_item) => {
    const item = view_item.item
    const image_url = item.image_url ? to_media(item.image_url) : null
    let blocks: string | undefined = item.extra?.blocks
    try {
      const parsed: unknown = JSON.parse(blocks ?? "null")
      if (Array.isArray(parsed)) {
        const mapped = parsed.map((block) => (typeof block?.src === "string" ? { ...block, src: to_media(block.src) } : block))
        blocks = JSON.stringify(mapped.filter((block) => block?.src !== null))
      }
    } catch {
      blocks = undefined
    }
    const extra = blocks === undefined ? item.extra : { ...item.extra, blocks }
    return { ...view_item, item: { ...item, image_url, extra } }
  })
}

function is_collection(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value)
}

function is_text(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH
}

function is_id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
}

// Lens code is generated, so every message is checked before the host acts on it.
export function parse_lens_message(raw: unknown): LensToHost | null {
  if (typeof raw !== "object" || raw === null) return null
  const message = raw as Record<string, unknown>
  switch (message.type) {
    case "ready":
      return { type: "ready" }
    case "open":
    case "less_like_this":
    case "play":
      return is_id(message.item_id) ? { type: message.type, item_id: message.item_id } : null
    case "save":
    case "unsave":
      return is_id(message.item_id) && is_collection(message.collection) ? { type: message.type, item_id: message.item_id, collection: message.collection } : null
    case "highlight":
      if (!is_id(message.item_id) || !is_text(message.quote) || !is_text(message.note) || !(message.quote || message.note)) return null
      return { type: "highlight", item_id: message.item_id, quote: message.quote, note: message.note }
    case "more":
      return typeof message.cursor === "string" ? { type: "more", cursor: message.cursor } : null
    case "seen":
      if (!Array.isArray(message.item_ids) || message.item_ids.length > MAX_IDS_PER_MESSAGE) return null
      return message.item_ids.every(is_id) ? { type: "seen", item_ids: message.item_ids as string[] } : null
    default:
      return null
  }
}
