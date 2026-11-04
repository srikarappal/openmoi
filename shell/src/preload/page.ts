// Preload for web tabs and hidden source views. Runs in an isolated world, so page scripts cannot reach it.
import { ipcRenderer } from "electron"
import { looks_like_challenge } from "../shared/challenge"
import { extract_records } from "../shared/extract"
import type { ExtractorSpec, PageOp, PageRequest } from "../shared/types"

function run_op(op: PageOp, args: Record<string, unknown>): unknown {
  switch (op) {
    case "info":
      return { url: location.href, title: document.title }
    case "challenge":
      return looks_like_challenge(location.href, document.title, document)
    case "extract":
      return extract_records(document, args.spec as ExtractorSpec, location.href)
    case "scroll":
      window.scrollBy(0, Number(args.step_px) || 900)
      return true
    default:
      throw new Error(`unknown page op ${op}`)
  }
}

ipcRenderer.on("moi:page_request", (_event, request: PageRequest) => {
  try {
    ipcRenderer.send("moi:page_response", { request_id: request.request_id, result: run_op(request.op, request.args) })
  } catch (error) {
    ipcRenderer.send("moi:page_response", { request_id: request.request_id, error: String(error) })
  }
})
