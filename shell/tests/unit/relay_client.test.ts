import { afterEach, describe, expect, it, vi } from "vitest"
import { PING_MS, RelayClient, type RelayState, type SocketLike } from "../../src/extension/relay_client"

class FakeSocket implements SocketLike {
  readyState = 1
  readonly sent: Array<Record<string, unknown>> = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) })
  }
}

const X_SOURCE = { source_id: "x", url_prefix: "https://x.com/home", spec: { item_root: "article" } }

type Runner = (op: string, args: Record<string, unknown>) => Promise<unknown>

function make_client(run: Runner = vi.fn(async (op: string, args: Record<string, unknown>) => ({ op, args }))) {
  const sockets: FakeSocket[] = []
  const states: RelayState[] = []
  const client = new RelayClient(
    { run_command: run },
    (url) => {
      const socket = new FakeSocket()
      sockets.push(socket)
      expect(url).toBe("ws://127.0.0.1:47321/relay")
      return socket
    },
    (state) => states.push(state),
  )
  client.connect("ws://127.0.0.1:47321/relay")
  return { client, sockets, states, run }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.useRealTimers()
})

describe("RelayClient", () => {
  it("waits for approval, then takes the passive sources from the welcome", () => {
    const { client, sockets, states } = make_client()
    sockets[0].deliver({ type: "approval_needed", extension_id: "abc" })
    expect(client.state).toBe("waiting_for_approval")
    sockets[0].deliver({ type: "welcome", passive: [X_SOURCE] })
    expect(states).toEqual(["waiting_for_approval", "connected"])
    expect(client.passive_source_for("https://x.com/home?ref=1")).toEqual(X_SOURCE)
    expect(client.passive_source_for("https://x.com/settings")).toBeUndefined()
    sockets[0].deliver({ type: "config", passive: [] })
    expect(client.passive_source_for("https://x.com/home")).toBeUndefined()
  })

  it("answers calls with results and errors", async () => {
    const run = vi.fn(async (op: string, _args: Record<string, unknown>): Promise<unknown> => {
      if (op === "close") throw new Error("No tab with id: 9")
      return { handle: "512" }
    })
    const { sockets } = make_client(run)
    sockets[0].deliver({ type: "welcome", passive: [] })
    sockets[0].deliver({ type: "call", call_id: "c1", op: "open", args: { url: "https://x.com/home" } })
    sockets[0].deliver({ type: "call", call_id: "c2", op: "close", args: { handle: "9" } })
    await settle()
    expect(run).toHaveBeenCalledWith("open", { url: "https://x.com/home" })
    expect(sockets[0].sent).toEqual([
      { type: "reply", call_id: "c1", result: { handle: "512" } },
      { type: "reply", call_id: "c2", error: "No tab with id: 9" },
    ])
  })

  it("sends events only once approved", () => {
    const { client, sockets } = make_client()
    expect(client.send_event({ event: "mine", url: "https://a.com" })).toBe(false)
    sockets[0].deliver({ type: "welcome", passive: [] })
    expect(client.send_event({ event: "mine", url: "https://a.com" })).toBe(true)
    expect(sockets[0].sent).toEqual([{ type: "event", event: "mine", url: "https://a.com" }])
  })

  it("pings to stay alive and stops after the socket closes", () => {
    vi.useFakeTimers()
    const { client, sockets, states } = make_client()
    vi.advanceTimersByTime(PING_MS * 2)
    expect(sockets[0].sent).toEqual([{ type: "ping" }, { type: "ping" }])
    sockets[0].close()
    expect(client.state).toBe("offline")
    expect(states.at(-1)).toBe("offline")
    vi.advanceTimersByTime(PING_MS * 2)
    expect(sockets[0].sent).toHaveLength(2)
  })

  it("connects once at a time and reconnects after a close", () => {
    const { client, sockets } = make_client()
    client.connect("ws://127.0.0.1:47321/relay")
    expect(sockets).toHaveLength(1)
    client.disconnect()
    client.connect("ws://127.0.0.1:47321/relay")
    expect(sockets).toHaveLength(2)
  })

  it("ignores garbage and messages from a replaced socket", () => {
    const { client, sockets } = make_client()
    sockets[0].deliver("not json")
    sockets[0].deliver({ type: "something_new" })
    expect(client.state).toBe("offline")
    const old_socket = sockets[0]
    client.disconnect()
    client.connect("ws://127.0.0.1:47321/relay")
    old_socket.deliver({ type: "welcome", passive: [] })
    expect(client.state).toBe("offline")
  })

  it("does not send on a socket that is not open", () => {
    const { client, sockets } = make_client()
    sockets[0].deliver({ type: "welcome", passive: [] })
    sockets[0].readyState = 0
    expect(client.send_event({ event: "mine" })).toBe(false)
    expect(sockets[0].sent).toEqual([])
  })
})
