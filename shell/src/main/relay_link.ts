// The app's view of the Chrome relay: connection state, approval requests, Mine requests and which driver reads pages.
import type { MineRequestEvent, RelayInfo } from "../shared/types"
import type { BrainClient } from "./brain"
import { RelayDriver, type PageDriver } from "./drivers"

const POLL_MS = 1_000

export interface RelayLinkHooks {
  changed(status: RelayInfo, previous: RelayInfo): void
  approval_needed(extension_id: string): void
  mine(request: MineRequestEvent): void
}

function ignore(): void {}

export class RelayLink {
  status: RelayInfo = { connected: false, waiting_for_approval: null }
  readonly chrome: RelayDriver
  private polling = false
  private asked: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly brain: BrainClient,
    private readonly fallback: PageDriver,
    private readonly hooks: RelayLinkHooks,
  ) {
    this.chrome = new RelayDriver(brain)
  }

  start(): void {
    this.timer = setInterval(() => this.poll().catch(ignore), POLL_MS)
    this.poll().catch(ignore)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  // Your Chrome whenever it is connected; openMoi's own session only as the fallback.
  driver(): PageDriver {
    return this.status.connected ? this.chrome : this.fallback
  }

  async trust(extension_id: string): Promise<void> {
    await this.brain.relay_trust(extension_id)
    await this.poll()
  }

  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const { status, events } = await this.brain.relay_poll()
      const previous = this.status
      this.status = { connected: status.connected, waiting_for_approval: status.waiting_for_approval }
      if (previous.connected !== this.status.connected || previous.waiting_for_approval !== this.status.waiting_for_approval) {
        this.hooks.changed(this.status, previous)
      }
      const waiting = this.status.waiting_for_approval
      if (waiting && waiting !== this.asked) {
        this.asked = waiting
        this.hooks.approval_needed(waiting)
      }
      for (const request of events) this.hooks.mine(request)
    } finally {
      this.polling = false
    }
  }
}
