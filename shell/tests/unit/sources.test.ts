import { describe, expect, it, vi } from "vitest"
import type { PageDriver } from "../../src/main/drivers"
import { SourceReader } from "../../src/main/sources"
import type { PageSource, RawRecord } from "../../src/shared/types"

const SOURCE = {
  source_id: "x",
  start_url: "https://x.com/home",
  spec: { pagination: { kind: "scroll", step_px: 800 } },
  budget: { page_loads: 1, scroll_steps: 5, min_step_interval_ms: 0 },
} as unknown as PageSource

// A timeline that shows one more post after every scroll, like X.
class FakeTimeline implements PageDriver {
  readonly kind: "chrome" | "openmoi" = "chrome"
  scrolls = 0
  failures = 0

  constructor(kind: "chrome" | "openmoi" = "chrome", failures = 0) {
    this.kind = kind
    this.failures = failures
  }

  async open(): Promise<string> {
    return "tab1"
  }

  async run<T>(handle: string, op: string): Promise<T> {
    if (op === "scroll" && this.failures > 0 && this.scrolls === 2) {
      this.failures -= 1
      throw new Error("Chrome reconnected before answering")
    }
    if (op === "scroll") this.scrolls += 1
    if (op === "challenge") return false as T
    const records: RawRecord[] = Array.from({ length: this.scrolls + 1 }, (_, index) => ({ native_id: `post${index}` }))
    return records as T
  }

  async url(): Promise<string> {
    return SOURCE.start_url
  }

  async close(): Promise<void> {}
}

describe("SourceReader depth", () => {
  it.each([
    [1, 5],
    [3, 15],
  ])("depth %i scrolls %i steps and delivers each new post once", async (depth, steps) => {
    const timeline = new FakeTimeline()
    const delivered: string[] = []
    const outcome = await new SourceReader(() => timeline).read(SOURCE, true, async (records) => {
      delivered.push(...records.map((record) => String(record.native_id)))
    }, depth)
    expect(timeline.scrolls).toBe(steps)
    expect(outcome).toEqual({ status: "read", count: steps + 1, driver: "chrome" })
    expect(new Set(delivered).size).toBe(delivered.length)
  })
})

describe("SourceReader retry", () => {
  it("tries once more after Chrome fails mid read, without delivering a record twice", async () => {
    const timeline = new FakeTimeline("chrome", 1)
    const delivered: string[] = []
    const outcome = await new SourceReader(() => timeline).read(SOURCE, true, async (records) => {
      delivered.push(...records.map((record) => String(record.native_id)))
    })
    expect(outcome.status).toBe("read")
    expect(new Set(delivered).size).toBe(delivered.length)
  }, 10_000)

  it("does not retry openMoi's own session and reports the failure", async () => {
    const timeline = new FakeTimeline("openmoi", 1)
    const outcome = await new SourceReader(() => timeline).read(SOURCE, true, async () => {})
    expect(outcome).toEqual({ status: "failed", error: "Chrome reconnected before answering", driver: "openmoi" })
  })

  it("skips a source read in the last ten minutes unless forced", async () => {
    const reader = new SourceReader(() => new FakeTimeline())
    expect((await reader.read(SOURCE, false, async () => {})).status).toBe("read")
    expect(await reader.read(SOURCE, false, async () => {})).toEqual({ status: "skipped" })
    expect((await reader.read(SOURCE, true, async () => {})).status).toBe("read")
  })
})


// A page that never shows items: a sign in wall when wall is set, otherwise just empty.
class EmptyPage implements PageDriver {
  readonly kind = "openmoi" as const

  constructor(private readonly wall: boolean) {}

  async open(): Promise<string> {
    return "view:1"
  }

  async run<T>(handle: string, op: string): Promise<T> {
    return (op === "challenge" ? this.wall : []) as T
  }

  async url(): Promise<string> {
    return "https://x.com/i/flow/login"
  }

  async close(): Promise<void> {}
}

describe("SourceReader without items", () => {
  it("reports a sign in wall with the page it ended on", async () => {
    expect(await new SourceReader(() => new EmptyPage(true)).read(SOURCE, true, async () => {})).toEqual({ status: "challenge", url: "https://x.com/i/flow/login", driver: "openmoi" })
  })

  it("gives up on a page that stays empty after ten seconds, without scrolling", async () => {
    vi.useFakeTimers()
    try {
      const reading = new SourceReader(() => new EmptyPage(false)).read(SOURCE, true, async () => {})
      await vi.advanceTimersByTimeAsync(11_000)
      expect(await reading).toEqual({ status: "read", count: 0, driver: "openmoi" })
    } finally {
      vi.useRealTimers()
    }
  })
})
