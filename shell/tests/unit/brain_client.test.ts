import { EventEmitter } from "node:events"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  killed = false

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly options: { env: Record<string, string> },
  ) {
    super()
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

function fake_spawn(command: string, args: string[], options: { env: Record<string, string> }): FakeChild {
  const child = new FakeChild(command, args, options)
  spawned.push(child)
  return child
}

vi.mock("node:child_process", () => ({ spawn: fake_spawn }))

const { BrainClient, BrainError, BrainProcess } = await import("../../src/main/brain")

interface Seen {
  method: string
  url: string
  token: string | undefined
  body: unknown
}

const seen: Seen[] = []
let server: Server
let base_url = ""

// Answers like the brain: JSON echo of the request, text for lenses, typed errors for /fail routes.
function answer(request: IncomingMessage, response: ServerResponse): void {
  let raw = ""
  request.on("data", (chunk) => (raw += chunk))
  request.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined
    seen.push({ method: request.method ?? "", url: request.url ?? "", token: request.headers["x-moi-token"] as string | undefined, body })
    if (request.method === "GET" && request.url?.startsWith("/lens/")) {
      response.writeHead(200, { "content-type": "text/html" }).end("<html>lens</html>")
    } else if (request.url === "/fail/json") {
      response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ detail: "privacy blocked", kind: "privacy" }))
    } else if (request.url === "/fail/text") {
      response.writeHead(500, { "content-type": "text/plain" }).end("Internal Server Error")
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ html: "<p>made</p>", version: 4, spec: { domain: "a.com" }, result: { handle: "7" }, status: "ok", echo: body ?? null }))
    }
  })
}

beforeAll(async () => {
  server = createServer(answer)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  seen.length = 0
  spawned.length = 0
})

describe("BrainClient", () => {
  it("sends the token, JSON bodies and the right route for every call", async () => {
    const brain = new BrainClient(base_url, "secret")
    await brain.health()
    await brain.views()
    await brain.refresh("feed", true)
    await brain.ingest("x", [{ native_id: "1" }], "https://x.com/home", "site_x.com", "listing")
    await brain.view_page("my feed", ["a"])
    await brain.events([{ view_id: "feed", item_id: "a", event_kind: "open" }])
    await brain.edit("feed", "no shorts", undefined, "rules")
    await brain.create_view("tech", "Tech")
    await brain.model_info()
    await brain.update_model({ allow_content_to_hosted: true })
    await brain.overview("feed")
    await brain.apply_edit("p1")
    await brain.discard_edit("p1")
    expect(await brain.lens("feed", "article")).toBe("<html>lens</html>")
    expect((await brain.generate_lens("feed", "feed", "0 of 30 rendered")).html).toBe("<p>made</p>")
    expect(await brain.accept_lens("feed", "feed", "<p>made</p>", "abcd1234")).toBe(4)
    expect(await brain.find_extractor("https://a.com/s?k=1")).toEqual({ domain: "a.com" })
    expect(await brain.generate_extractor("https://a.com/", "<div>", "too few")).toEqual({ domain: "a.com" })
    expect(await brain.accept_extractor({ domain: "a.com" } as never)).toEqual({ domain: "a.com" })
    await brain.relay_poll()
    await brain.relay_trust("abc")
    expect(await brain.relay_call("open", { url: "https://x.com" })).toEqual({ handle: "7" })
    expect(seen.every((request) => request.token === "secret")).toBe(true)
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /health",
      "GET /views",
      "POST /refresh",
      "POST /ingest",
      "POST /view/my%20feed",
      "POST /events",
      "POST /edit",
      "POST /views",
      "GET /model",
      "POST /model",
      "GET /overview/feed",
      "POST /edit/apply",
      "POST /edit/discard",
      "GET /lens/feed?kind=article",
      "POST /lens/generate",
      "POST /lens/accept",
      "GET /extractor?url=https%3A%2F%2Fa.com%2Fs%3Fk%3D1",
      "POST /extractor/generate",
      "POST /extractor/accept",
      "GET /relay/poll",
      "POST /relay/trust",
      "POST /relay/call",
    ])
    expect(seen[6].body).toEqual({ view_id: "feed", text: "no shorts", scope: "rules" })
    expect(seen[21].body).toEqual({ op: "open", args: { url: "https://x.com" } })
  })

  it("turns brain errors into BrainError with the kind the brain gave", async () => {
    const brain = new BrainClient(base_url, "secret")
    const typed = (await brain.request("GET", "/fail/json").catch((error: unknown) => error)) as InstanceType<typeof BrainError>
    expect(typed).toBeInstanceOf(BrainError)
    expect([typed.status, typed.kind, typed.message]).toEqual([409, "privacy", "privacy blocked"])
    const plain = (await brain.request("GET", "/fail/text").catch((error: unknown) => error)) as InstanceType<typeof BrainError>
    expect([plain.status, plain.kind, plain.message]).toEqual([500, "http", "Internal Server Error"])
  })
})

describe("BrainProcess", () => {
  beforeEach(() => {
    process.env.MOI_BRAIN_PORT = new URL(base_url).port
    process.env.MOI_TOKEN = "fixed"
  })

  it("starts the brain with uv, its port and token and waits until it answers", async () => {
    const brain = await BrainProcess.start("/repo")
    const [child] = spawned
    expect(child.command).toBe("uv")
    expect(child.args).toEqual(["run", "--project", "/repo/brain", "python", "-m", "moi_brain", "--port", new URL(base_url).port])
    expect(child.options.env.MOI_TOKEN).toBe("fixed")
    expect(brain.client.base_url).toBe(base_url)
    brain.stop()
    expect(child.killed).toBe(true)
    child.emit("exit")
    expect(spawned).toHaveLength(1)
  })

  it("fails at once with a readable reason when uv cannot be started", async () => {
    process.env.MOI_BRAIN_PORT = "9"
    const starting = BrainProcess.start("/repo")
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    spawned[0].emit("error", new Error("spawn uv ENOENT"))
    await expect(starting).rejects.toThrow("the brain could not be started with uv (spawn uv ENOENT); install uv, see the README")
  })

  it("restarts a brain that exits, waiting longer after each quick crash", async () => {
    const brain = await BrainProcess.start("/repo")
    vi.useFakeTimers()
    try {
      spawned[0].emit("exit")
      await vi.advanceTimersByTimeAsync(999)
      expect(spawned).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(spawned).toHaveLength(2)
      spawned[1].emit("exit")
      await vi.advanceTimersByTimeAsync(1_999)
      expect(spawned).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(spawned).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(31_000)
      spawned[2].emit("exit")
      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawned).toHaveLength(4)
      brain.stop()
      spawned[3].emit("exit")
      await vi.advanceTimersByTimeAsync(60_000)
      expect(spawned).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
