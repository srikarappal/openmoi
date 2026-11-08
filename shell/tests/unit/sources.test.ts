import { describe, expect, it } from "vitest"
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
  readonly kind = "chrome" as const
  scrolls = 0

  async open(): Promise<string> {
    return "tab1"
  }

  async run<T>(handle: string, op: string): Promise<T> {
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
