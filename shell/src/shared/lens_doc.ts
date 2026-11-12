// Everything about turning untrusted lens HTML into a safe document and trusting nothing it sends back.
import type { LensToHost, ViewItem } from "./types"

export const LENS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src data:; media-src https:"
const MAX_IDS_PER_MESSAGE = 200
const MAX_ID_LENGTH = 200

// Puts the CSP before anything else in the document, right after the doctype, so it applies before any lens
// script runs, then the shared design tokens, so the lens's own styles come after them; the parser files both into
// head wherever the lens's own html and head tags come.
export function wrap_lens(html: string, tokens = ""): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${LENS_CSP}">`
  const style = tokens ? `<style id="moi_tokens">${tokens.replace(/<\//g, "<\\/")}</style>` : ""
  return `<!doctype html>${meta}${style}${html.replace(/^\s*<!doctype[^>]*>/i, "")}`
}

export function lens_data_url(html: string, tokens = ""): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(wrap_lens(html, tokens), "utf-8").toString("base64")}`
}

// The lens session only loads its own document and the https images of items it was sent; any other address
// (say an "image" whose query carries your items to someone's server) is refused.
export function lens_request_allowed(url: string, resource_type: string, item_images: ReadonlySet<string> | undefined): boolean {
  if (url.startsWith("data:")) return true
  const key = image_key(url)
  return url.startsWith("https://") && (resource_type === "image" || resource_type === "media") && key !== null && Boolean(item_images?.has(key))
}

// An image address the way Chromium requests it (spaces and accents encoded, no fragment), so the brain's raw
// address and the request compare equal.
export function image_key(url: string): string | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.href
  } catch {
    return null
  }
}

// The image addresses in items a lens is about to show: each item's image and the images of a reader article.
export function item_images(items: ViewItem[]): string[] {
  const found: string[] = []
  for (const { item } of items) {
    if (item.image_url) found.push(item.image_url)
    try {
      const blocks: unknown = JSON.parse(item.extra?.blocks ?? "[]")
      if (Array.isArray(blocks)) for (const block of blocks) if (typeof block?.src === "string") found.push(block.src)
    } catch {
      continue
    }
  }
  return found.map(image_key).filter((key): key is string => key !== null)
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
      return is_id(message.item_id) ? { type: message.type, item_id: message.item_id } : null
    case "more":
      return typeof message.cursor === "string" ? { type: "more", cursor: message.cursor } : null
    case "seen":
      if (!Array.isArray(message.item_ids) || message.item_ids.length > MAX_IDS_PER_MESSAGE) return null
      return message.item_ids.every(is_id) ? { type: "seen", item_ids: message.item_ids as string[] } : null
    default:
      return null
  }
}
