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
  const lenses = { get: (key: string) => (key === context.key ? context : undefined) }
  const { labels, track } = new Tracked()
  const hooks = { open_original: vi.fn(), notify: vi.fn(), retract: vi.fn(), echo: vi.fn(), less_like_this: vi.fn(), lens_stale: vi.fn(), track, labels }
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
