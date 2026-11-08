import { describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import type { LensContext, LensManager } from "../../src/main/lenses"
import type { SourceOutcome, SourceReader } from "../../src/main/sources"
import { ViewController, view_lens_key } from "../../src/main/views"
import type { PageSource, ViewPage } from "../../src/shared/types"

const X_SOURCE = { source_id: "x", start_url: "https://x.com/home" } as PageSource
const PAGE = { view_id: "feed", items: [], has_more: false, refreshing: false, warnings: [], version: "v1", summary: "", lens_stale: false, layout_hash: "h" } as unknown as ViewPage

function make_views(outcomes: SourceOutcome[], pages: ViewPage[] = []) {
  const context = { key: view_lens_key("feed"), view_id: "feed", rendered: new Map(), send: vi.fn(), serial: <T>(work: () => Promise<T>) => work() } as unknown as LensContext
  const brain = {
    refresh: vi.fn(async () => ({ page_sources: [X_SOURCE] })),
    view_page: vi.fn(async () => pages.shift() ?? PAGE),
    ingest: vi.fn(async () => {}),
  }
  const sources = { read: vi.fn(async () => outcomes.shift() ?? ({ status: "skipped" } as SourceOutcome)) }
  const lenses = { get: (key: string) => (key === context.key ? context : undefined) }
  const labels: string[] = []
  const track = <T>(label: string, work: () => Promise<T>): Promise<T> => {
    labels.push(label)
    return work()
  }
  const hooks = { open_original: vi.fn(), notify: vi.fn(), retract: vi.fn(), echo: vi.fn(), less_like_this: vi.fn(), lens_stale: vi.fn(), track, labels }
  const views = new ViewController(brain as unknown as BrainClient, lenses as unknown as LensManager, sources as unknown as SourceReader, hooks)
  return { views, context, sources, hooks }
}

describe("ViewController page sources", () => {
  it("asks for Chrome when openMoi's own session hits a login wall, then reads again once Chrome connects", async () => {
    const { views, context, sources, hooks } = make_views([
      { status: "challenge", url: "https://x.com/login", driver: "openmoi" },
      { status: "read", count: 12, driver: "chrome" },
    ])
    await views.refresh(context, false)
    expect(hooks.labels).toEqual(["Updating feed", "Reading x"])
    expect(hooks.notify).toHaveBeenCalledWith(expect.stringContaining("x needs your Chrome sign in"), "https://x.com/login", "source:x")
    await views.chrome_connected()
    expect(sources.read).toHaveBeenLastCalledWith(X_SOURCE, true, expect.any(Function), 1)
    expect(hooks.retract).toHaveBeenLastCalledWith("source:x")
    expect(hooks.notify).toHaveBeenCalledTimes(1)
    await views.chrome_connected()
    expect(sources.read).toHaveBeenCalledTimes(2)
  })

  it("does not read again for a sign in that is missing in Chrome itself", async () => {
    const { views, context, sources, hooks } = make_views([{ status: "challenge", url: "https://x.com/login", driver: "chrome" }])
    await views.refresh(context, false)
    expect(hooks.notify).toHaveBeenCalledWith(expect.stringContaining("x needs you in Chrome"), "https://x.com/login", "source:x")
    await views.chrome_connected()
    expect(sources.read).toHaveBeenCalledTimes(1)
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

describe("ViewController reading further down", () => {
  function cursors(context: LensContext): Array<string | null> {
    return (context.send as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].cursor)
  }

  function reads(...counts: number[]): SourceOutcome[] {
    return counts.map((count) => ({ status: "read", count, driver: "chrome" }))
  }

  it("past the stored items it reads X further down each time, then says caught up", async () => {
    const { views, context, sources, hooks } = make_views(reads(10, 20, 30, 40))
    await views.refresh(context, false)
    expect(cursors(context).at(-1)).toBe("deeper")
    for (const depth of [2, 3, 4]) {
      await views.on_event(context, { type: "more", cursor: "deeper" })
      expect(sources.read).toHaveBeenLastCalledWith(X_SOURCE, true, expect.any(Function), depth)
    }
    expect(cursors(context).at(-1)).toBeNull()
    expect(hooks.labels).toContain("Reading further down for feed")
    await views.on_event(context, { type: "more", cursor: "more" })
    expect(sources.read).toHaveBeenCalledTimes(4)
  })

  it("says caught up as soon as reading further down reaches nothing new", async () => {
    const { views, context, sources } = make_views(reads(20, 20))
    await views.refresh(context, false)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(cursors(context).at(-1)).toBeNull()
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(sources.read).toHaveBeenCalledTimes(2)
  })

  it("starts from the top again after a refresh", async () => {
    const { views, context, sources } = make_views(reads(10, 20, 10, 20))
    await views.refresh(context, false)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    await views.refresh(context, true)
    await views.on_event(context, { type: "more", cursor: "deeper" })
    expect(sources.read).toHaveBeenLastCalledWith(X_SOURCE, true, expect.any(Function), 2)
  })
})

describe("ViewController one read at a time", () => {
  it("a refresh during a read further down waits for it, so two reads never overlap", async () => {
    let running = 0
    let most = 0
    const { views, context, sources } = make_views([])
    sources.read.mockImplementation(async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running -= 1
      return { status: "read", count: 10 * sources.read.mock.calls.length, driver: "chrome" } as SourceOutcome
    })
    await views.refresh(context, false)
    await Promise.all([views.on_event(context, { type: "more", cursor: "deeper" }), views.refresh(context, true), views.on_event(context, { type: "more", cursor: "deeper" })])
    expect(most).toBe(1)
    expect(sources.read.mock.calls.map((call) => (call as unknown[])[3])).toEqual([1, 1, 2])
  })

  it("reading further down waits for the first read and skips going deeper when it brought new items", async () => {
    let finish: (outcome: SourceOutcome) => void = () => {}
    const more_page = { ...PAGE, has_more: true } as ViewPage
    const { views, context, sources } = make_views([], [PAGE, PAGE, more_page])
    sources.read.mockImplementationOnce(() => new Promise<SourceOutcome>((resolve) => (finish = resolve)))
    const refreshing = views.refresh(context, false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const deeper = views.on_event(context, { type: "more", cursor: "deeper" })
    finish({ status: "read", count: 20, driver: "chrome" })
    await Promise.all([refreshing, deeper])
    expect(sources.read).toHaveBeenCalledTimes(1)
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

