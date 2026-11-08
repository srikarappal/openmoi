import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EXTENSION_PROOF, HUB_PROOF, PING_MS, RelayClient, passive_sources, proof, type RelayState, type SocketLike } from "../../src/extension/relay_client"

const SECRET = "ab".repeat(32)
const CHALLENGE = "c0".repeat(16)
const X_SOURCE = { source_id: "x", url_prefix: "https://x.com/home", spec: { item_root: "article" } }

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

  hello(): Record<string, unknown> | undefined {
    return this.sent.find((message) => message.type === "hello")
  }
}

class MemorySecrets {
  saved: string[] = []

  constructor(public secret: string | null = null) {}

  async load(): Promise<string | null> {
    return this.secret
  }

  async save(secret: string): Promise<void> {
    this.secret = secret
    this.saved.push(secret)
  }
}

// What the Python hub computes, done independently with Node's HMAC.
function hub_proof(secret: string, label: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(`${label}${nonce}`).digest("hex")
}

type Runner = (op: string, args: Record<string, unknown>) => Promise<unknown>

function make_client(secret: string | null = null, run: Runner = vi.fn(async (op: string, args: Record<string, unknown>) => ({ op, args }))) {
  const sockets: FakeSocket[] = []
  const states: RelayState[] = []
  const secrets = new MemorySecrets(secret)
  const client = new RelayClient(
    { run_command: run },
    (url) => {
      const socket = new FakeSocket()
      sockets.push(socket)
      expect(url).toBe("ws://127.0.0.1:47321/relay")
      return socket
    },
    (state) => states.push(state),
    secrets,
  )
  client.connect("ws://127.0.0.1:47321/relay")
  return { client, sockets, states, run, secrets }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setTimeout(resolve, 0))
}

// Plays the genuine hub up to the welcome: challenge, then a welcome proving the secret for the hello's nonce.
async function welcome(socket: FakeSocket, secret: string, extra: Record<string, unknown> = {}): Promise<void> {
  socket.deliver({ type: "challenge", nonce: CHALLENGE })
  await settle()
  const nonce = String(socket.hello()?.nonce)
  socket.deliver({ type: "welcome", proof: hub_proof(secret, HUB_PROOF, nonce), passive: [X_SOURCE], ...extra })
  await settle()
}

afterEach(() => {
  vi.useRealTimers()
})

describe("RelayClient pairing", () => {
  it("first time: says hello without a proof, waits to be allowed, then keeps the secret it is given", async () => {
    const { client, sockets, states, secrets } = make_client()
    sockets[0].deliver({ type: "challenge", nonce: CHALLENGE })
    await settle()
    expect(sockets[0].hello()).toMatchObject({ type: "hello", proof: null })
    expect(String(sockets[0].hello()?.nonce)).toMatch(/^[0-9a-f]{32}$/)
    sockets[0].deliver({ type: "approval_needed", extension_id: "abc" })
    await settle()
    expect(client.state).toBe("waiting_for_approval")
    const nonce = String(sockets[0].hello()?.nonce)
    sockets[0].deliver({ type: "welcome", secret: SECRET, proof: hub_proof(SECRET, HUB_PROOF, nonce), passive: [X_SOURCE] })
    await settle()
    expect(states).toEqual(["waiting_for_approval", "connected"])
    expect(secrets.saved).toEqual([SECRET])
    expect(client.passive_source_for("https://x.com/home?ref=1")).toEqual(X_SOURCE)
  })

  it("paired: proves the secret for the hub's challenge and accepts only a hub that proves it back", async () => {
    const { client, sockets, secrets } = make_client(SECRET)
    await welcome(sockets[0], SECRET)
    expect(sockets[0].hello()?.proof).toBe(hub_proof(SECRET, EXTENSION_PROOF, CHALLENGE))
    expect(client.state).toBe("connected")
    expect(secrets.saved).toEqual([])
    sockets[0].deliver({ type: "config", passive: [] })
    await settle()
    expect(client.passive_source_for("https://x.com/home")).toBeUndefined()
  })

  it("a program posing as openMoi gets no calls and this browser shows unrecognized", async () => {
    const run = vi.fn(async () => "page text")
    const { client, sockets, secrets } = make_client(SECRET, run)
    await welcome(sockets[0], "cd".repeat(32), { secret: "cd".repeat(32) })
    sockets[0].deliver({ type: "call", call_id: "c1", op: "run", args: { handle: "1", op: "extract" } })
    await settle()
    expect(client.state).toBe("unrecognized")
    expect(sockets[0].readyState).toBe(3)
    expect(run).not.toHaveBeenCalled()
    expect(secrets.secret).toBe(SECRET)
    expect(client.send_event({ event: "mine" })).toBe(false)
  })

  it("a hub that does not accept this browser's secret means unrecognized, not waiting", async () => {
    const { client, sockets } = make_client(SECRET)
    sockets[0].deliver({ type: "challenge", nonce: CHALLENGE })
    sockets[0].deliver({ type: "approval_needed", extension_id: "abc" })
    await settle()
    expect(client.state).toBe("unrecognized")
    sockets[0].close()
    expect(client.state).toBe("unrecognized")
  })

  it("an unpaired browser refuses a welcome whose proof does not fit and a secret that is not one", async () => {
    const { client, sockets, secrets } = make_client()
    await welcome(sockets[0], SECRET, { secret: "not hex", proof: "0".repeat(64) })
    expect(client.state).toBe("offline")
    expect(secrets.saved).toEqual([])
  })

  it("ignores calls before the hub is proven and answers one that arrives right after the welcome", async () => {
    const { sockets, run } = make_client(SECRET)
    sockets[0].deliver({ type: "call", call_id: "early", op: "url", args: { handle: "1" } })
    await settle()
    expect(run).not.toHaveBeenCalled()
    sockets[0].deliver({ type: "challenge", nonce: CHALLENGE })
    await settle()
    const nonce = String(sockets[0].hello()?.nonce)
    sockets[0].deliver({ type: "welcome", proof: hub_proof(SECRET, HUB_PROOF, nonce), passive: [] })
    sockets[0].deliver({ type: "call", call_id: "c1", op: "url", args: { handle: "1" } })
    await settle()
    expect(sockets[0].sent.filter((message) => message.type === "reply")).toEqual([{ type: "reply", call_id: "c1", result: { op: "url", args: { handle: "1" } } }])
  })

  it("matches the hub's HMAC exactly", async () => {
    expect(await proof(SECRET, HUB_PROOF, CHALLENGE)).toBe(hub_proof(SECRET, HUB_PROOF, CHALLENGE))
  })
})

describe("RelayClient once connected", () => {
  it("answers calls with results and errors", async () => {
    const run = vi.fn(async (op: string): Promise<unknown> => {
      if (op === "close") throw new Error("No tab with id: 9")
      return { handle: "512" }
    })
    const { sockets } = make_client(SECRET, run)
    await welcome(sockets[0], SECRET)
    sockets[0].deliver({ type: "call", call_id: "c1", op: "open", args: { url: "https://x.com/home" } })
    sockets[0].deliver({ type: "call", call_id: "c2", op: "close", args: { handle: "9" } })
    sockets[0].deliver({ type: "call", call_id: "c3", op: "noop" })
    await settle()
    expect(run).toHaveBeenCalledWith("open", { url: "https://x.com/home" })
    expect(sockets[0].sent.filter((message) => message.type === "reply")).toEqual([
      { type: "reply", call_id: "c1", result: { handle: "512" } },
      { type: "reply", call_id: "c2", error: "No tab with id: 9" },
      { type: "reply", call_id: "c3", result: { handle: "512" } },
    ])
  })

  it("sends events only once the hub is proven", async () => {
    const { client, sockets } = make_client(SECRET)
    expect(client.send_event({ event: "mine", url: "https://a.com" })).toBe(false)
    await welcome(sockets[0], SECRET)
    expect(client.send_event({ event: "mine", url: "https://a.com" })).toBe(true)
    expect(sockets[0].sent.at(-1)).toEqual({ type: "event", event: "mine", url: "https://a.com" })
  })

  it("pings to stay alive and stops after the socket closes", () => {
    vi.useFakeTimers()
    const { sockets, states } = make_client()
    vi.advanceTimersByTime(PING_MS * 2)
    expect(sockets[0].sent).toEqual([{ type: "ping" }, { type: "ping" }])
    sockets[0].close()
    vi.advanceTimersByTime(PING_MS * 2)
    expect(sockets[0].sent).toHaveLength(2)
    expect(states).toEqual(["offline"])
  })

  it("connects once at a time and reconnects after a close", () => {
    const { client, sockets } = make_client()
    client.connect("ws://127.0.0.1:47321/relay")
    expect(sockets).toHaveLength(1)
    client.disconnect()
    client.connect("ws://127.0.0.1:47321/relay")
    expect(sockets).toHaveLength(2)
  })

  it("ignores garbage and messages from a replaced socket", async () => {
    const { client, sockets } = make_client(SECRET)
    sockets[0].deliver("not json")
    client.disconnect()
    client.connect("ws://127.0.0.1:47321/relay")
    sockets[0].deliver({ type: "challenge", nonce: CHALLENGE })
    await settle()
    expect(sockets[0].hello()).toBeUndefined()
    expect(client.state).toBe("offline")
  })

  it("does not send on a socket that is not open", async () => {
    const { client, sockets } = make_client(SECRET)
    await welcome(sockets[0], SECRET)
    sockets[0].readyState = 0
    expect(client.send_event({ event: "mine" })).toBe(false)
  })
})

describe("passive_sources", () => {
  it("keeps only sources under one site's address", () => {
    const sources = passive_sources([
      X_SOURCE,
      { source_id: "x", url_prefix: "http://127.0.0.1:8899/pages/x_home.html", spec: {} },
      { source_id: "all", url_prefix: "https://", spec: {} },
      { source_id: "all", url_prefix: "", spec: {} },
      { source_id: "x", url_prefix: "https://x.com/home" },
      null,
    ])
    expect(sources.map((source) => source.url_prefix)).toEqual(["https://x.com/home", "http://127.0.0.1:8899/pages/x_home.html"])
    expect(passive_sources("nope")).toEqual([])
  })
})
