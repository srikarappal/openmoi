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

// A brain whose health checks pass and that has no earlier spec versions, unless a test says otherwise.
function healthy_brain(brain: Partial<BrainClient>): BrainClient {
  return {
    report_extractor: vi.fn(async () => ({ healthy: true, status: "active", problem: "" })),
    previous_extractors: vi.fn(async () => []),
    ...brain,
  } as unknown as BrainClient
}

function make_pool(feed: PageDriver, brain: Partial<BrainClient> = {}, clock: () => number = Date.now, random: () => number = () => 0) {
  return new ReaderPool(() => feed, healthy_brain(brain), undefined, clock, random)
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


// A newest first page: posts listed newest first, five more after every scroll, new posts appear on top.
class NewestFirst implements PageDriver {
  readonly kind = "chrome" as const
  posts: RawRecord[] = []
  shown = 0
  opens = 0

  constructor(count: number, prefix = "p") {
    this.add(count, prefix)
  }

  // count new posts on top, each a minute newer than the last.
  add(count: number, prefix: string): void {
    const start = Date.parse("2026-11-10T08:00:00Z") + this.posts.length * 60_000
    const fresh = Array.from({ length: count }, (_, index) => ({
      native_id: `${prefix}${index}`,
      url: `https://x.com/p/${prefix}${index}`,
      title: `Post ${prefix}${index}`,
      published_at: new Date(start + index * 60_000).toISOString(),
    }))
    this.posts = [...fresh.reverse(), ...this.posts]
  }

  async open(): Promise<string> {
    this.opens += 1
    this.shown = 5
    return `tab${this.opens}`
  }

  async run<T>(_handle: string, op: string): Promise<T> {
    if (op === "challenge") return false as T
    if (op === "scroll") {
      this.shown += 5
      return true as T
    }
    return this.posts.slice(0, this.shown) as T
  }

  async url(): Promise<string> {
    return "https://x.com/i/lists/42"
  }

  async close(): Promise<void> {}
}

// The brain's answer to each batch: positions of records it had stored before.
class StoredBefore {
  readonly ids: string[] = []

  constructor(private readonly stored: Set<string>) {}

  readonly take = async (records: RawRecord[]): Promise<number[]> => {
    this.ids.push(...records.map((record) => String(record.native_id)))
    return records.flatMap((record, index) => (this.stored.has(String(record.native_id)) ? [index] : []))
  }
}

const LIST = source("page:x.com/i/lists/42", { start_url: "https://x.com/i/lists/42", chronological: true })

describe("ReaderPool newest first pages", () => {
  it("reads from the top until it reaches two posts read before, and says when the newer one was posted", async () => {
    const page = new NewestFirst(21)
    const pool = make_pool(page)
    const first = new Delivered()
    expect(await pool.fill(LIST, 30, first.take, true, true)).toEqual({ status: "ended", delivered: 21, driver: "chrome" })
    page.add(7, "n")
    const second = new Delivered()
    const outcome = await pool.fill(LIST, 30, second.take, true, true)
    expect(outcome).toEqual({ status: "complete", delivered: 7, driver: "chrome", since: page.posts[7].published_at })
    expect(second.ids).toEqual(["n6", "n5", "n4", "n3", "n2", "n1", "n0"])
  })

  it("does not stop at one old post pinned on top", async () => {
    const page = new NewestFirst(10)
    const pool = make_pool(page)
    await pool.fill(LIST, 30, new Delivered().take, true, true)
    page.add(6, "n")
    const pinned = page.posts.splice(page.posts.findIndex((post) => post.native_id === "p3"), 1)
    page.posts = [...pinned, ...page.posts]
    const after = new Delivered()
    const outcome = await pool.fill(LIST, 30, after.take, true, true)
    expect(outcome.status).toBe("complete")
    expect(after.ids).toEqual(["n5", "n4", "n3", "n2", "n1", "n0"])
  })

  it("after a restart learns from the brain what it stored before", async () => {
    const page = new NewestFirst(12)
    page.add(4, "n")
    const brain_had = new StoredBefore(new Set(Array.from({ length: 12 }, (_, index) => `p${index}`)))
    const outcome = await make_pool(page).fill(LIST, 30, brain_had.take, true, true)
    expect(outcome).toEqual({ status: "complete", delivered: 10, driver: "chrome", since: page.posts[4].published_at })
    expect(brain_had.ids).toEqual(["n3", "n2", "n1", "n0", "p11", "p10", "p9", "p8", "p7", "p6"])
  })

  it("never mistakes its own earlier reads in the same tab for old posts", async () => {
    const page = new NewestFirst(40)
    const pool = make_pool(page)
    expect((await pool.fill(LIST, 5, new Delivered().take, true, false)).status).toBe("read")
    expect(await pool.fill(LIST, 5, new Delivered().take, true, false)).toEqual({ status: "read", delivered: 5, driver: "chrome" })
    expect(page.opens).toBe(1)
  })

  it("leaves pages that are not newest first to read as before", async () => {
    const page = new NewestFirst(12)
    const brain_had = new StoredBefore(new Set(["p11", "p10", "p9"]))
    const outcome = await make_pool(page).fill({ ...LIST, chronological: false }, 5, brain_had.take, true, true)
    expect(outcome).toEqual({ status: "read", delivered: 5, driver: "chrome" })
  })

  it("caps a read from the top that never reaches anything read before", async () => {
    const page = new NewestFirst(400)
    const outcome = await make_pool(page).fill(LIST, 30, new Delivered().take, true, true)
    expect(outcome).toEqual({ status: "read", delivered: 300, driver: "chrome" })
  })

  it("says when an old pair has no time", async () => {
    const page = new NewestFirst(6)
    for (const post of page.posts) delete post.published_at
    const pool = make_pool(page)
    await pool.fill(LIST, 30, new Delivered().take, true, true)
    expect(await pool.fill(LIST, 30, new Delivered().take, true, true)).toEqual({ status: "complete", delivered: 0, driver: "chrome", since: null })
  })
})

// A watched page: its text, a sign in wall or a broken tab, and what openMoi did to it.
class WatchedPage implements PageDriver {
  readonly kind = "chrome" as const
  opened: string[] = []
  closed = 0
  wall = false
  broken = false

  async open(url: string): Promise<string> {
    if (this.broken) throw new Error("tab crashed")
    this.opened.push(url)
    return "tab1"
  }

  async run<T>(_handle: string, op: string): Promise<T> {
    if (op === "challenge") return this.wall as T
    return { title: "Visa slots", text: "No slots" } as T
  }

  async url(): Promise<string> {
    return "https://visa.example.gov/login"
  }

  async close(): Promise<void> {
    this.closed += 1
  }
}

describe("ReaderPool watched pages", () => {
  const WATCHED = source("watch:visa.example.gov/slots", { start_url: "https://visa.example.gov/slots", purpose: "watch", spec: null })

  it("reads a page's text in a tab it closes again, at the reader's pace unless forced", async () => {
    vi.useFakeTimers()
    const page = new WatchedPage()
    const pool = make_pool(page)
    const reading = pool.read_text(WATCHED, false)
    await pass_time(2_100)
    expect(await reading).toEqual({ status: "read", page: { title: "Visa slots", text: "No slots" }, driver: "chrome" })
    expect([page.opened, page.closed]).toEqual([["https://visa.example.gov/slots"], 1])
    expect(await pool.read_text(WATCHED, false)).toEqual({ status: "skipped" })
    const forced = pool.read_text(WATCHED, true)
    await pass_time(2_100)
    expect((await forced).status).toBe("read")
    expect(pool.steps_used(WATCHED.source_id)).toBe(2)
  })

  it("says when a sign in is in the way or the tab broke, and keeps to the daily budget", async () => {
    vi.useFakeTimers()
    const page = new WatchedPage()
    page.wall = true
    const pool = make_pool(page)
    const walled = pool.read_text(WATCHED, true)
    await pass_time(2_100)
    expect(await walled).toEqual({ status: "challenge", url: "https://visa.example.gov/login", driver: "chrome" })
    expect(page.closed).toBe(1)
    page.broken = true
    expect(await pool.read_text(WATCHED, true)).toEqual({ status: "failed", error: "tab crashed", driver: "chrome" })
    const thrifty = { ...WATCHED, budget: { ...WATCHED.budget, daily_steps: 0 } }
    expect(await make_pool(new WatchedPage()).read_text(thrifty, true)).toEqual({ status: "failed", error: "today's budget for this page is used", driver: "chrome" })
  })
})

// An item page read in full: a video, an article, a plain page, a check in the way or a broken tab.
class ItemPage implements PageDriver {
  readonly kind = "chrome" as const
  closed = 0
  wall = false
  article: RawRecord | null = { title: "Lithium", text: "Long article text" }

  constructor(private readonly broken = false) {}

  async open(): Promise<string> {
    if (this.broken) throw new Error("tab crashed")
    return "tab1"
  }

  async run<T>(_handle: string, op: string): Promise<T> {
    if (op === "challenge") return this.wall as T
    if (op === "transcript") return { title: "Video", description: "About it", caption_url: "https://www.youtube.com/api/timedtext?v=1" } as T
    if (op === "readability") return this.article as T
    return { title: "Page", text: "Plain text" } as T
  }

  async url(): Promise<string> {
    return "https://a.example/"
  }

  async close(): Promise<void> {
    this.closed += 1
  }
}

describe("ReaderPool items read in full", () => {
  it("reads a video's captions address, an article's text or a plain page's text, closing each tab", async () => {
    vi.useFakeTimers()
    const page = new ItemPage()
    const pool = make_pool(page)
    const video = pool.read_content("https://www.youtube.com/watch?v=1", true)
    await pass_time(2_100)
    expect(await video).toEqual({ status: "read", content: { title: "Video", text: "About it", caption_url: "https://www.youtube.com/api/timedtext?v=1" } })
    const article = pool.read_content("https://a.example/1", false)
    await pass_time(2_100)
    expect(await article).toEqual({ status: "read", content: { title: "Lithium", text: "Long article text", caption_url: null } })
    page.article = null
    const plain = pool.read_content("https://a.example/2", false)
    await pass_time(2_100)
    expect(await plain).toEqual({ status: "read", content: { title: "Page", text: "Plain text", caption_url: null } })
    page.article = { url: "https://a.example/3" }
    const untitled = pool.read_content("https://a.example/3", false)
    await pass_time(2_100)
    expect(await untitled).toEqual({ status: "read", content: { title: "", text: "", caption_url: null } })
    expect(page.closed).toBe(4)
  })

  it("fails on a check in the way, a broken tab or a used up budget", async () => {
    vi.useFakeTimers()
    const page = new ItemPage()
    page.wall = true
    const pool = make_pool(page)
    const walled = pool.read_content("https://a.example/1", false)
    await pass_time(2_100)
    expect(await walled).toEqual({ status: "failed", error: "a sign in or check is in the way" })
    expect(await make_pool(new ItemPage(true)).read_content("https://a.example/1", false)).toEqual({ status: "failed", error: "tab crashed" })
    const busy = make_pool(new ItemPage(true))
    for (let read = 0; read < 50; read++) await busy.read_content("https://a.example/1", false)
    expect(await busy.read_content("https://a.example/1", false)).toEqual({ status: "failed", error: "today's budget for reading items in full is used", budget: true })
  })
})

describe("ReaderPool resting after a check", () => {
  it("rests a source a day after a sign in wall unless you ask for it yourself", async () => {
    vi.useFakeTimers()
    const feed = new FakeFeed()
    feed.wall = true
    const pool = make_pool(feed)
    const first = pool.fill(source(), 10, new Delivered().take, true)
    await pass_time(11_000)
    expect((await first).status).toBe("challenge")
    feed.wall = false
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    expect(await pool.fill(source(), 10, new Delivered().take, false)).toEqual({ status: "skipped" })
    expect(feed.opens).toBe(1)
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    expect((await pool.fill(source(), 5, new Delivered().take, false)).status).toBe("read")
  })

  it("ends the rest when you read the source yourself", async () => {
    vi.useFakeTimers()
    const feed = new FakeFeed()
    feed.wall = true
    const pool = make_pool(feed, {}, () => 0)
    const walled = pool.fill(source(), 10, new Delivered().take, true)
    await pass_time(11_000)
    await walled
    feed.wall = false
    expect((await pool.fill(source(), 5, new Delivered().take, true)).status).toBe("read")
  })

  it("rests a watched page that hit a check too", async () => {
    vi.useFakeTimers()
    const page = new WatchedPage()
    page.wall = true
    const WATCHED = source("watch:visa.example.gov/slots", { start_url: "https://visa.example.gov/slots", purpose: "watch", spec: null })
    const pool = make_pool(page, {}, () => 0)
    const walled = pool.read_text(WATCHED, true)
    await pass_time(2_100)
    expect((await walled).status).toBe("challenge")
    expect(await pool.read_text(WATCHED, false)).toEqual({ status: "skipped" })
  })
})

describe("ReaderPool after the review", () => {
  it("offers a batch the brain did not take again, and never calls a page complete over it", async () => {
    const page = new NewestFirst(6)
    const pool = make_pool(page)
    const failing = vi.fn(async () => {
      throw new Error("brain restarting")
    })
    expect((await pool.fill(LIST, 30, failing, true, true)).status).toBe("failed")
    const later = new Delivered()
    const outcome = await pool.fill(LIST, 30, later.take, true, true)
    expect(outcome.status).toBe("ended")
    expect(later.ids).toHaveLength(6)
  })

  it("reads an article in full for a summary, not the short card text", async () => {
    vi.useFakeTimers()
    const page = new ItemPage()
    const run = vi.spyOn(page, "run")
    const pool = make_pool(page)
    const reading = pool.read_content("https://a.example/1", false)
    await pass_time(2_100)
    await reading
    expect(run).toHaveBeenCalledWith("tab1", "readability", { max_text: 30_000 })
  })
})

describe("ReaderPool drift", () => {
  it("gives a drifted spec up for a new one written from the page, without being told again", async () => {
    vi.useFakeTimers()
    const page = new FakeFeed()
    const drifted = { ...SPEC, version: 4, domain: "feed.example.com", path_pattern: "/" } as ExtractorSpec
    const fresh = { ...SPEC, version: 5 } as ExtractorSpec
    const brain = {
      report_extractor: vi.fn(async (report: { version: number }) => (report.version === 4 ? { healthy: false, status: "failing", problem: "found 2 items where it usually finds 20" } : { healthy: true, status: "candidate", problem: "" })),
      generate_extractor: vi.fn(async () => fresh),
      accept_extractor: vi.fn(async (spec: ExtractorSpec) => spec),
    }
    const pool = make_pool(page, brain as unknown as Partial<BrainClient>)
    const filling = pool.fill(source(undefined, { spec: drifted }), 5, new Delivered().take, true)
    await pass_time(6_000)
    expect((await filling).status).toBe("read")
    expect(brain.generate_extractor).toHaveBeenCalledWith("https://feed.example.com/", '<main><article class="post">{t:9}</article></main>', "the saved spec v4 found 2 items where it usually finds 20")
  })
})

// A feed page that also offers an RSS feed and whose own JSON was captured.
class OfferingFeed extends FakeFeed {
  structured_calls = 0
  feeds: Array<{ title: string; url: string }> = [{ title: "News", url: "https://feed.example.com/rss" }]
  broken = false

  override async run<T>(handle: string, op: string): Promise<T> {
    if (op === "structured") {
      this.structured_calls += 1
      if (this.broken) throw new Error("page gone")
      return { page_type: "feed", records: [], feeds: this.feeds } as T
    }
    return super.run<T>(handle, op)
  }

  captured(): RawRecord[] {
    return [{ native_id: "json1", url: "https://feed.example.com/json1", title: "From the page's own JSON" }]
  }
}

describe("ReaderPool feeds and captured JSON", () => {
  it("says once that a page offers a feed, and adds what the page's own JSON held", async () => {
    vi.useFakeTimers()
    const page = new OfferingFeed()
    const offered = vi.fn()
    const pool = new ReaderPool(() => page, healthy_brain({}), undefined, Date.now, () => 0, offered)
    const delivered = new Delivered()
    const filling = pool.fill(source(), 6, delivered.take, true, true)
    await pass_time(4_000)
    await filling
    expect(offered).toHaveBeenCalledWith(expect.objectContaining({ source_id: "page:feed.example.com" }), page.feeds)
    expect(delivered.ids).toContain("json1")
    const again = pool.fill(source(), 6, new Delivered().take, true, true)
    await pass_time(4_000)
    await again
    expect(offered).toHaveBeenCalledTimes(1)
    expect(page.structured_calls).toBe(1)
  })

  it("stays quiet when a page offers no feed or cannot say", async () => {
    vi.useFakeTimers()
    for (const page of [Object.assign(new OfferingFeed(), { feeds: [] }), Object.assign(new OfferingFeed(), { broken: true })]) {
      const offered = vi.fn()
      const pool = new ReaderPool(() => page, healthy_brain({}), undefined, Date.now, () => 0, offered)
      const filling = pool.fill(source(), 5, new Delivered().take, true, true)
      await pass_time(4_000)
      expect((await filling).status).toBe("read")
      expect(offered).not.toHaveBeenCalled()
    }
  })
})

describe("ReaderPool after the L1 review", () => {
  it("closes a page no spec could read instead of leaving it open in the background", async () => {
    vi.useFakeTimers()
    const page = new FakeFeed()
    const drifted = { ...SPEC, version: 4, domain: "feed.example.com", path_pattern: "/", item_root: "nothing" } as ExtractorSpec
    const brain = {
      report_extractor: vi.fn(async () => ({ healthy: false, status: "failing", problem: "found no items" })),
      generate_extractor: vi.fn(async () => {
        throw new Error("model down")
      }),
    }
    const pool = make_pool(page, brain as unknown as Partial<BrainClient>)
    for (let fill = 0; fill < 3; fill++) {
      const filling = pool.fill(source(undefined, { spec: drifted }), 5, new Delivered().take, true)
      await pass_time(12_000)
      expect((await filling).status).toBe("failed")
    }
    expect(page.opens).toBe(3)
    expect(page.closes).toBe(3)
    expect(pool.open_tabs()).toEqual([])
  })
})
