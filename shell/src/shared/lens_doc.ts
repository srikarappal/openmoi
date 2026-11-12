// Everything about turning untrusted lens HTML into a safe document and trusting nothing it sends back.
import type { LensToHost, ViewItem } from "./types"

export const LENS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src moi-media: data:; font-src data:; media-src moi-media: data:"
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
    case "more":
      return typeof message.cursor === "string" ? { type: "more", cursor: message.cursor } : null
    case "seen":
      if (!Array.isArray(message.item_ids) || message.item_ids.length > MAX_IDS_PER_MESSAGE) return null
      return message.item_ids.every(is_id) ? { type: "seen", item_ids: message.item_ids as string[] } : null
    default:
      return null
  }
}
