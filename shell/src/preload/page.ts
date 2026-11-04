// Preload for openMoi's own web tabs and hidden source views. Runs in an isolated world, so page scripts cannot reach it.
import { ipcRenderer } from "electron"
import { run_page_op } from "../shared/page_ops"
import type { PageRequest } from "../shared/types"

ipcRenderer.on("moi:page_request", (_event, request: PageRequest) => {
  try {
    ipcRenderer.send("moi:page_response", { request_id: request.request_id, result: run_page_op(request.op, request.args) })
  } catch (error) {
    ipcRenderer.send("moi:page_response", { request_id: request.request_id, error: String(error) })
  }
})
