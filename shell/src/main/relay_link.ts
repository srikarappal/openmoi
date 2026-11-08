// The app's view of the Chrome relay: connection state, approval requests, Mine requests and which driver reads pages.
import { sleep } from "../shared/timing"
import type { MineRequestEvent, RelayInfo } from "../shared/types"
import type { BrainClient } from "./brain"
import { RelayDriver, type PageDriver } from "./drivers"

const POLL_MS = 1_000
// The extension retries every 3 s while Chrome keeps it awake and wakes on a 30 s alarm otherwise.
const CHROME_WAIT_MS = 35_000
const WAIT_STEP_MS = 100

export interface RelayLinkHooks {
  changed(status: RelayInfo, previous: RelayInfo): void
  approval_needed(extension_id: string): void
  mine(request: MineRequestEvent): void
}

function ignore(): void {}

export class RelayLink {
  status: RelayInfo = { connected: false, waiting_for_approval: null, paired: false }
  readonly chrome: RelayDriver
  private polling = false
  private polled = false
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

  // For reading: a Chrome you paired before gets time to reconnect, since openMoi's own session is not signed in anywhere.
  // One that is there but needs Pair again will not connect by waiting, so reads go on without it.
  async reading_driver(wait_ms = CHROME_WAIT_MS): Promise<PageDriver> {
    const deadline = Date.now() + wait_ms
    while (!this.status.connected && !this.status.unrecognized && (!this.polled || this.status.paired) && Date.now() < deadline) await sleep(WAIT_STEP_MS)
    return this.driver()
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
      this.status = { connected: status.connected, waiting_for_approval: status.waiting_for_approval, paired: status.paired, unrecognized: status.unrecognized ?? null }
      this.polled = true
      const moved = ["connected", "waiting_for_approval", "unrecognized"] as const
      if (moved.some((key) => (previous[key] ?? null) !== (this.status[key] ?? null))) {
        this.hooks.changed(this.status, previous)
      }
      // Asked once per request: when it clears (allowed, or the extension left), the next one asks again.
      const waiting = this.status.waiting_for_approval
      if (!waiting) this.asked = null
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
