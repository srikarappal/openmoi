// Calls operations in a page's preload (extract, scroll, challenge, ...) and awaits the answer.
import { ipcMain, type WebContents } from "electron"
import { PendingRequests } from "../shared/pending"
import type { PageOp, PageResponse } from "../shared/types"

const PAGE_TIMEOUT_MS = 10_000
const pending = new PendingRequests()

ipcMain.on("moi:page_response", (_event, response: PageResponse) => {
  pending.settle(response.request_id, response.result, response.error)
})

export function call_page<T>(contents: WebContents, op: PageOp, args: Record<string, unknown> = {}, timeout_ms = PAGE_TIMEOUT_MS): Promise<T> {
  const { request_id, promise } = pending.create<T>(timeout_ms, `page ${op}`)
  contents.send("moi:page_request", { request_id, op, args })
  return promise
}
