// Turns what you type in the address bar into a URL.

const SEARCH_URL = "https://duckduckgo.com/?q="

export function normalize_address(text: string): string {
  const trimmed = text.trim()
  if (/^(https?|file|about|data):/i.test(trimmed)) return trimmed
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`
  if (!/\s/.test(trimmed) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`
  return `${SEARCH_URL}${encodeURIComponent(trimmed)}`
}

export function site_domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}
