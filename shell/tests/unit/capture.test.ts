import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { JsonCapture } from "../../src/main/capture"

// The debugger of a page: it records commands and replays the network events a test sends.
class FakeDebugger extends EventEmitter {
  attached = false
  refuse = false
  commands: string[] = []
  bodies = new Map<string, { body: string; base64Encoded: boolean }>()

  attach(): void {
    if (this.refuse) throw new Error("Another debugger is already attached")
    this.attached = true
  }

  detach(): void {
    if (!this.attached) throw new Error("not attached")
    this.attached = false
  }

  async sendCommand(method: string, params: { requestId?: string } = {}): Promise<unknown> {
    this.commands.push(method)
    if (method === "Network.getResponseBody") return this.bodies.get(params.requestId ?? "") ?? { body: "{}", base64Encoded: false }
    return {}
  }

  network(request_id: string, mime: string): void {
    this.emit("message", {}, "Network.responseReceived", { requestId: request_id, response: { mimeType: mime } })
    this.emit("message", {}, "Network.loadingFinished", { requestId: request_id })
  }
}

const POSTS = { data: { posts: [1, 2, 3].map((id) => ({ id, title: `Post ${id}`, url: `/p/${id}` })) } }

function page(debug: FakeDebugger) {
  return { debugger: debug, getURL: () => "https://site.example/feed" } as never
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("passive JSON capture", () => {
  it("reads item lists from JSON the page fetched, plain or base64, and nothing else", async () => {
    const debug = new FakeDebugger()
    const capture = new JsonCapture(page(debug))
    capture.start()
    expect(debug.commands).toEqual(["Network.enable"])
    debug.bodies.set("1", { body: JSON.stringify(POSTS), base64Encoded: false })
    debug.bodies.set("2", { body: Buffer.from(JSON.stringify(POSTS)).toString("base64"), base64Encoded: true })
    debug.bodies.set("3", { body: "<html>", base64Encoded: false })
    debug.network("1", "application/json")
    debug.network("2", "application/json; charset=utf-8")
    debug.network("3", "text/html")
    debug.emit("message", {}, "Network.loadingFinished", { requestId: "9" })
    await settled()
    const taken = capture.take()
    expect(taken.map((record) => record.url)).toEqual(["https://site.example/p/1", "https://site.example/p/2", "https://site.example/p/3", "https://site.example/p/1", "https://site.example/p/2", "https://site.example/p/3"])
    expect(capture.take()).toEqual([])
    expect(debug.commands.filter((command) => command === "Network.getResponseBody")).toHaveLength(2)
  })

  it("survives broken JSON and huge bodies, and lets go of the page", async () => {
    const debug = new FakeDebugger()
    const capture = new JsonCapture(page(debug))
    capture.start()
    debug.bodies.set("1", { body: "{not json", base64Encoded: false })
    debug.bodies.set("2", { body: "x".repeat(2_000_001), base64Encoded: false })
    debug.network("1", "application/json")
    debug.network("2", "application/json")
    await settled()
    expect(capture.take()).toEqual([])
    capture.stop()
    expect(debug.attached).toBe(false)
    capture.stop()
  })

  it("leaves alone a page another debugger holds", () => {
    const debug = new FakeDebugger()
    debug.refuse = true
    const capture = new JsonCapture(page(debug))
    capture.start()
    expect(debug.commands).toEqual([])
    capture.stop()
  })

  it("ignores a detach that fails", () => {
    const debug = new FakeDebugger()
    const capture = new JsonCapture(page(debug))
    capture.start()
    debug.attached = false
    capture.stop()
  })
})
