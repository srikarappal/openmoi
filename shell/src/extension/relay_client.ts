// The extension side of the relay: one WebSocket to the openMoi brain, kept alive with pings.
//
// Pairing: the first time you allow this browser in openMoi, the hub hands over a secret that stays in the
// extension's storage. On every connection after that the extension proves it holds the secret and takes no
// call until the hub has proved the same for a fresh nonce. A program posing as openMoi while openMoi is closed
// cannot, so it gets nothing; this browser then shows "unrecognized" and offers to pair again.
import type { ExtractorSpec } from "../shared/types"

export type RelayState = "offline" | "waiting_for_approval" | "connected" | "unrecognized"

export interface PassiveSource {
  source_id: string
  url_prefix: string
  spec: ExtractorSpec
}

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface CommandRunner {
  run_command(op: string, args: Record<string, unknown>): Promise<unknown>
}

// Where the pairing secret lives: chrome.storage.local in the extension.
export interface SecretStore {
  load(): Promise<string | null>
  save(secret: string): Promise<void>
}

const SOCKET_OPEN = 1
// Chrome keeps an extension service worker alive while its WebSocket is active; a ping every 20 s keeps it active.
export const PING_MS = 20_000
export const EXTENSION_PROOF = "extension:"
export const HUB_PROOF = "openmoi:"
const NONCE = /^[0-9a-f]{32}$/
const SECRET = /^[0-9a-f]{64}$/
// Passive reading only ever covers pages under one site's address, never "every page you visit".
const PASSIVE_PREFIX = /^https?:\/\/[^/\s?#]+\//i

function to_hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function from_hex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2))
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

export function random_nonce(): string {
  return to_hex(crypto.getRandomValues(new Uint8Array(16)))
}

// HMAC SHA-256 of label + nonce under the shared secret, as hex; the brain computes the same in relay.py.
export async function proof(secret: string, label: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", from_hex(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return to_hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${label}${nonce}`))))
}

function same_text(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

export function passive_sources(raw: unknown): PassiveSource[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (source): source is PassiveSource =>
      typeof source?.source_id === "string" && typeof source?.url_prefix === "string" && PASSIVE_PREFIX.test(source.url_prefix) && typeof source?.spec === "object" && source.spec !== null,
  )
}

function ignore(): void {}

export class RelayClient {
  state: RelayState = "offline"
  passive: PassiveSource[] = []
  private socket: SocketLike | null = null
  private ping_timer: ReturnType<typeof setInterval> | null = null
  private nonce = ""
  // Handshake steps run in order; a call that arrives right after the welcome waits for it to be checked.
  private handshake: Promise<void> = Promise.resolve()

  constructor(
    private readonly commands: CommandRunner,
    private readonly open_socket: (url: string) => SocketLike,
    private readonly on_change: (state: RelayState) => void,
    private readonly secrets: SecretStore,
  ) {}

  connect(url: string): void {
    if (this.socket) return
    const socket = this.open_socket(url)
    this.socket = socket
    this.handshake = Promise.resolve()
    socket.onmessage = (event) => this.receive(socket, String(event.data))
    socket.onclose = () => this.closed(socket)
    socket.onerror = () => socket.close()
    this.ping_timer = setInterval(() => this.send({ type: "ping" }), PING_MS)
  }

  disconnect(): void {
    this.socket?.close()
  }

  passive_source_for(url: string): PassiveSource | undefined {
    return this.passive.find((source) => url.startsWith(source.url_prefix))
  }

  // Events only go out once the hub has proved it is the openMoi this browser paired with.
  send_event(event: Record<string, unknown>): boolean {
    if (this.state !== "connected") return false
    return this.send({ type: "event", ...event })
  }

  private closed(socket: SocketLike): void {
    if (this.socket !== socket) return
    this.socket = null
    if (this.ping_timer) clearInterval(this.ping_timer)
    this.ping_timer = null
    this.passive = []
    if (this.state !== "unrecognized") this.set_state("offline")
  }

  private receive(socket: SocketLike, data: string): void {
    if (socket !== this.socket) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (message.type === "challenge") this.then(() => this.hello(socket, String(message.nonce ?? "")))
    else if (message.type === "approval_needed") this.then(() => this.not_paired())
    else if (message.type === "welcome") this.then(() => this.welcome(socket, message))
    else if (message.type === "config") this.then(async () => this.config(message))
    else if (message.type === "call") this.handshake.then(() => this.answer(socket, message)).catch(ignore)
  }

  private then(step: () => Promise<void>): void {
    this.handshake = this.handshake.then(step).catch(ignore)
  }

  private async hello(socket: SocketLike, challenge: string): Promise<void> {
    this.nonce = random_nonce()
    const secret = await this.secrets.load()
    const answer = secret && NONCE.test(challenge) ? await proof(secret, EXTENSION_PROOF, challenge) : null
    if (socket === this.socket) this.send({ type: "hello", nonce: this.nonce, proof: answer })
  }

  // The hub does not accept this browser's secret: either it is not openMoi, or openMoi was reset.
  private async not_paired(): Promise<void> {
    this.set_state((await this.secrets.load()) ? "unrecognized" : "waiting_for_approval")
  }

  private async welcome(socket: SocketLike, message: Record<string, unknown>): Promise<void> {
    const stored = await this.secrets.load()
    const offered = typeof message.secret === "string" && SECRET.test(message.secret) ? message.secret : null
    const secret = stored ?? offered
    const genuine = secret !== null && same_text(String(message.proof ?? ""), await proof(secret, HUB_PROOF, this.nonce))
    if (!genuine || socket !== this.socket) {
      if (stored) this.set_state("unrecognized")
      socket.close()
      return
    }
    if (!stored) await this.secrets.save(secret)
    this.passive = passive_sources(message.passive)
    this.set_state("connected")
  }

  private async config(message: Record<string, unknown>): Promise<void> {
    if (this.state === "connected") this.passive = passive_sources(message.passive)
  }

  private async answer(socket: SocketLike, message: Record<string, unknown>): Promise<void> {
    if (this.state !== "connected" || socket !== this.socket) return
    try {
      const result = await this.commands.run_command(String(message.op), (message.args as Record<string, unknown>) ?? {})
      this.send({ type: "reply", call_id: message.call_id, result: result ?? null })
    } catch (error) {
      this.send({ type: "reply", call_id: message.call_id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private send(message: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== SOCKET_OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private set_state(state: RelayState): void {
    this.state = state
    this.on_change(state)
  }
}
