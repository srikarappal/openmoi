// Operations that run inside a web page: the same code in openMoi's own tabs (Electron preload) and in your Chrome (extension).
import { read_article } from "./article"
import { looks_like_challenge } from "./challenge"
import { extract_records } from "./extract"
import { skeleton } from "./skeleton"
import type { ExtractorSpec, PageOp } from "./types"

const DEFAULT_SCROLL_PX = 900
const MAX_PAGE_TEXT = 20_000
const PLAYER_RESPONSE = "ytInitialPlayerResponse = "

// The JSON object that starts at start in text, found by matching braces outside strings; null if it never closes.
export function json_object_at(text: string, start: number): string | null {
  let depth = 0
  let quoted = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === "\\") index++
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1)
  }
  return null
}

interface CaptionTrack {
  baseUrl?: string
  languageCode?: string
}

// A video page's title, description and English captions address (or the first captions), from the player data the page
// carries in a script; nothing is fetched here.
function transcript_source(): { title: string; description: string; caption_url: string | null } {
  for (const script of Array.from(document.scripts)) {
    const text = script.textContent ?? ""
    const at = text.indexOf(PLAYER_RESPONSE)
    const found = at < 0 ? null : json_object_at(text, text.indexOf("{", at))
    if (!found) continue
    const player = JSON.parse(found)
    const tracks: CaptionTrack[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
    const track = tracks.find((candidate) => candidate.languageCode?.startsWith("en")) ?? tracks[0]
    return {
      title: player?.videoDetails?.title ?? document.title,
      description: player?.videoDetails?.shortDescription ?? "",
      caption_url: track?.baseUrl ? new URL(track.baseUrl, location.href).href : null,
    }
  }
  return { title: document.title, description: "", caption_url: null }
}

// The page's main text, for watching it: its main area when it has one, the whole body otherwise.
function page_text(): { title: string; text: string } {
  const main = document.querySelector("main, [role=main], article") ?? document.body
  const text = (main as HTMLElement).innerText ?? main.textContent ?? ""
  return { title: document.title, text: text.slice(0, MAX_PAGE_TEXT) }
}

export function run_page_op(op: PageOp, args: Record<string, unknown>): unknown {
  switch (op) {
    case "info":
      return { url: location.href, title: document.title }
    case "challenge":
      return looks_like_challenge(location.href, document.title, document)
    case "extract":
      return extract_records(document, args.spec as ExtractorSpec, location.href)
    case "scroll":
      window.scrollBy(0, Number(args.step_px) || DEFAULT_SCROLL_PX)
      return true
    case "skeleton":
      return skeleton(document.body)
    case "readability":
      return read_article(document, location.href, Number(args.max_text) || undefined)
    case "text":
      return page_text()
    case "transcript":
      return transcript_source()
    default:
      throw new Error(`unknown page op ${op}`)
  }
}
