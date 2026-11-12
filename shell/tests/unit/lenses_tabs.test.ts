import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ViewHost } from "../../src/main/host"
import type { ViewItem } from "../../src/shared/types"
import { FakeSession, FakeWebContents, FakeWebContentsView, ipc_event, ipcMain, reset_electron, session } from "./fake_electron"

vi.mock("electron", async () => await import("./fake_electron"))

const { GESTURE_WINDOW_MS, LensManager, LensContext } = await import("../../src/main/lenses")
const { TabManager } = await import("../../src/main/tabs")
const { configure_sessions, LENS_PARTITION } = await import("../../src/main/sessions")
const { configure_media } = await import("../../src/main/media")

class FakeHost implements ViewHost {
  readonly page_preload = "/dist/preload_page.js"
  readonly lens_preload = "/dist/preload_lens.js"
  readonly lens_tokens = ":root { --text: #111 }"
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

// A real click on a lens, as the main process sees input.
function press(contents: unknown): void {
  ;(contents as { press(): void }).press()
}

// Lets the host's async checks (the control under a click) finish.
async function flush(): Promise<void> {
  for (let round = 0; round < 5; round++) await Promise.resolve()
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

  it("lets a lens open an item or ask for less like it only within a second of a real click on it", async () => {
    const { events, lenses } = make_lenses()
    const context = await lenses.open("view:feed", "feed", "<p>lens</p>")
    const other = await lenses.open("view:other", "other", "<p>other</p>")
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000)
    lens_event(context.view.webContents, { type: "open", item_id: "unclicked" })
    press(other.view.webContents)
    lens_event(context.view.webContents, { type: "open", item_id: "clicked_elsewhere" })
    context.view.webContents.emit("input-event", {}, { type: "mouseMove" })
    lens_event(context.view.webContents, { type: "less_like_this", item_id: "hovered" })
    press(context.view.webContents)
    now.mockReturnValue(5_000 + GESTURE_WINDOW_MS + 1)
    lens_event(context.view.webContents, { type: "open", item_id: "too_late" })
    lens_event(context.view.webContents, { type: "seen", item_ids: ["a"] })
    expect(events.on_event.mock.calls.map((call) => call[1].type)).toEqual(["seen"])
  })

  it("lets a lens open an item or ask for less like it only at the pace of clicks", async () => {
    const { events, lenses } = make_lenses()
    const context = await lenses.open("view:feed", "feed", "<p>lens</p>")
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000)
    press(context.view.webContents)
    for (let index = 0; index < 5; index++) lens_event(context.view.webContents, { type: "open", item_id: `i${index}` })
    for (let index = 0; index < 30; index++) lens_event(context.view.webContents, { type: "less_like_this", item_id: `i${index}` })
    now.mockReturnValue(10_600)
    press(context.view.webContents)
    lens_event(context.view.webContents, { type: "less_like_this", item_id: "i0" })
    lens_event(context.view.webContents, { type: "less_like_this", item_id: "i2" })
    expect(events.on_event.mock.calls.map((call) => `${call[1].type} ${call[1].item_id}`)).toEqual(["open i0", "less_like_this i0", "less_like_this i2"])
    now.mockReturnValue(10_900)
    press(context.view.webContents)
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
  it("tracks what it rendered and hands the lens its images only as media tokens it may load", async () => {
    configure_sessions()
    const lens = session.fromPartition(LENS_PARTITION)
    const view = new FakeWebContentsView()
    const context = new LensContext("view:feed", "feed", view as never)
    configure_media((url, init) => session.fromPartition("media").fetch(url, init), async () => ["93.184.216.34"])
    session.fromPartition("media").fetch_answer = () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/jpeg" } })
    context.send({ type: "render", items: [view_item("a", "https://i.example/a.jpg")], cursor: null })
    context.send({ type: "append", items: [view_item("b")], cursor: "more" })
    expect([...context.rendered.keys()]).toEqual(["a", "b"])
    expect(context.rendered.get("a")?.image_url).toBe("https://i.example/a.jpg")
    const [first] = view.webContents.messages("moi:lens") as Array<{ items: ViewItem[] }>
    const token = first.items[0].item.image_url ?? ""
    expect(token).toMatch(/^moi-media:\/\/m\/[0-9a-f]{32}$/)
    expect(cancelled(lens, token, view.webContents.id)).toBe(false)
    expect(cancelled(lens, "https://i.example/a.jpg", view.webContents.id)).toBe(true)
    const served = await lens.protocols.get("moi-media")?.(new Request(token))
    expect(served?.status).toBe(200)
    await lens.protocols.get("moi-media")?.(new Request(token))
    const fetched = session.fromPartition("media").fetched
    expect(fetched.map(([url]) => url)).toEqual(["https://i.example/a.jpg"])
    expect(fetched[0][1]).toMatchObject({ credentials: "omit", redirect: "manual" })
    context.send({ type: "render", items: [view_item("c")], cursor: null })
    expect([...context.rendered.keys()]).toEqual(["c"])
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

describe("LensManager pacing for actions", () => {
  it("lets two different items be acted on in a row but not the same item twice in a moment", async () => {
    const host = { page_preload: "/p.js", lens_preload: "/l.js", lens_tokens: "", attach: vi.fn(), attach_behind: vi.fn(), detach: vi.fn() }
    const events = { on_ready: vi.fn(), on_event: vi.fn() }
    const lenses = new LensManager(host as never, events)
    const context = await lenses.open("view:feed", "feed", "<p>lens</p>")
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000)
    const contents = context.view.webContents as unknown as FakeWebContents
    for (const [item_id, action, at] of [["a", "reply", 20_000], ["b", "add_to_cart", 20_200], ["b", "add_to_cart", 20_400], ["b", "like", 20_600], ["c", "save", 20_610]] as const) {
      now.mockReturnValue(at)
      contents.isolated_answer = { action, item_id }
      press(contents)
      lens_event(contents, at === 20_610 ? { type: "save", item_id, collection: "read_later" } : { type: "act", item_id, action, text: "" })
      await flush()
    }
    expect(events.on_event.mock.calls.map((call) => `${call[1].type} ${call[1].item_id} ${call[1].action ?? ""}`.trim())).toEqual(["act a reply", "act b add_to_cart", "act b like", "save c"])
  })
})

describe("LensManager actions bound to their own control", () => {
  async function acting() {
    const events = { on_ready: vi.fn(), on_event: vi.fn() }
    const lenses = new LensManager(new FakeHost(), events)
    const context = await lenses.open("view:feed", "feed", "<p>lens</p>")
    const contents = context.view.webContents as unknown as FakeWebContents
    contents.isolated_answer = { action: "like", item_id: "a" }
    vi.spyOn(Date, "now").mockReturnValue(30_000)
    const acted = () => events.on_event.mock.calls.map((call) => `${call[1].action} ${call[1].item_id}`)
    return { contents, acted }
  }

  afterEach(() => vi.restoreAllMocks())

  it("counts an action only when your click landed on that item's control for it, read in the host's own world", async () => {
    const { contents, acted } = await acting()
    contents.press(40, 60)
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    await flush()
    expect(acted()).toEqual(["like a"])
    expect(contents.isolated).toHaveLength(1)
    expect(contents.isolated[0].world).not.toBe(0)
    expect(contents.isolated[0].code).toContain("document.elementFromPoint(40, 60)")
    expect(contents.isolated[0].code).toContain('closest("[data-action]")')
    for (const answer of [{ action: "save", item_id: "b" }, { action: "like", item_id: "b" }, { action: null, item_id: null }, null]) {
      vi.mocked(Date.now).mockReturnValue(30_000 + 1_000 * contents.isolated.length)
      contents.isolated_answer = answer
      contents.press(40, 60)
      lens_event(contents, { type: "act", item_id: "b", action: "follow", text: "" })
      await flush()
    }
    expect(acted()).toEqual(["like a"])
  })

  it("lets one click count for one action at most, its release and all", async () => {
    const { contents, acted } = await acting()
    contents.press(40, 60)
    contents.emit("input-event", {}, { type: "mouseUp", x: 40, y: 60 })
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    contents.isolated_answer = { action: "follow", item_id: "c" }
    lens_event(contents, { type: "act", item_id: "c", action: "follow", text: "" })
    await flush()
    expect(acted()).toEqual(["like a"])
    expect(contents.isolated).toHaveLength(1)
  })

  it("ignores a lens's own calls for other controls without using up your click, reading the page once", async () => {
    const { contents, acted } = await acting()
    contents.press(40, 60)
    for (let index = 0; index < 20; index++) lens_event(contents, { type: "act", item_id: `x${index}`, action: "like", text: "" })
    lens_event(contents, { type: "act", item_id: "a", action: "follow", text: "" })
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    await flush()
    expect(acted()).toEqual(["like a"])
    expect(contents.isolated).toHaveLength(1)
  })

  it("counts no action when the page cannot be read", async () => {
    const { contents, acted } = await acting()
    contents.isolated_answer = () => {
      throw new Error("frame gone")
    }
    contents.press(40, 60)
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    await flush()
    expect(acted()).toEqual([])
  })

  it("counts no action without a click, or after the click is a second old", async () => {
    const { contents, acted } = await acting()
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    contents.press(40, 60)
    vi.mocked(Date.now).mockReturnValue(30_000 + GESTURE_WINDOW_MS + 1)
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    await flush()
    expect(acted()).toEqual([])
    expect(contents.isolated).toEqual([])
  })

  it("takes Enter or Space on the focused control, one press once, and no other key", async () => {
    const { contents, acted } = await acting()
    contents.emit("input-event", {}, { type: "rawKeyDown", key: "a" })
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    await flush()
    expect(acted()).toEqual([])
    vi.mocked(Date.now).mockReturnValue(31_000)
    contents.emit("input-event", {}, { type: "rawKeyDown", key: "Enter" })
    contents.emit("input-event", {}, { type: "keyDown", key: "Enter" })
    lens_event(contents, { type: "act", item_id: "a", action: "like", text: "" })
    contents.isolated_answer = { action: "follow", item_id: "c" }
    lens_event(contents, { type: "act", item_id: "c", action: "follow", text: "" })
    await flush()
    expect(acted()).toEqual(["like a"])
    expect(contents.isolated.map((script) => script.code.includes("document.activeElement"))).toEqual([true])
  })
})
