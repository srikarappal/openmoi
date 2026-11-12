import { describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import type { LensContext, LensManager } from "../../src/main/lenses"
import type { FillOutcome, ReaderPool } from "../../src/main/readers"
import { ViewController, view_lens_key } from "../../src/main/views"
import type { PageSource, ViewPage } from "../../src/shared/types"
import { Tracked } from "./tracked"

const X_SOURCE = { source_id: "x", start_url: "https://x.com/home" } as PageSource
const FEED_SOURCE = { source_id: "page:feed.example.com", start_url: "https://feed.example.com/" } as PageSource
const PAGE = { view_id: "feed", items: [], has_more: false, refreshing: false, warnings: [], version: "v1", summary: "", lens_stale: false, layout_hash: "h" } as unknown as ViewPage

function make_views(outcomes: FillOutcome[], pages: ViewPage[] = [], page_sources: PageSource[] = [X_SOURCE]) {
  const context = { key: view_lens_key("feed"), view_id: "feed", rendered: new Map(), send: vi.fn(), serial: <T>(work: () => Promise<T>) => work() } as unknown as LensContext
  const brain = {
    refresh: vi.fn(async () => ({ page_sources })),
    view_page: vi.fn(async () => pages.shift() ?? PAGE),
    ingest: vi.fn(async () => {}),
  }
  const sources = { fill: vi.fn(async (..._args: unknown[]) => outcomes.shift() ?? ({ status: "skipped" } as FillOutcome)) }
  const lenses = { get: (key: string) => (key === context.key ? context : undefined), all: () => [context] }
  const { labels, track } = new Tracked()
  const hooks = { open_original: vi.fn(), notify: vi.fn(), retract: vi.fn(), echo: vi.fn(), less_like_this: vi.fn(), lens_stale: vi.fn(), alert: vi.fn(), track, labels }
  const views = new ViewController(brain as unknown as BrainClient, lenses as unknown as LensManager, sources as unknown as ReaderPool, hooks)
  return { views, context, sources, hooks, brain }
}

describe("ViewController page sources", () => {
  it("asks for Chrome when openMoi's own session hits a login wall, then reads again once Chrome connects", async () => {
    const { views, context, sources, hooks } = make_views([
      { status: "challenge", url: "https://x.com/login", driver: "openmoi" },
      { status: "read", delivered: 12, driver: "chrome" },
    ])
    await views.refresh(context, false)
    expect(hooks.labels).toEqual(["Updating feed", "Reading x"])
    expect(hooks.notify).toHaveBeenCalledWith(expect.stringContaining("x needs your Chrome sign in"), "https://x.com/login", "source:x")
    await views.chrome_connected()
    expect(sources.fill).toHaveBeenLastCalledWith(X_SOURCE, 30, expect.any(Function), true, true)
    expect(hooks.retract).toHaveBeenLastCalledWith("source:x")
    expect(hooks.notify).toHaveBeenCalledTimes(1)
    await views.chrome_connected()
    expect(sources.fill).toHaveBeenCalledTimes(2)
  })

  it("does not read again for a sign in that is missing in Chrome itself", async () => {
    const { views, context, sources, hooks } = make_views([{ status: "challenge", url: "https://x.com/login", driver: "chrome" }])
    await views.refresh(context, false)
    expect(hooks.notify).toHaveBeenCalledWith(expect.stringContaining("x needs you in Chrome"), "https://x.com/login", "source:x")
    await views.chrome_connected()
    expect(sources.fill).toHaveBeenCalledTimes(1)
  })

  it("replaces a failure notice with the next read and leaves skipped reads alone", async () => {
    const { views, context, hooks } = make_views([{ status: "failed", error: "tab closed", driver: "chrome" }, { status: "skipped" }])
    await views.refresh(context, false)
    expect(hooks.notify).toHaveBeenCalledWith("x could not be read: tab closed", undefined, "source:x")
    await views.refresh(context, false)
    expect(hooks.retract).toHaveBeenCalledTimes(1)
  })
})

describe("ViewController warnings", () => {
  const PAUSED = "Topic tagging paused: tag needs your content but the fast slot is a hosted model"

  it("withdraws a warning once the brain stops reporting it, after a model change", async () => {
    const tagging = { ...PAGE, refreshing: true, warnings: [PAUSED] } as ViewPage
    const paused = { ...PAGE, warnings: [PAUSED] } as ViewPage
    const { views, context, hooks } = make_views([], [paused, paused, tagging, PAGE])
    await views.refresh(context, false)
    expect(hooks.notify).toHaveBeenCalledWith(PAUSED, undefined, `warning:${PAUSED}`)
    expect(hooks.retract).not.toHaveBeenCalled()
    await views.recheck("feed")
    expect(hooks.labels).toContain("Checking feed with the new model")
    expect(hooks.retract).toHaveBeenCalledWith(`warning:${PAUSED}`)
    expect(hooks.notify).toHaveBeenCalledTimes(1)
  })
})

function cursors(context: LensContext): Array<string | null> {
  return (context.send as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].cursor)
}

function fills(sources: { fill: ReturnType<typeof vi.fn> }): unknown[][] {
  return sources.fill.mock.calls.map((call) => [(call[0] as PageSource).source_id, call[1], call[3], call[4]])
}

// The lens shows count items, as if rendered and appended in that order.
function show_items(context: LensContext, count: number): string[] {
  const item_ids = Array.from({ length: count }, (_, index) => `item${index}`)
  for (const item_id of item_ids) context.rendered.set(item_id, { item_id } as never)
  return item_ids
}

function read(delivered: number): FillOutcome {
  return { status: "read", delivered, driver: "chrome" }
}

describe("ViewController reading ahead", () => {
  const RATED = { ...PAGE, keep_rate: { x: 0.5 } } as ViewPage

  it("starts every source from the top on a refresh and offers more past what is stored", async () => {
    const { views, context, sources } = make_views([read(20)])
    await views.refresh(context, false)
    expect(fills(sources)).toEqual([["x", 30, false, true]])
    expect(cursors(context).at(-1)).toBe("deeper")
  })

  it("reads ahead as you near the end, enough raw items for what the rules keep", async () => {
    const { views, context, sources, brain } = make_views([read(20), read(32)], [RATED, RATED, RATED])
    Object.assign(brain, { events: vi.fn(async () => ({ recorded: 1 })) })
    await views.refresh(context, false)
    const shown = show_items(context, 25)
    await views.on_event(context, { type: "seen", item_ids: [shown[2]] })
    expect(sources.fill).toHaveBeenCalledTimes(1)
    await views.on_event(context, { type: "seen", item_ids: [shown[10], shown[9]] })
    expect(fills(sources).at(-1)).toEqual(["x", 32, true, false])
  })

  it("reads ahead from where the tab stopped when the lens asks at the end", async () => {
    const { views, context, sources } = make_views([read(20), read(30)])
    await views.refresh(context, false)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(fills(sources).at(-1)).toEqual(["x", 30, true, false])
  })

  it("splits the need between sources by how much of each the rules keep, within limits", async () => {
    const rated = { ...PAGE, keep_rate: { x: 1, "page:feed.example.com": 0 } } as ViewPage
    const { views, context, sources } = make_views([read(5), read(5), read(5), read(5)], [rated, rated, rated, rated], [X_SOURCE, FEED_SOURCE])
    await views.refresh(context, false)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(fills(sources).slice(2)).toEqual([
      ["x", 15, true, false],
      ["page:feed.example.com", 120, true, false],
    ])
  })

  it("stops reading a source that ended or used today's budget until a refresh brings it back", async () => {
    const { views, context, sources } = make_views([read(20), { status: "ended", delivered: 0, driver: "chrome" }, read(20)])
    await views.refresh(context, false)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(cursors(context).at(-1)).toBeNull()
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(sources.fill).toHaveBeenCalledTimes(2)
    await views.refresh(context, true)
    expect(cursors(context).at(-1)).toBe("deeper")
  })

  it("never reads ahead for a view without page sources", async () => {
    const { views, context, sources } = make_views([], [], [])
    await views.refresh(context, false)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(sources.fill).not.toHaveBeenCalled()
    expect(cursors(context).at(-1)).toBeNull()
  })
})

describe("ViewController one read at a time", () => {
  it("does not start a read ahead while a read is going and a refresh waits for one", async () => {
    let running = 0
    let most = 0
    const { views, context, sources } = make_views([])
    sources.fill.mockImplementation(async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 100))
      running -= 1
      return read(10)
    })
    await views.refresh(context, false)
    const ahead = views.on_event(context, { type: "more", cursor: "deeper" })
    await vi.waitFor(() => expect(sources.fill).toHaveBeenCalledTimes(2))
    await Promise.all([ahead, views.refresh(context, true), views.on_event(context, { type: "more", cursor: "deeper" })])
    expect(most).toBe(1)
    expect(fills(sources).map((call) => call[3])).toEqual([true, false, true])
  })

  it("reads ahead again after a read that failed", async () => {
    const { views, context, sources } = make_views([])
    sources.fill.mockRejectedValueOnce(new Error("brain restarting")).mockResolvedValue(read(30))
    await views.refresh(context, false).catch(() => undefined)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(fills(sources).at(-1)).toEqual(["x", 30, true, false])
  })
})

describe("ViewController warnings that come back", () => {
  it("shows a warning again after it cleared and returned", async () => {
    const WARNING = "Topic tagging paused: the model is not running"
    const warned = { ...PAGE, warnings: [WARNING] } as ViewPage
    const { views, context, hooks } = make_views([], [warned, warned, PAGE, PAGE, warned, warned])
    await views.refresh(context, false)
    await views.refresh(context, false)
    await views.refresh(context, false)
    expect(hooks.notify.mock.calls.filter((call) => call[0] === WARNING)).toHaveLength(2)
    expect(hooks.retract).toHaveBeenCalledWith(`warning:${WARNING}`)
  })
})


function render_count(context: LensContext): number {
  return (context.send as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0].type === "render").length
}

describe("ViewController rendering", () => {
  function render_setup(pages: ViewPage[]) {
    const made = make_views([], pages)
    const lenses = { get: () => made.context, open: vi.fn(async () => made.context), load: vi.fn(async () => {}) }
    const brain = Object.assign(made.brain, { lens: vi.fn(async () => "<p>lens</p>"), events: vi.fn(async () => ({ recorded: 1 })) })
    const views = new ViewController(
      brain as unknown as BrainClient,
      lenses as unknown as LensManager,
      { fill: vi.fn(async () => ({ status: "skipped" })) } as unknown as ReaderPool,
      made.hooks,
    )
    return { ...made, views, lenses, brain }
  }

  it("re-renders an open view only when its files changed and says what it understood", async () => {
    const changed = { ...PAGE, version: "v2", summary: "Reading X. No shorts." } as ViewPage
    const { views, context, hooks } = render_setup([PAGE, PAGE, PAGE, changed, changed])
    await views.show("feed")
    expect(render_count(context)).toBe(1)
    await views.show("feed")
    expect(render_count(context)).toBe(1)
    expect(hooks.echo).not.toHaveBeenCalled()
    await views.show("feed")
    expect(render_count(context)).toBe(2)
    expect(hooks.echo).toHaveBeenCalledWith("I understood: Reading X. No shorts.")
  })

  it("after an edit renders at once, then again once the brain finished retagging", async () => {
    const busy = { ...PAGE, refreshing: true } as ViewPage
    const { views, context } = render_setup([PAGE, busy, PAGE, PAGE])
    vi.useFakeTimers()
    try {
      const editing = views.after_edit("feed")
      await vi.advanceTimersByTimeAsync(2_000)
      await editing
    } finally {
      vi.useRealTimers()
    }
    expect((context.send as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[0].type === "render")).toHaveLength(2)
  })

  it("loads a new look into the open lens", async () => {
    const { views, lenses, context } = render_setup([])
    await views.reload_lens("feed")
    expect(lenses.load).toHaveBeenCalledWith(context, "<p>lens</p>")
  })

  it("records only seen items it actually rendered and ignores events for unknown items", async () => {
    const { views, context, brain } = render_setup([])
    context.rendered.set("a", { item_id: "a", url: "https://a.com/a" } as never)
    await views.on_event(context, { type: "seen", item_ids: ["a", "ghost"] })
    await views.on_event(context, { type: "seen", item_ids: ["ghost"] })
    await views.on_event(context, { type: "open", item_id: "ghost" })
    expect(brain.events.mock.calls).toEqual([[[{ view_id: "feed", item_id: "a", event_kind: "seen" }]]])
  })
})

describe("ViewController editions", () => {
  const SEVEN = "2026-11-10T07:00:00.000Z"
  const SIX_PM = "2026-11-10T18:00:00.000Z"
  const EDITION = { ...PAGE, edition: SEVEN, next_edition: SIX_PM, caught_up: true } as ViewPage

  it("reads for an edition with no lens open, deeper than a look, and waits for the brain's feeds", async () => {
    const reading = { ...PAGE, view_id: "morning", reading: true } as ViewPage
    const { views, sources, brain, hooks, context } = make_views([read(40)], [reading, PAGE])
    sources.fill.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[2] as (records: unknown[]) => Promise<void>)([{ url: "https://x.com/1", text: "hi" }])
      return read(1)
    })
    await views.read_for_edition("morning")
    expect(brain.refresh).toHaveBeenCalledWith("morning", true)
    expect(fills(sources)).toEqual([["x", 120, false, true]])
    expect(brain.ingest).toHaveBeenCalledWith("x", [{ url: "https://x.com/1", text: "hi" }], "https://x.com/home")
    expect(brain.view_page).toHaveBeenCalledTimes(2)
    expect(context.send).not.toHaveBeenCalled()
    expect(hooks.labels).toEqual(["Reading for the next morning edition", "Reading x"])
  })

  it("gives an open lens what an edition read finds", async () => {
    const { views, sources, context } = make_views([], [EDITION, PAGE])
    sources.fill.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[2] as (records: unknown[]) => Promise<void>)([{ url: "https://x.com/1", text: "hi" }])
      return read(1)
    })
    await views.read_for_edition("feed")
    expect(context.send).toHaveBeenCalledWith({ type: "append", items: [], cursor: null })
  })

  it("never reads ahead in an edition and says once when you have read all of it", async () => {
    const { views, context, sources, hooks, brain } = make_views([read(20)], [EDITION, EDITION, EDITION, EDITION])
    Object.assign(brain, { events: vi.fn(async () => ({ recorded: 1 })), lens: vi.fn(async () => "<p></p>") })
    await views.on_ready(context)
    await vi.waitFor(() => expect(hooks.labels).toContain("Updating feed"))
    await vi.waitFor(() => expect(brain.view_page).toHaveBeenCalledTimes(2))
    expect(sources.fill).not.toHaveBeenCalled()
    expect(cursors(context).every((cursor) => cursor === null)).toBe(true)
    const shown = show_items(context, 3)
    await views.on_event(context, { type: "seen", item_ids: [shown[2]] })
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(sources.fill).not.toHaveBeenCalled()
    const told = hooks.notify.mock.calls.filter((call) => String(call[2]).startsWith("edition:"))
    expect(told).toHaveLength(1)
    expect(told[0][0]).toMatch(/^That is all of the .+ edition of feed\. The next one comes out at .+\.$/)
  })

  it("reads an edition's sources when you refresh it yourself", async () => {
    const { views, context, sources } = make_views([read(5), read(5)], [EDITION, EDITION, EDITION])
    await views.refresh(context, false)
    expect(sources.fill).toHaveBeenCalledTimes(1)
    await views.refresh(context, false)
    expect(sources.fill).toHaveBeenCalledTimes(1)
    await views.refresh(context, true)
    expect(sources.fill).toHaveBeenCalledTimes(2)
  })

  it("remembers what you saw, for the end of a visit", async () => {
    const { views, context, brain } = make_views([])
    Object.assign(brain, { events: vi.fn(async () => ({ recorded: 1 })) })
    context.rendered.set("a", { item_id: "a", title: "First story", text: null, url: "https://a.com" } as never)
    context.rendered.set("b", { item_id: "b", title: null, text: "x".repeat(200), url: "https://b.com" } as never)
    context.rendered.set("c", { item_id: "c", title: null, text: null, url: "https://c.com/3" } as never)
    const before = Date.now()
    await views.on_event(context, { type: "seen", item_ids: ["a", "b", "c", "a", "missing"] })
    expect(views.seen_since("feed", before)).toEqual(["First story", "x".repeat(80), "https://c.com/3"])
    expect(views.seen_since("feed", Date.now() + 1)).toEqual([])
    expect(views.seen_since("tech", 0)).toEqual([])
  })

  it("reads a source again in Chrome for a view whose lens is closed", async () => {
    const { views, sources } = make_views([{ status: "challenge", url: "https://x.com/login", driver: "openmoi" }, read(3)], [], [X_SOURCE])
    await views.read_for_edition("morning")
    await views.chrome_connected()
    expect(fills(sources)).toEqual([
      ["x", 120, false, true],
      ["x", 30, true, true],
    ])
  })
})

describe("ViewController nothing missed", () => {
  const LIST = { source_id: "page:x.com/i/lists/42", start_url: "https://x.com/i/lists/42", chronological: true } as PageSource
  const OTHER = { source_id: "page:friends.example", start_url: "https://friends.example/", chronological: true } as PageSource
  const CAUGHT_UP = { ...PAGE, caught_up: true } as ViewPage

  function complete(since: string | null): FillOutcome {
    return { status: "complete", delivered: 3, driver: "chrome", since }
  }

  it("says nothing was missed once caught up with every newest first source read back to an earlier read", async () => {
    const since = new Date().toISOString()
    const { views, context, hooks, sources } = make_views([complete(since), read(4)], Array(6).fill(CAUGHT_UP), [LIST, X_SOURCE])
    await views.refresh(context, true)
    const told = hooks.notify.mock.calls.filter((call) => call[2] === "complete:feed")
    expect(told).toHaveLength(1)
    expect(told[0][0]).toMatch(/^Nothing missed: everything new on x\.com\/i\/lists\/42 since \d.+ is in this view\.$/)
    expect(fills(sources).map((fill) => fill[0])).toEqual(["page:x.com/i/lists/42", "x"])
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(fills(sources).at(-1)?.[0]).toBe("x")
  })

  it("waits for every newest first source and starts over on a refresh", async () => {
    const { views, context, hooks } = make_views([complete(null), read(4), complete(null), complete("2026-01-05T09:00:00Z"), complete(null), complete(null)], Array(12).fill(CAUGHT_UP), [LIST, OTHER])
    await views.refresh(context, true)
    expect(hooks.notify.mock.calls.filter((call) => call[2] === "complete:feed")).toHaveLength(0)
    await views.refresh(context, true)
    expect(hooks.retract).not.toHaveBeenCalledWith("complete:feed")
    const told = hooks.notify.mock.calls.filter((call) => call[2] === "complete:feed")
    expect(told).toHaveLength(1)
    expect(told[0][0]).toMatch(/^Nothing missed: everything new on x\.com\/i\/lists\/42 and friends\.example since \w+ .+ is in this view\.$/)
    await views.refresh(context, true)
    expect(hooks.retract).toHaveBeenCalledWith("complete:feed")
    expect(hooks.notify.mock.calls.filter((call) => call[2] === "complete:feed").at(-1)?.[0]).toBe("Nothing missed: everything new on x.com/i/lists/42 and friends.example is in this view.")
  })

  it("passes the brain's memory of stored records back to the reader", async () => {
    const { views, context, sources, brain } = make_views([], [CAUGHT_UP], [LIST])
    brain.ingest.mockResolvedValueOnce({ already: [1] } as never).mockResolvedValueOnce(undefined as never)
    const answers: unknown[] = []
    sources.fill.mockImplementationOnce(async (...args: unknown[]) => {
      const take = args[2] as (records: unknown[]) => Promise<number[]>
      answers.push(await take([{ url: "a" }, { url: "b" }]), await take([{ url: "c" }]))
      return read(3)
    })
    await views.refresh(context, true)
    expect(answers).toEqual([[1], []])
  })
})

describe("ViewController following lists", () => {
  const FOLLOWING = { source_id: "page:x.com/me/following", start_url: "https://x.com/me/following", purpose: "follows" } as PageSource

  it("reads a following list to its end into who you know, shows the view again and never reads it ahead", async () => {
    const { views, context, sources, brain } = make_views([read(5)], [], [FOLLOWING, X_SOURCE])
    Object.assign(brain, { follows: vi.fn(async () => ({ stored: 2 })), events: vi.fn(async () => ({ recorded: 1 })) })
    sources.fill.mockImplementationOnce(async (...args: unknown[]) => {
      const take = args[2] as (records: unknown[]) => Promise<number[]>
      expect(await take([{ url: "https://x.com/maya" }])).toEqual([])
      return { status: "ended", delivered: 1, driver: "chrome" } as FillOutcome
    })
    await views.refresh(context, false)
    expect(fills(sources)).toEqual([
      ["page:x.com/me/following", 2000, false, true],
      ["x", 30, false, true],
    ])
    expect((brain as unknown as { follows: ReturnType<typeof vi.fn> }).follows).toHaveBeenCalledWith("https://x.com/me/following", [{ url: "https://x.com/maya" }])
    expect(brain.ingest).not.toHaveBeenCalled()
    expect((context.send as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0].type === "render")).toBe(true)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(fills(sources).at(-1)?.[0]).toBe("x")
  })

  it("stores follows from a scheduled read without a lens", async () => {
    const { views, sources, brain } = make_views([], [], [FOLLOWING])
    Object.assign(brain, { follows: vi.fn(async () => ({ stored: 1 })) })
    sources.fill.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[2] as (records: unknown[]) => Promise<number[]>)([{ url: "https://x.com/maya" }])
      return { status: "ended", delivered: 1, driver: "chrome" } as FillOutcome
    })
    await views.read_for_edition("morning")
    expect(fills(sources)).toEqual([["page:x.com/me/following", 2000, false, true]])
  })

  it("still reads a due following list when an edition opens by itself", async () => {
    const EDITION = { ...PAGE, edition: "2026-11-10T07:00:00Z", next_edition: "2026-11-10T18:00:00Z" } as ViewPage
    const { views, context, sources } = make_views([], [EDITION, EDITION, EDITION], [FOLLOWING, X_SOURCE])
    await views.on_ready(context)
    await vi.waitFor(() => expect(sources.fill).toHaveBeenCalledTimes(1))
    expect(fills(sources)).toEqual([["page:x.com/me/following", 2000, false, true]])
  })
})

describe("ViewController open anyway", () => {
  it("offers to open an edition early once you have read it all", async () => {
    const EDITION = { ...PAGE, edition: "2026-11-10T07:00:00Z", next_edition: "2026-11-10T18:00:00Z", caught_up: true } as ViewPage
    const { views, context, hooks } = make_views([], [EDITION, EDITION])
    await views.refresh(context, false)
    const [, , tag, action] = hooks.notify.mock.calls.find((call) => call[2] === "edition:feed") ?? []
    expect(tag).toBe("edition:feed")
    expect(action).toEqual({ label: "Open anyway", command: { type: "open_early", view_id: "feed" } })
  })
})

describe("ViewController watched pages", () => {
  const WATCHED = { source_id: "watch:visa.example.gov/slots", start_url: "https://visa.example.gov/slots", purpose: "watch" } as PageSource
  const ALERT = { view_id: "feed", title: "Visa slots changed", text: "Added: Slot available" }

  function watch_views(outcome: unknown, report: unknown) {
    const made = make_views([], Array(6).fill(PAGE), [WATCHED, X_SOURCE])
    Object.assign(made.sources, { read_text: vi.fn(async () => outcome) })
    Object.assign(made.brain, { watch_report: vi.fn(async () => report) })
    return made
  }

  it("looks at a watched page on a refresh, shows a change in the open lens and alerts", async () => {
    const { views, context, hooks, brain, sources } = watch_views({ status: "read", page: { title: "Visa slots", text: "Slot available" }, driver: "chrome" }, { changed: true, alert: ALERT })
    await views.refresh(context, true)
    expect((sources as unknown as { read_text: ReturnType<typeof vi.fn> }).read_text).toHaveBeenCalledWith(WATCHED, true)
    expect((brain as unknown as { watch_report: ReturnType<typeof vi.fn> }).watch_report).toHaveBeenCalledWith("https://visa.example.gov/slots", "Visa slots", "Slot available")
    expect(hooks.alert).toHaveBeenCalledWith(ALERT)
    expect(fills(sources)).toEqual([["x", 30, true, true]])
    expect(hooks.labels).toContain("Looking at https://visa.example.gov/slots")
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(fills(sources).every((fill) => fill[0] === "x")).toBe(true)
  })

  it("stays quiet when the page did not change, or changed in a way no view keeps", async () => {
    const unchanged = watch_views({ status: "read", page: { title: "Visa", text: "No slots" }, driver: "chrome" }, { changed: false, alert: null })
    await unchanged.views.check_watch(WATCHED, false)
    expect(unchanged.hooks.alert).not.toHaveBeenCalled()
    expect(unchanged.hooks.retract).toHaveBeenCalledWith("source:watch:visa.example.gov/slots")
    const ignored = watch_views({ status: "read", page: { title: "Visa", text: "No slots this week" }, driver: "chrome" }, { changed: true, alert: null })
    await ignored.views.check_watch(WATCHED, false)
    expect(ignored.hooks.alert).not.toHaveBeenCalled()
  })

  it("says why a look failed and skips a look that is not due", async () => {
    const walled = watch_views({ status: "challenge", url: "https://visa.example.gov/login", driver: "chrome" }, null)
    await walled.views.check_watch(WATCHED, false)
    expect(walled.hooks.notify).toHaveBeenCalledWith(expect.stringContaining("needs you in Chrome"), "https://visa.example.gov/login", "source:watch:visa.example.gov/slots")
    const broken = watch_views({ status: "failed", error: "tab crashed", driver: "chrome" }, null)
    await broken.views.check_watch(WATCHED, false)
    expect(broken.hooks.notify).toHaveBeenCalledWith("https://visa.example.gov/slots could not be looked at: tab crashed", undefined, "source:watch:visa.example.gov/slots")
    const skipped = watch_views({ status: "skipped" }, null)
    await skipped.views.check_watch(WATCHED, false)
    expect(skipped.hooks.notify).not.toHaveBeenCalled()
    expect((skipped.brain as unknown as { watch_report: ReturnType<typeof vi.fn> }).watch_report).not.toHaveBeenCalled()
  })
})

describe("ViewController summaries and notes", () => {
  const WANTED = { item_id: "a1", url: "https://blog.example/1", video: false }

  function content_views(outcome: unknown) {
    const made = make_views([])
    Object.assign(made.sources, { read_content: vi.fn(async () => outcome) })
    Object.assign(made.brain, { add_content: vi.fn(async () => ({ status: "summarized" })), events: vi.fn(async () => ({ recorded: 1, notes: ["a1"] })) })
    return made as typeof made & { brain: typeof made.brain & { add_content: ReturnType<typeof vi.fn>; events: ReturnType<typeof vi.fn> } }
  }

  it("reads a wanted item in full and hands it to the brain to summarize, even when the read failed", async () => {
    const read = content_views({ status: "read", content: { title: "Lithium", text: "Long text", caption_url: null } })
    await read.views.summarize(WANTED)
    expect(read.brain.add_content).toHaveBeenCalledWith("a1", "summary", "Lithium", "Long text", null)
    expect(read.hooks.labels).toEqual(["Reading https://blog.example/1 in full"])
    const failed = content_views({ status: "failed", error: "tab crashed" })
    await failed.views.summarize(WANTED)
    expect(failed.brain.add_content).toHaveBeenCalledWith("a1", "summary", "", "", null)
  })

  it("takes a note on an item you open when a note rule covers it", async () => {
    const made = content_views({ status: "read", content: { title: "", text: "Long text", caption_url: null } })
    made.context.rendered.set("a1", { item_id: "a1", url: "https://blog.example/1", title: "Lithium recycling" } as never)
    await made.views.on_event(made.context, { type: "open", item_id: "a1" })
    await vi.waitFor(() => expect(made.brain.add_content).toHaveBeenCalledWith("a1", "note", "Lithium recycling", "Long text", null))
    expect(made.hooks.open_original).toHaveBeenCalledWith("https://blog.example/1")
  })

  it("takes no note without a note rule, or when the item could not be read", async () => {
    const quiet = content_views({ status: "read", content: { title: "T", text: "x", caption_url: null } })
    quiet.brain.events.mockResolvedValueOnce({ recorded: 1 })
    quiet.context.rendered.set("a1", { item_id: "a1", url: "https://blog.example/1", title: "T" } as never)
    await quiet.views.on_event(quiet.context, { type: "open", item_id: "a1" })
    const unreadable = content_views({ status: "failed", error: "tab crashed" })
    unreadable.context.rendered.set("a1", { item_id: "a1", url: "https://blog.example/1", title: "T" } as never)
    await unreadable.views.on_event(unreadable.context, { type: "open", item_id: "a1" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(quiet.brain.add_content).not.toHaveBeenCalled()
    expect(unreadable.brain.add_content).not.toHaveBeenCalled()
  })

  it("says when a note could not be taken", async () => {
    const made = content_views({ status: "read", content: { title: "T", text: "x", caption_url: null } })
    made.brain.add_content.mockRejectedValueOnce(new Error("brain gone"))
    made.context.rendered.set("a1", { item_id: "a1", url: "https://blog.example/1", title: "T" } as never)
    await made.views.on_event(made.context, { type: "open", item_id: "a1" })
    await vi.waitFor(() => expect(made.hooks.notify).toHaveBeenCalledWith("No note was taken: Error: brain gone"))
  })
})

describe("ViewController summaries in place", () => {
  it("sends a fresh summary to every lens that shows the item, and to no other", async () => {
    const made = make_views([])
    const summarized = { item_id: "a1", url: "https://blog.example/1", title: "T", extra: { summary: "Short." } }
    Object.assign(made.sources, { read_content: vi.fn(async () => ({ status: "read", content: { title: "T", text: "x", caption_url: null } })) })
    Object.assign(made.brain, { add_content: vi.fn(async () => ({ status: "summarized", item: summarized })) })
    await made.views.summarize({ item_id: "a1", url: "https://blog.example/1", video: false })
    expect(made.context.send).not.toHaveBeenCalled()
    made.context.rendered.set("a1", { item_id: "a1" } as never)
    await made.views.summarize({ item_id: "a1", url: "https://blog.example/1", video: false })
    expect(made.context.send).toHaveBeenCalledWith({ type: "update", items: [{ item: summarized, reasons: [] }], cursor: null })
  })
})

describe("ViewController assist pages", () => {
  const ASSIST = { source_id: "page:facebook.com/events", start_url: "https://www.facebook.com/events", mode: "assist", spec: null } as PageSource

  it("never reads an assist page in a tab and asks for Mine once when it has no spec", async () => {
    const { views, context, sources, hooks } = make_views([read(5)], [], [ASSIST, X_SOURCE])
    await views.refresh(context, true)
    expect(fills(sources).map((fill) => fill[0])).toEqual(["x"])
    expect(hooks.notify).toHaveBeenCalledWith(
      "https://www.facebook.com/events is read only while you browse it yourself: open it in Chrome and press Mine once, so openMoi learns the page.",
      "https://www.facebook.com/events",
      "source:page:facebook.com/events",
    )
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(fills(sources).every((fill) => fill[0] === "x")).toBe(true)
  })

  it("stays quiet about an assist page that already has its spec", async () => {
    const learned = { ...ASSIST, spec: { item_root: "div" } } as unknown as PageSource
    const { views, context, hooks } = make_views([], [], [learned])
    await views.refresh(context, true)
    expect(hooks.notify).not.toHaveBeenCalled()
    expect(hooks.retract).toHaveBeenCalledWith("source:page:facebook.com/events")
  })
})

describe("ViewController after the review", () => {
  it("shows an open edition view again when a new edition comes out, though its files did not change", async () => {
    const made = make_views([], [])
    const lenses = { get: () => made.context, open: vi.fn(async () => made.context), all: () => [made.context] }
    const seven = { ...PAGE, edition: "2026-11-10T07:00:00Z" } as ViewPage
    const six = { ...PAGE, edition: "2026-11-10T18:00:00Z" } as ViewPage
    const answers = [seven, seven, six, six]
    Object.assign(made.brain, { view_page: vi.fn(async () => answers.shift() ?? six), lens: vi.fn(async () => "<p></p>") })
    const views = new ViewController(made.brain as unknown as BrainClient, lenses as unknown as LensManager, made.sources as unknown as ReaderPool, made.hooks)
    await views.on_ready(made.context)
    const sent = () => (made.context.send as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].type)
    await vi.waitFor(() => expect(sent()).toEqual(["render", "append"]))
    await views.show("feed")
    expect(sent()).toEqual(["render", "append", "render"])
  })

  it("skips a summary for now when the day's reads in full are used, without marking the item", async () => {
    const made = make_views([])
    Object.assign(made.sources, { read_content: vi.fn(async () => ({ status: "failed", error: "budget", budget: true })) })
    const add_content = vi.fn()
    Object.assign(made.brain, { add_content })
    await made.views.summarize({ item_id: "a1", url: "https://blog.example/1", video: false })
    expect(add_content).not.toHaveBeenCalled()
  })
})
