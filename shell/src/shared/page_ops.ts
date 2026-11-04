// Operations that run inside a web page: the same code in openMoi's own tabs (Electron preload) and in your Chrome (extension).
import { read_article } from "./article"
import { looks_like_challenge } from "./challenge"
import { extract_records } from "./extract"
import { skeleton } from "./skeleton"
import type { ExtractorSpec, PageOp } from "./types"

const DEFAULT_SCROLL_PX = 900

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
      return read_article(document, location.href)
    default:
      throw new Error(`unknown page op ${op}`)
  }
}
