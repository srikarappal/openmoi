// The extension side of the relay: one WebSocket to the openMoi brain, kept alive with pings.
import type { ExtractorSpec } from "../shared/types"

export type RelayState = "offline" | "waiting_for_approval" | "connected"

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

const SOCKET_OPEN = 1
// Chrome keeps an extension service worker alive while its WebSocket is active; a ping every 20 s keeps it active.
export const PING_MS = 20_000

export class RelayClient {
  state: RelayState = "offline"
  passive: PassiveSource[] = []
  private socket: SocketLike | null = null
  private ping_timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly commands: CommandRunner,
    private readonly open_socket: (url: string) => SocketLike,
    private readonly on_change: (state: RelayState) => void,
  ) {}

  connect(url: string): void {
    if (this.socket) return
    const socket = this.open_socket(url)
    this.socket = socket
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

  // Events only go out once openMoi has approved this extension.
  send_event(event: Record<string, unknown>): boolean {
    if (this.state !== "connected") return false
    return this.send({ type: "event", ...event })
  }

  private closed(socket: SocketLike): void {
    if (this.socket !== socket) return
    this.socket = null
    if (this.ping_timer) clearInterval(this.ping_timer)
    this.ping_timer = null
    this.set_state("offline")
  }

  private async receive(socket: SocketLike, data: string): Promise<void> {
    if (socket !== this.socket) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (message.type === "approval_needed") this.set_state("waiting_for_approval")
    else if (message.type === "welcome" || message.type === "config") {
      this.passive = Array.isArray(message.passive) ? (message.passive as PassiveSource[]) : []
      this.set_state("connected")
    } else if (message.type === "call") await this.answer(message)
  }

  private async answer(message: Record<string, unknown>): Promise<void> {
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
