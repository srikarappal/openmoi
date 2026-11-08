import { afterEach, describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import type { DriverKind, PageDriver } from "../../src/main/drivers"
import { ReaderPool } from "../../src/main/readers"
import type { ExtractorSpec, PageSource, RawRecord } from "../../src/shared/types"

const SPEC = { item_root: "article", fields: {}, pagination: { kind: "scroll", step_px: 900 } } as unknown as ExtractorSpec

function source(source_id = "page:feed.example.com", fields: Partial<PageSource> = {}): PageSource {
  return {
    source_id,
    page_type: "listing",
    start_url: `https://${source_id.replace("page:", "")}/`,
    spec: SPEC,
    budget: { page_loads: 1, scroll_steps: 5, min_step_interval_ms: 0, daily_steps: 200 },
    ...fields,
  }
}

// A feed page that shows five posts more after every scroll, up to total; it counts what openMoi did to it.
class FakeFeed implements PageDriver {
  opens = 0
  closes = 0
  scrolls = 0
  shown = 0
  url_now = ""
  wall = false
  failures = 0

  constructor(
    readonly kind: DriverKind = "chrome",
    private readonly total = 1000,
    private readonly first = 5,
  ) {}

  async open(url: string): Promise<string> {
    this.opens += 1
    this.shown = Math.min(this.first, this.total)
    this.url_now = url
    return `tab${this.opens}`
  }

  async run<T>(handle: string, op: string): Promise<T> {
    if (this.failures > 0 && op === "scroll") {
      this.failures -= 1
      throw new Error("Chrome reconnected before answering")
    }
    if (op === "challenge") return this.wall as T
    if (op === "skeleton") return '<main><article class="post">{t:9}</article></main>' as T
    if (op === "scroll") {
      this.scrolls += 1
      this.shown = Math.min(this.shown + 5, this.total)
      return true as T
    }
    if (this.wall) return [] as T
    const records: RawRecord[] = Array.from({ length: this.shown }, (_, index) => ({ native_id: `post${index}`, url: `https://feed.example.com/${index}`, title: `Post ${index}` }))
    return records as T
  }

  async url(): Promise<string> {
    return this.url_now
  }

  async close(): Promise<void> {
    this.closes += 1
  }
}

class Delivered {
  readonly ids: string[] = []

  readonly take = async (records: RawRecord[]): Promise<void> => {
    this.ids.push(...records.map((record) => String(record.native_id)))
  }
}

// Moves fake time forward in small steps, so timers scheduled after a few awaits still fire.
async function pass_time(total_ms: number): Promise<void> {
  for (let passed = 0; passed < total_ms; passed += 100) await vi.advanceTimersByTimeAsync(100)
}

function make_pool(feed: PageDriver, brain: Partial<BrainClient> = {}, clock: () => number = Date.now, random: () => number = () => 0) {
  return new ReaderPool(() => feed, brain as BrainClient, undefined, clock, random)
}

afterEach(() => {
  vi.useRealTimers()
})

describe("ReaderPool tabs", () => {
  it("keeps one tab per source and continues where it stopped, handing over each post once", async () => {
    const feed = new FakeFeed()
    const pool = make_pool(feed)
    const delivered = new Delivered()
    expect(await pool.fill(source(), 12, delivered.take, true)).toEqual({ status: "read", delivered: 15, driver: "chrome" })
    expect(await pool.fill(source(), 10, delivered.take, true)).toEqual({ status: "read", delivered: 10, driver: "chrome" })
    expect(feed.opens).toBe(1)
    expect(feed.scrolls).toBe(4)
    expect(new Set(delivered.ids).size).toBe(delivered.ids.length)
    expect(delivered.ids.at(-1)).toBe("post24")
    expect(pool.open_tabs()).toEqual(["page:feed.example.com"])
  })

  it("starts over from the top when asked, skipping posts it already handed over", async () => {
    const feed = new FakeFeed()
    const pool = make_pool(feed)
    const delivered = new Delivered()
    await pool.fill(source(), 10, delivered.take, true)
    expect(await pool.fill(source(), 5, delivered.take, true, true)).toEqual({ status: "read", delivered: 5, driver: "chrome" })
    expect([feed.opens, feed.closes]).toEqual([2, 1])
    expect(delivered.ids.slice(-5)).toEqual(["post10", "post11", "post12", "post13", "post14"])
  })

  it("opens the tab again after you navigated it away", async () => {
    const feed = new FakeFeed()
    const pool = make_pool(feed)
    await pool.fill(source(), 5, new Delivered().take, true)
    feed.url_now = "https://elsewhere.example/"
    await pool.fill(source(), 5, new Delivered().take, true)
    expect([feed.opens, feed.closes]).toEqual([2, 1])
  })

  it("keeps at most four tabs and closes the one used longest ago; idle tabs close after ten minutes", async () => {
    vi.useFakeTimers()
    const feed = new FakeFeed()
    const pool = make_pool(feed)
    for (const name of ["a", "b", "c", "d", "e"]) await pool.fill(source(`page:${name}.example.com`), 5, new Delivered().take, true)
    expect(pool.open_tabs()).toEqual(["page:b.example.com", "page:c.example.com", "page:d.example.com", "page:e.example.com"])
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(pool.open_tabs()).toEqual([])
    expect(feed.closes).toBe(5)
  })

  it("closes every tab on request", async () => {
    const feed = new FakeFeed()
    const pool = make_pool(feed)
    await pool.fill(source("page:a.example.com"), 5, new Delivered().take, true)
    await pool.fill(source("page:b.example.com"), 5, new Delivered().take, true)
    await pool.close_all()
    expect([pool.open_tabs(), feed.closes]).toEqual([[], 2])
  })
})

describe("ReaderPool limits", () => {
  it("says a feed ended when three scrolls bring nothing new and a page without scrolling ends at once", async () => {
    const short = new FakeFeed("chrome", 12)
    expect(await make_pool(short).fill(source(), 50, new Delivered().take, true)).toEqual({ status: "ended", delivered: 12, driver: "chrome" })
    expect(short.scrolls).toBe(5)
    const still = new FakeFeed()
    const once = source("page:still.example.com", { spec: { ...SPEC, pagination: { kind: "none", step_px: 0 } } })
    expect(await make_pool(still).fill(once, 50, new Delivered().take, true)).toEqual({ status: "ended", delivered: 5, driver: "chrome" })
    expect(still.scrolls).toBe(0)
  })

  it("stops at today's scroll budget and goes on again tomorrow", async () => {
    let now = new Date(2026, 10, 8, 9, 0).getTime()
    const feed = new FakeFeed()
    const pool = make_pool(feed, {}, () => now)
    const tight = source("page:feed.example.com", { budget: { page_loads: 1, scroll_steps: 5, min_step_interval_ms: 0, daily_steps: 3 } })
    expect(await pool.fill(tight, 100, new Delivered().take, true)).toEqual({ status: "exhausted", delivered: 20, driver: "chrome" })
    expect(pool.steps_used(tight.source_id)).toBe(3)
    now += 24 * 60 * 60 * 1000
    expect(pool.steps_used(tight.source_id)).toBe(0)
    expect((await pool.fill(tight, 5, new Delivered().take, true)).status).toBe("read")
  })

  it("pauses between scrolls for the source's interval plus a random part of half of it", async () => {
    vi.useFakeTimers()
    const feed = new FakeFeed()
    const pool = make_pool(feed, {}, Date.now, () => 1)
    const paced = source("page:feed.example.com", { budget: { page_loads: 1, scroll_steps: 5, min_step_interval_ms: 1000, daily_steps: 200 } })
    const filling = pool.fill(paced, 15, new Delivered().take, true)
    await vi.advanceTimersByTimeAsync(1)
    expect(feed.scrolls).toBe(1)
    await vi.advanceTimersByTimeAsync(1_400)
    expect(feed.scrolls).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(feed.scrolls).toBe(2)
    await vi.advanceTimersByTimeAsync(1_500)
    await filling
  })

  it("leaves automatic fills of a source to once every ten minutes; forced fills always go", async () => {
    const pool = make_pool(new FakeFeed())
    expect((await pool.fill(source(), 5, new Delivered().take, false)).status).toBe("read")
    expect(await pool.fill(source(), 5, new Delivered().take, false)).toEqual({ status: "skipped" })
    expect((await pool.fill(source(), 5, new Delivered().take, true)).status).toBe("read")
  })
})

describe("ReaderPool trouble", () => {
  it("reports a sign in wall with the page it ended on and does not keep the tab", async () => {
    const feed = new FakeFeed()
    feed.wall = true
    const pool = make_pool(feed)
    expect(await pool.fill(source(), 5, new Delivered().take, true)).toEqual({ status: "challenge", url: "https://feed.example.com/", driver: "chrome" })
    expect([pool.open_tabs(), feed.closes]).toEqual([[], 1])
  })

  it("tries once more after Chrome fails mid read, without handing over a post twice", async () => {
    vi.useFakeTimers()
    const feed = new FakeFeed()
    feed.failures = 1
    const delivered = new Delivered()
    const filling = make_pool(feed).fill(source(), 12, delivered.take, true)
    await pass_time(3_000)
    expect((await filling).status).toBe("read")
    expect(feed.opens).toBe(2)
    expect(new Set(delivered.ids).size).toBe(delivered.ids.length)
  })

  it("does not retry openMoi's own session and reports the failure", async () => {
    const feed = new FakeFeed("openmoi")
    feed.failures = 1
    expect(await make_pool(feed).fill(source(), 12, new Delivered().take, true)).toEqual({ status: "failed", error: "Chrome reconnected before answering", driver: "openmoi" })
  })
})

describe("ReaderPool on a site it has no spec for", () => {
  it("makes a spec from the page once, keeps it and reads with it", async () => {
    vi.useFakeTimers()
    const feed = new FakeFeed()
    const generated = { ...SPEC, domain: "feed.example.com", version: 1 } as ExtractorSpec
    const brain = { generate_extractor: vi.fn(async () => generated), accept_extractor: vi.fn(async (spec: ExtractorSpec) => ({ ...spec, version: 2 })) }
    const pool = make_pool(feed, brain)
    const delivered = new Delivered()
    const filling = pool.fill(source("page:feed.example.com", { spec: null }), 8, delivered.take, true)
    await pass_time(3_000)
    expect(await filling).toEqual({ status: "read", delivered: 10, driver: "chrome" })
    expect(brain.generate_extractor).toHaveBeenCalledWith("https://feed.example.com/", '<main><article class="post">{t:9}</article></main>', undefined)
    expect(brain.accept_extractor).toHaveBeenCalledTimes(1)
    const again = pool.fill(source("page:feed.example.com", { spec: null }), 5, delivered.take, true)
    await pass_time(500)
    expect((await again).status).toBe("read")
    expect(brain.generate_extractor).toHaveBeenCalledTimes(1)
  })

  it("says why when no spec finds the items and checks for a sign in wall first", async () => {
    vi.useFakeTimers()
    const brain = { generate_extractor: vi.fn(async () => Promise.reject(new Error("model timed out"))) }
    const filling = make_pool(new FakeFeed(), brain).fill(source("page:feed.example.com", { spec: null }), 8, new Delivered().take, true)
    await pass_time(3_000)
    expect(await filling).toEqual({ status: "failed", error: "could not find the items on https://feed.example.com/: model timed out", driver: "chrome", final: true })
    expect(brain.generate_extractor).toHaveBeenCalledTimes(2)
    const walled = new FakeFeed()
    walled.wall = true
    const blocked = make_pool(walled, brain).fill(source("page:feed.example.com", { spec: null }), 8, new Delivered().take, true)
    await pass_time(3_000)
    expect((await blocked).status).toBe("challenge")
  })
})

describe("ReaderPool slow and vanished pages", () => {
  it("opens the tab again when it is gone altogether", async () => {
    const feed = new FakeFeed()
    const pool = make_pool(feed)
    await pool.fill(source(), 5, new Delivered().take, true)
    feed.url = async () => Promise.reject(new Error("No tab with id: 7"))
    await pool.fill(source(), 5, new Delivered().take, true)
    expect(feed.opens).toBe(2)
  })

  it("waits up to ten seconds for a slow page's first items, then scrolls it anyway", async () => {
    vi.useFakeTimers()
    const feed = new FakeFeed("chrome", 1000, 0)
    const delivered = new Delivered()
    const filling = make_pool(feed).fill(source(), 5, delivered.take, true)
    await pass_time(9_000)
    expect(feed.scrolls).toBe(0)
    await pass_time(1_500)
    expect(await filling).toEqual({ status: "read", delivered: 5, driver: "chrome" })
    expect(feed.scrolls).toBe(1)
  })
})

