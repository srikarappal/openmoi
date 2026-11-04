// Everything about turning untrusted lens HTML into a safe document and trusting nothing it sends back.
import type { LensToHost } from "./types"

export const LENS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src data:; media-src https:"
const MAX_IDS_PER_MESSAGE = 200
const MAX_ID_LENGTH = 200

// Puts the CSP first in head so it applies before any lens script runs.
export function wrap_lens(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${LENS_CSP}">`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`)
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`
}

export function lens_data_url(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(wrap_lens(html), "utf-8").toString("base64")}`
}

// The lens session only loads its own document and https images.
export function lens_request_allowed(url: string, resource_type: string): boolean {
  if (url.startsWith("data:")) return true
  return url.startsWith("https://") && (resource_type === "image" || resource_type === "media")
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
