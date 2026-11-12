// Rung 2, passive: the JSON a page in openMoi's own session fetched by itself, read through the Chromium debugger
// protocol. Zero extra requests: only answers the page already received are read, and only for sites whose policy
// turns capture on. Item lists in them become records like an extractor's. Chrome is never debugged: it would show a
// warning bar on your own browser.
import type { WebContents } from "electron"
import { json_records } from "../shared/json_items"
import type { RawRecord } from "../shared/types"

const PROTOCOL_VERSION = "1.3"
const MAX_BODY = 2_000_000
const MAX_RECORDS = 500

interface ResponseBody {
  body: string
  base64Encoded: boolean
}

function ignore(): void {}

export class JsonCapture {
  private readonly pending = new Set<string>()
  private records: RawRecord[] = []
  private attached = false

  constructor(private readonly contents: WebContents) {}

  // Starts listening; a page that cannot be debugged (another debugger is attached) is simply not captured.
  start(): void {
    try {
      this.contents.debugger.attach(PROTOCOL_VERSION)
    } catch {
      return
    }
    this.attached = true
    this.contents.debugger.on("message", (_event, method: string, params: Record<string, unknown>) => this.on_message(method, params))
    this.contents.debugger.sendCommand("Network.enable").catch(ignore)
  }

  private on_message(method: string, params: Record<string, unknown>): void {
    const request_id = String(params.requestId ?? "")
    if (method === "Network.responseReceived") {
      const response = params.response as { mimeType?: string } | undefined
      if (/json/i.test(response?.mimeType ?? "")) this.pending.add(request_id)
    } else if (method === "Network.loadingFinished" && this.pending.delete(request_id)) {
      this.read(request_id).catch(ignore)
    }
  }

  private async read(request_id: string): Promise<void> {
    const { body, base64Encoded } = (await this.contents.debugger.sendCommand("Network.getResponseBody", { requestId: request_id })) as ResponseBody
    if (body.length > MAX_BODY) return
    const text = base64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body
    const found = json_records(JSON.parse(text), this.contents.getURL())
    this.records = [...this.records, ...found].slice(-MAX_RECORDS)
  }

  // Records captured since the last call.
  take(): RawRecord[] {
    const taken = this.records
    this.records = []
    return taken
  }

  stop(): void {
    if (!this.attached) return
    this.attached = false
    try {
      this.contents.debugger.detach()
    } catch {
      return
    }
  }
}
