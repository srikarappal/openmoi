import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import type { PageDriver } from "../../src/main/drivers"
import type { LensContext, LensManager } from "../../src/main/lenses"
import { synthetic_view_items } from "../../src/shared/fixtures"
import type { IngestResult, RawRecord } from "../../src/shared/types"
import { FakeBrowserWindow, ipc_event, ipcMain, reset_electron, session } from "./fake_electron"

vi.mock("electron", async () => await import("./fake_electron"))

const { SmokeTester } = await import("../../src/main/smoke")
const { MineController, chrome_mine_key, tab_mine_key } = await import("../../src/main/mine")
const { configure_sessions, LENS_PARTITION } = await import("../../src/main/sessions")

interface LensScript {
  ready?: boolean
  console_error?: string
  rendered?: "all" | "half"
  load_error?: Error
  crash?: boolean
  stray_request?: string
}

// Plays the lens inside the smoke tester's hidden window as described.
function script_lens(script: LensScript): void {
  FakeBrowserWindow.on_created = (window) => {
    const contents = window.webContents
    contents.load_error = script.load_error ?? null
    contents.on_send = (channel, message) => {
      if (channel !== "moi:lens") return
      const ids = (message as { items: Array<{ item: { item_id: string } }> }).items.map((entry) => entry.item.item_id)
      contents.script_result = script.rendered === "half" ? ids.slice(0, ids.length / 2) : ids
      if (script.stray_request) session.fromPartition(LENS_PARTITION).request_handler?.({ url: script.stray_request, resourceType: "image", webContentsId: contents.id } as never, ignore)
    }
    const original = contents.loadURL.bind(contents)
    contents.loadURL = async (url: string) => {
      await original(url)
      if (script.console_error) contents.emit("console-message", { level: "error", message: script.console_error })
      if (script.crash) contents.emit("render-process-gone", {}, { reason: "oom" })
      if (script.ready !== false) ipcMain.emit("moi:lens_event", ipc_event(contents), { type: "ready" })
    }
  }
}

function ignore(): void {}

async function smoke(kind: "feed" | "article" = "feed"): Promise<string | null> {
  const checking = new SmokeTester("/dist/preload_lens.js").problem("<p>lens</p>", kind)
  await vi.advanceTimersByTimeAsync(6_000)
  return checking
}

describe("SmokeTester", () => {
  beforeEach(() => {
    reset_electron()
    configure_sessions()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("passes a lens that renders every synthetic item and cleans up after itself", async () => {
    script_lens({})
    expect(await smoke()).toBeNull()
    const [window] = FakeBrowserWindow.created
    expect(window.options).toMatchObject({ show: false })
    expect(window.destroyed).toBe(true)
    expect(ipcMain.listenerCount("moi:lens_event")).toBe(0)
    const navigation = { preventDefault: vi.fn() }
    window.webContents.emit("will-navigate", navigation)
    expect(navigation.preventDefault).toHaveBeenCalled()
    expect(window.webContents.open_handler?.({ url: "https://evil.example" })).toEqual({ action: "deny" })
  })

  it.each<[string, LensScript, string]>([
    ["never calls ready", { ready: false }, "the lens never called moi.ready()"],
    ["throws before ready", { ready: false, console_error: "moi is not defined" }, "script error: moi is not defined"],
    ["throws after ready", { console_error: "cannot read item.title" }, "script error: cannot read item.title"],
    ["crashes", { crash: true }, "script error: the lens crashed: oom"],
    ["drops items", { rendered: "half" }, "15 of 30 items were not rendered with data-item-id"],
    ["fails to load", { load_error: new Error("bad data url") }, "bad data url"],
    ["loads something that is not an item image", { stray_request: "https://collector.example/p.gif?d=1" }, "the lens tried to load https://collector.example/p.gif?d=1, which is not an item image"],
  ])("fails a lens that %s", async (_label, script, problem) => {
    script_lens(script)
    expect(await smoke()).toBe(problem)
  })

  it("lets the lens load the synthetic items' own images", async () => {
    const image = synthetic_view_items("feed").find((entry) => entry.item.image_url)?.item.image_url ?? ""
    script_lens({ stray_request: image })
    expect(await smoke()).toBeNull()
  })
})

function records(count: number): RawRecord[] {
  return Array.from({ length: count }, (_, index) => ({ url: `https://news.example.com/${index}`, title: `Story ${index}` }))
}

const STALE: IngestResult = { items: [], view_items: [], lens_stale: true, layout_hash: "h1" }

function make_mine(page: Record<string, unknown>, brain_fields: Record<string, unknown> = {}) {
  const driver = {
    kind: "openmoi",
    run: vi.fn(async (_handle: string, op: string, args?: { spec?: { item_root: string } }) => {
      if (op === "extract") return (page[args?.spec?.item_root ?? ""] as RawRecord[]) ?? []
      return page[op] ?? null
    }),
    close: vi.fn(async () => {}),
  }
  const context = { key: "tab:1", view_id: "site_news.example.com", rendered: new Map(), send: vi.fn() }
  const lenses = { get: vi.fn((): LensContext | undefined => undefined), open: vi.fn(async () => context), load: vi.fn(async () => {}), close: vi.fn() }
  const brain = {
    find_extractor: vi.fn(async () => null),
    generate_extractor: vi.fn(async () => ({ item_root: "li.story" })),
    accept_extractor: vi.fn(async (spec: unknown) => spec),
    report_extractor: vi.fn(async () => ({ healthy: true, status: "candidate", problem: "" })),
    previous_extractors: vi.fn(async () => []),
    ingest: vi.fn(async (): Promise<IngestResult> => ({ items: [], view_items: [{ item: { item_id: "s1", url: "https://news.example.com/1" } as never, reasons: [] }], lens_stale: false, layout_hash: "h0" })),
    lens: vi.fn(async () => "<p>lens</p>"),
    events: vi.fn(async () => ({ recorded: 1 })),
    ...brain_fields,
  }
  const hooks = { notify: vi.fn(), open_original: vi.fn(), lens_stale: vi.fn(), less_like_this: vi.fn() }
  const mine = new MineController(brain as unknown as BrainClient, lenses as unknown as LensManager, hooks)
  const target = { key: tab_mine_key(1), driver: driver as unknown as PageDriver, handle: "contents:5", url: "https://news.example.com/?p=2" }
  return { mine, brain, lenses, hooks, driver, target, context }
}

describe("MineController", () => {
  it("reads an article in reader mode and shows it in the site's own view", async () => {
    const { mine, brain, lenses, target } = make_mine({ readability: { url: "https://news.example.com/a", title: "A", extra: {} } })
    expect(await mine.enable(target)).toBe(true)
    expect(brain.ingest).toHaveBeenCalledWith("site:news.example.com", [expect.objectContaining({ title: "A" })], target.url, "site_news.example.com", "article")
    expect(brain.lens).toHaveBeenCalledWith("site_news.example.com", "article")
    expect(lenses.open).toHaveBeenCalledWith("tab:1", "site_news.example.com", "<p>lens</p>")
    expect(mine.view_for("tab:1")).toBe("site_news.example.com")
    expect(brain.find_extractor).not.toHaveBeenCalled()
  })

  it("uses a saved listing spec when it still finds the items", async () => {
    const { mine, brain, target } = make_mine({ "li.saved": records(5) }, { find_extractor: vi.fn(async () => ({ item_root: "li.saved", version: 2 })) })
    expect(await mine.enable(target)).toBe(true)
    expect(brain.generate_extractor).not.toHaveBeenCalled()
    expect((brain.ingest.mock.calls[0] as unknown[])[1]).toHaveLength(5)
  })

  it("makes a new spec from the skeleton when the saved one stopped working and keeps it", async () => {
    const { mine, brain, target } = make_mine(
      { "li.saved": records(1), skeleton: "<ul>{t:5}</ul>", "li.story": records(4) },
      { find_extractor: vi.fn(async () => ({ item_root: "li.saved", version: 3 })) },
    )
    expect(await mine.enable(target)).toBe(true)
    expect(brain.generate_extractor).toHaveBeenCalledWith(target.url, "<ul>{t:5}</ul>", "the saved spec v3 found 1 items with a title and url")
    expect(brain.accept_extractor).toHaveBeenCalledWith({ item_root: "li.story" })
  })

  it("gives up after two specs that find too little and says why", async () => {
    const generate_extractor = vi.fn().mockResolvedValueOnce({ item_root: "li.none" }).mockRejectedValueOnce(new Error("model timed out"))
    const { mine, hooks, target } = make_mine({ skeleton: "<ul></ul>" }, { generate_extractor })
    expect(await mine.enable(target)).toBe(false)
    expect(generate_extractor.mock.calls[1][2]).toBe("the spec found 0 items with a title and url; it needs at least 3")
    expect(hooks.notify).toHaveBeenCalledWith("Could not make a Mine view of this page: model timed out")
  })

  it("reports a page it could not read at all", async () => {
    const { mine, hooks, target, driver } = make_mine({})
    driver.run.mockRejectedValueOnce(new Error("page view:1 is gone"))
    expect(await mine.enable(target)).toBe(false)
    expect(hooks.notify).toHaveBeenCalledWith("Could not read this page: page view:1 is gone")
  })

  it("reloads an open lens, renders on ready, asks for a new look when stale", async () => {
    const { mine, lenses, hooks, target, context } = make_mine({ readability: { url: "https://news.example.com/a", title: "A" } }, { ingest: vi.fn(async () => ({ ...STALE, view_items: [] })) })
    lenses.get.mockReturnValue(context as unknown as LensContext)
    await mine.enable(target)
    expect(lenses.load).toHaveBeenCalledWith(context, "<p>lens</p>")
    expect(hooks.lens_stale).toHaveBeenCalledWith("site_news.example.com", "article", "h1")
    expect(mine.owns(context as unknown as LensContext)).toBe(true)
    mine.on_ready(context as unknown as LensContext)
    expect(context.send).toHaveBeenCalledWith({ type: "render", items: [], cursor: null })
  })

  it("opens originals and passes on less like this for rendered items only", async () => {
    const { mine, brain, hooks, target, context } = make_mine({ readability: { url: "https://news.example.com/a", title: "A" } })
    await mine.enable(target)
    const item = { item_id: "s1", url: "https://news.example.com/1" }
    context.rendered.set("s1", item)
    await mine.on_event(context as unknown as LensContext, { type: "open", item_id: "s1" })
    await mine.on_event(context as unknown as LensContext, { type: "less_like_this", item_id: "s1" })
    await mine.on_event(context as unknown as LensContext, { type: "open", item_id: "unknown" })
    expect(brain.events).toHaveBeenCalledWith([{ view_id: "site_news.example.com", item_id: "s1", event_kind: "open" }])
    expect(hooks.open_original).toHaveBeenCalledWith("tab:1", item.url)
    expect(hooks.less_like_this).toHaveBeenCalledWith("site_news.example.com", item)
    expect(hooks.open_original).toHaveBeenCalledTimes(1)
  })

  it("ranks again after a site edit, reloads after a new look and lets go of the page when turned off", async () => {
    const { mine, brain, lenses, driver, target, context } = make_mine({ readability: { url: "https://news.example.com/a", title: "A" } })
    await mine.enable(target)
    lenses.get.mockReturnValue(context as unknown as LensContext)
    await mine.after_edit("site_news.example.com")
    await mine.after_edit("feed")
    expect(brain.ingest).toHaveBeenCalledTimes(2)
    expect(context.send).toHaveBeenCalledWith(expect.objectContaining({ type: "render" }))
    await mine.reload_lens("site_news.example.com")
    expect(lenses.load).toHaveBeenCalledTimes(1)
    mine.disable("tab:1")
    expect(lenses.close).toHaveBeenCalledWith("tab:1")
    expect(driver.close).toHaveBeenCalledWith("contents:5")
    expect(mine.view_for("tab:1")).toBeUndefined()
    expect(chrome_mine_key(3)).toBe("chrome:3")
  })
})

describe("Mine with structured data and health checks", () => {
  const SPEC_V2 = { domain: "news.example.com", path_pattern: "/", version: 2, item_root: "li.gone" }
  const SPEC_V1 = { domain: "news.example.com", path_pattern: "/", version: 1, item_root: "li.story" }

  it("shows a product page by its own structured data, without any spec", async () => {
    const product = { url: "https://shop.example/p/1", title: "Desk lamp", kind: "product", "extra.price_text": "USD 24.99" }
    const { mine, brain, target } = make_mine({ structured: { page_type: "product", records: [product], feeds: [] } })
    await mine.enable(target)
    expect(brain.ingest).toHaveBeenCalledWith("site:news.example.com", [product], target.url, "site_news.example.com", "listing")
    expect(brain.find_extractor).not.toHaveBeenCalled()
  })

  it("falls back from a drifted spec to its earlier version, reporting each run", async () => {
    const { mine, brain, target } = make_mine(
      { "li.story": records(5), "li.gone": [] },
      {
        find_extractor: vi.fn(async () => SPEC_V2),
        previous_extractors: vi.fn(async () => [SPEC_V1]),
        report_extractor: vi.fn(async (report: { version: number }) => (report.version === 2 ? { healthy: false, status: "failing", problem: "found no items" } : { healthy: true, status: "active", problem: "" })),
      },
    )
    await mine.enable(target)
    expect(brain.previous_extractors).toHaveBeenCalledWith(target.url, 2)
    expect(brain.generate_extractor).not.toHaveBeenCalled()
    expect((brain.report_extractor.mock.calls as unknown as Array<[{ count: number }]>).map((call) => call[0].count)).toEqual([0, 5])
  })

  it("uses the items a page's structured data names before writing a new spec", async () => {
    const listed = records(4)
    const { mine, brain, target } = make_mine({ structured: { page_type: "listing", records: listed, feeds: [] } })
    await mine.enable(target)
    expect(brain.generate_extractor).not.toHaveBeenCalled()
    expect(brain.ingest).toHaveBeenCalledWith("site:news.example.com", listed, target.url, "site_news.example.com", "listing")
  })

  it("writes a new spec when the old ones and the structured data fail, telling the model why, and rejects one the oracle doubts", async () => {
    const { mine, brain, target, hooks } = make_mine(
      { "li.story": records(5), "li.gone": [] },
      {
        find_extractor: vi.fn(async () => SPEC_V2),
        report_extractor: vi.fn(async (report: { version: number }) => ({ healthy: report.version !== 2, status: "candidate", problem: report.version === 2 ? "found no items" : "" })),
        accept_extractor: vi.fn(async (spec: object) => ({ ...spec, version: 3 })),
      },
    )
    await mine.enable(target)
    expect(brain.generate_extractor).toHaveBeenCalledWith(target.url, null, "the saved spec v2 found no items")
    expect(hooks.notify).not.toHaveBeenCalled()
    const doubted = make_mine(
      { "li.story": records(5) },
      { report_extractor: vi.fn(async () => ({ healthy: false, status: "failing", problem: "the items look like menu links" })) },
    )
    await doubted.mine.enable(doubted.target)
    expect(doubted.brain.generate_extractor).toHaveBeenCalledTimes(2)
    expect(doubted.brain.generate_extractor).toHaveBeenLastCalledWith(doubted.target.url, null, "the new spec the items look like menu links")
    expect(doubted.hooks.notify).toHaveBeenCalledWith("Could not make a Mine view of this page: the new spec the items look like menu links")
  })
})

describe("Mine product pages after the L1 review", () => {
  it("shows the product record, not whatever comes first", async () => {
    const product = { url: "https://shop.example/p/1", title: "Desk lamp", kind: "product" }
    const { mine, brain, target } = make_mine({ structured: { page_type: "product", records: [{ url: "https://shop.example/", title: "Home" }, product], feeds: [] } })
    await mine.enable(target)
    expect(brain.ingest).toHaveBeenCalledWith("site:news.example.com", [product], target.url, "site_news.example.com", "listing")
  })
})
