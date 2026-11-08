import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ViewHost } from "../../src/main/host"
import type { ViewItem } from "../../src/shared/types"
import { FakeSession, FakeWebContentsView, ipc_event, ipcMain, reset_electron, session } from "./fake_electron"

vi.mock("electron", async () => await import("./fake_electron"))

const { LensManager, LensContext } = await import("../../src/main/lenses")
const { TabManager } = await import("../../src/main/tabs")
const { configure_sessions, LENS_PARTITION } = await import("../../src/main/sessions")

class FakeHost implements ViewHost {
  readonly page_preload = "/dist/preload_page.js"
  readonly lens_preload = "/dist/preload_lens.js"
  readonly attached: unknown[] = []
  readonly detached: unknown[] = []

  attach(view: unknown): void {
    this.attached.push(view)
  }

  attach_behind(view: unknown): void {
    this.attached.push(view)
  }

  detach(view: unknown): void {
    this.detached.push(view)
  }
}

function view_item(item_id: string, image_url: string | null = null): ViewItem {
  return { item: { item_id, url: `https://a.com/${item_id}`, image_url } as never, reasons: [] }
}

function lens_event(contents: unknown, message: unknown): void {
  ipcMain.emit("moi:lens_event", ipc_event(contents as never), message)
}

function cancelled(lens: FakeSession, url: string, webContentsId: number): boolean {
  let result = false
  lens.request_handler?.({ url, resourceType: "image", webContentsId } as never, (response) => (result = response.cancel))
  return result
}

beforeEach(() => {
  reset_electron()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("LensManager", () => {
  function make_lenses() {
    const host = new FakeHost()
    const events = { on_ready: vi.fn(), on_event: vi.fn() }
    return { host, events, lenses: new LensManager(host, events) }
  }

  it("opens a sandboxed lens view once per key that cannot navigate or open windows", async () => {
    const { host, lenses } = make_lenses()
    const context = await lenses.open("view:feed", "feed", "<p>lens</p>")
    const [view] = FakeWebContentsView.created
    expect(view.options.webPreferences).toMatchObject({ partition: "lens", sandbox: true, contextIsolation: true })
    expect(host.attached).toEqual([view])
    expect(view.webContents.loads[0]).toMatch(/^data:text\/html;charset=utf-8;base64,/)
    const navigation = { preventDefault: vi.fn() }
    view.webContents.emit("will-navigate", navigation)
    expect(navigation.preventDefault).toHaveBeenCalled()
    expect(view.webContents.open_handler?.({ url: "https://evil.example" })).toEqual({ action: "deny" })
    expect(await lenses.open("view:feed", "feed", "<p>other</p>")).toBe(context)
    expect(lenses.get("view:feed")).toBe(context)
    expect(lenses.all()).toEqual([context])
  })

  it("passes ready once per load and checked messages on, from its own lenses only", async () => {
    const { events, lenses } = make_lenses()
    const context = await lenses.open("view:feed", "feed", "<p>lens</p>")
    const contents = context.view.webContents
    lens_event(contents, { type: "ready" })
    lens_event(contents, { type: "ready" })
    expect(events.on_ready).toHaveBeenCalledTimes(1)
    await lenses.load(context, "<p>new look</p>")
    expect(context.ready).toBe(false)
    lens_event(contents, { type: "ready" })
    expect(events.on_ready).toHaveBeenCalledTimes(2)
    lens_event(contents, { type: "seen", item_ids: ["a"] })
    lens_event(contents, { type: "rm -rf" })
    lens_event({ id: 99999 }, { type: "seen", item_ids: ["a"] })
    expect(events.on_event.mock.calls).toEqual([[context, { type: "seen", item_ids: ["a"] }]])
  })

  it("lets a lens open an item or ask for less like it only at the pace of clicks", async () => {
    const { events, lenses } = make_lenses()
    const context = await lenses.open("view:feed", "feed", "<p>lens</p>")
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000)
    for (let index = 0; index < 5; index++) lens_event(context.view.webContents, { type: "open", item_id: `i${index}` })
    for (let index = 0; index < 30; index++) lens_event(context.view.webContents, { type: "less_like_this", item_id: `i${index}` })
    now.mockReturnValue(10_600)
    lens_event(context.view.webContents, { type: "less_like_this", item_id: "i0" })
    lens_event(context.view.webContents, { type: "less_like_this", item_id: "i2" })
    expect(events.on_event.mock.calls.map((call) => `${call[1].type} ${call[1].item_id}`)).toEqual(["open i0", "less_like_this i0", "less_like_this i2"])
    now.mockReturnValue(10_900)
    lens_event(context.view.webContents, { type: "open", item_id: "i9" })
    expect(events.on_event).toHaveBeenCalledTimes(4)
  })

  it("closes a lens and forgets it", async () => {
    const { host, lenses } = make_lenses()
    const context = await lenses.open("view:feed", "feed", "<p>lens</p>")
    lenses.close("view:feed")
    lenses.close("view:unknown")
    expect(host.detached).toEqual([context.view])
    expect(context.view.webContents.isDestroyed()).toBe(true)
    expect(lenses.get("view:feed")).toBeUndefined()
  })
})

describe("LensContext", () => {
  it("tracks what it rendered and lets the lens load only those items' images", () => {
    configure_sessions()
    const lens = session.fromPartition(LENS_PARTITION)
    const view = new FakeWebContentsView()
    const context = new LensContext("view:feed", "feed", view as never)
    context.send({ type: "render", items: [view_item("a", "https://i/a.jpg")], cursor: null })
    context.send({ type: "append", items: [view_item("b")], cursor: "more" })
    expect([...context.rendered.keys()]).toEqual(["a", "b"])
    expect(view.webContents.messages("moi:lens")).toHaveLength(2)
    context.send({ type: "render", items: [view_item("c")], cursor: null })
    expect([...context.rendered.keys()]).toEqual(["c"])
    expect(cancelled(lens, "https://i/a.jpg", view.webContents.id)).toBe(false)
    expect(cancelled(lens, "https://i/a.jpg?d=items", view.webContents.id)).toBe(true)
  })

  it("runs page fetches one at a time and a failed one does not stop the next", async () => {
    const context = new LensContext("view:feed", "feed", new FakeWebContentsView() as never)
    const order: string[] = []
    const first = context.serial(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push("first")
      throw new Error("brain hiccup")
    })
    const second = context.serial(async () => {
      order.push("second")
      return 2
    })
    await expect(first).rejects.toThrow("brain hiccup")
    expect(await second).toBe(2)
    expect(order).toEqual(["first", "second"])
  })
})

describe("TabManager", () => {
  function make_tabs() {
    const host = new FakeHost()
    const hooks = { changed: vi.fn(), opened: vi.fn(), navigated: vi.fn() }
    return { host, hooks, tabs: new TabManager(host, hooks) }
  }

  it("opens tabs in your web session at the address you typed", () => {
    const { host, tabs } = make_tabs()
    const tab = tabs.open("example.com/path")
    const [view] = FakeWebContentsView.created
    expect(tab.tab_id).toBe(1)
    expect(view.options.webPreferences).toMatchObject({ partition: "persist:web", backgroundThrottling: true })
    expect(host.attached).toEqual([view])
    expect(view.webContents.loads).toEqual(["https://example.com/path"])
    view.webContents.title = "Example"
    expect(tabs.infos()).toEqual([{ tab_id: 1, title: "Example", url: "https://example.com/path", mine: false }])
  })

  it("turns web links that open windows into tabs and ignores other kinds", () => {
    const { hooks, tabs } = make_tabs()
    tabs.open("https://news.example.com")
    const [view] = FakeWebContentsView.created
    expect(view.webContents.open_handler?.({ url: "https://story.example.com/1" })).toEqual({ action: "deny" })
    expect(hooks.opened).toHaveBeenCalledWith(expect.objectContaining({ tab_id: 2 }))
    for (const url of ["file:///etc/passwd", "data:text/html,<script>x</script>", "javascript:alert(1)"]) {
      expect(view.webContents.open_handler?.({ url })).toEqual({ action: "deny" })
    }
    expect(tabs.all()).toHaveLength(2)
  })

  it("reports title, in page and full navigations and survives a failed load", async () => {
    const { hooks, tabs } = make_tabs()
    const tab = tabs.open("https://a.example")
    tab.view.webContents.emit("page-title-updated")
    tab.view.webContents.emit("did-navigate-in-page")
    tab.view.webContents.emit("did-navigate")
    expect(hooks.changed).toHaveBeenCalledTimes(2)
    expect(hooks.navigated).toHaveBeenCalledWith(tab)
    ;(tab.view.webContents as unknown as { load_error: Error }).load_error = Object.assign(new Error("ERR_ABORTED"), { code: "ERR_ABORTED" })
    tabs.navigate(tab, "https://b.example")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tabs.get(tab.tab_id)).toBe(tab)
  })

  it("closes a tab and forgets it", () => {
    const { host, tabs } = make_tabs()
    const tab = tabs.open("https://a.example")
    tabs.close(tab.tab_id)
    tabs.close(42)
    expect(host.detached).toEqual([tab.view])
    expect(tabs.get(tab.tab_id)).toBeUndefined()
    expect(tab.view.webContents.isDestroyed()).toBe(true)
  })
})
