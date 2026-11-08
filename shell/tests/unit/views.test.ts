import { describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import type { LensContext, LensManager } from "../../src/main/lenses"
import type { SourceOutcome, SourceReader } from "../../src/main/sources"
import { ViewController, view_lens_key } from "../../src/main/views"
import type { PageSource, ViewPage } from "../../src/shared/types"

const X_SOURCE = { source_id: "x", start_url: "https://x.com/home" } as PageSource
const PAGE = { view_id: "feed", items: [], has_more: false, refreshing: false, warnings: [], version: "v1", summary: "", lens_stale: false, layout_hash: "h" } as unknown as ViewPage

function make_views(outcomes: SourceOutcome[]) {
  const context = { key: view_lens_key("feed"), view_id: "feed", rendered: new Map(), send: vi.fn(), serial: <T>(work: () => Promise<T>) => work() } as unknown as LensContext
  const brain = {
    refresh: vi.fn(async () => ({ page_sources: [X_SOURCE] })),
    view_page: vi.fn(async () => PAGE),
    ingest: vi.fn(async () => {}),
  }
  const sources = { read: vi.fn(async () => outcomes.shift() ?? ({ status: "skipped" } as SourceOutcome)) }
  const lenses = { get: (key: string) => (key === context.key ? context : undefined) }
  const hooks = { open_original: vi.fn(), notify: vi.fn(), retract: vi.fn(), echo: vi.fn(), less_like_this: vi.fn(), lens_stale: vi.fn() }
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
    expect(hooks.notify).toHaveBeenCalledWith(expect.stringContaining("x needs your Chrome sign in"), "https://x.com/login", "source:x")
    await views.chrome_connected()
    expect(sources.read).toHaveBeenLastCalledWith(X_SOURCE, true, expect.any(Function))
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
