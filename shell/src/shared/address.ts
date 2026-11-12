// Turns what you type in the address bar into a URL.

const SEARCH_URL = "https://duckduckgo.com/?q="

// Words to search for rather than an address to open.
export function is_search(text: string): boolean {
  return normalize_address(text).startsWith(SEARCH_URL)
}

export function normalize_address(text: string): string {
  const trimmed = text.trim()
  if (/^(https?|file|about|data):/i.test(trimmed)) return trimmed
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`
  if (!/\s/.test(trimmed) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`
  return `${SEARCH_URL}${encodeURIComponent(trimmed)}`
}

// Links from feeds and pages open only when they are web addresses; a file:, data: or javascript: link never does.
export function is_web_url(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

export function site_domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"])
const VIDEO_ID = /^[\w-]{11}$/

// The id of a YouTube video address (watch, shorts, embed or youtu.be), or null for anything else.
export function youtube_video_id(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, "")
    const [first, second] = parsed.pathname.split("/").filter(Boolean)
    let id: string | null | undefined = null
    if (host === "youtu.be") id = first
    else if (YOUTUBE_HOSTS.has(host)) id = first === "watch" ? parsed.searchParams.get("v") : ["shorts", "embed", "live"].includes(first ?? "") ? second : null
    return id && VIDEO_ID.test(id) ? id : null
  } catch {
    return null
  }
}
