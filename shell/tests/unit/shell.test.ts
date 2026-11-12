import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import type { Proposal, RelayInfo, ShellCommand, ShellState, ViewPage } from "../../src/shared/types"
import { FakeBrowserWindow, FakeNotification, FakeTray, FakeWebContentsView, app, external_urls, ipc_event, ipcMain, opened_paths, powerMonitor, reset_electron } from "./fake_electron"

vi.mock("electron", async () => await import("./fake_electron"))

// A minute lasts 20 ms in these tests, so visits end while the test waits.
process.env.MOI_MINUTE_MS = "20"
const { Shell } = await import("../../src/main/shell")

const UI_URL = pathToFileURL("/dist/ui/index.html").href
const PAGE = { view_id: "feed", items: [], has_more: false, refreshing: false, caught_up: true, summary: "Reading X.", warnings: [], version: "v1", layout_hash: "h", lens_stale: false } as unknown as ViewPage
const OFFLINE = { connected: false, waiting_for_approval: null, paired: false, extension_id: null, passive_batches: 0 }

function proposal(fields: Partial<Proposal> = {}): Proposal {
  return { proposal_id: "p1", view_id: "feed", changes: [{ file: "views/feed.md", diff: "+* No shorts." }], lens_action: null, reply: "Added a rule.", ...fields }
}

function fake_brain(fields: Record<string, unknown> = {}) {
  return {
    views: vi.fn(async () => [
      { view_id: "feed", title: "Feed" },
      { view_id: "tech", title: "Tech" },
    ]),
    relay_poll: vi.fn(async () => ({ status: OFFLINE, events: [] })),
    relay_trust: vi.fn(async () => OFFLINE),
    relay_call: vi.fn(async () => ({ handle: "9" })),
    lens: vi.fn(async () => "<p>lens</p>"),
    view_page: vi.fn(async () => PAGE),
    refresh: vi.fn(async () => ({ page_sources: [] })),
    events: vi.fn(async () => ({ recorded: 1 })),
    edit: vi.fn(async () => proposal()),
    apply_edit: vi.fn(async () => proposal()),
    discard_edit: vi.fn(async () => ({ status: "discarded" })),
    ingest: vi.fn(async () => ({ items: [], view_items: [], lens_stale: false, layout_hash: "h" })),
    schedule: vi.fn(async () => []),
    schedule_done: vi.fn(async () => ({ status: "done" })),
    watches_due: vi.fn(async () => []),
    content_wanted: vi.fn(async () => []),
    update_packs: vi.fn(async () => ({ status: "no pack channel" })),
    add_content: vi.fn(async () => ({ status: "summarized" })),
    watch_report: vi.fn(async () => ({ changed: false, alert: null })),
    agents_due: vi.fn(async () => []),
    weekly_mirror: vi.fn(async () => null),
    moment: vi.fn(async () => ({ status: "recorded" })),
    open_early: vi.fn(async () => ({ status: "open" })),
    ...fields,
  }
}

async function started(fields: Record<string, unknown> = {}) {
  const brain = fake_brain(fields)
  const shell = new Shell(brain as unknown as BrainClient, "/dist", true)
  await shell.start()
  shell.relay.stop()
  shell.scheduler.stop()
  const [window] = FakeBrowserWindow.created
  return { shell, brain, window }
}

function from_ui(window: FakeBrowserWindow) {
  return { ...ipc_event(window.webContents), senderFrame: window.webContents.mainFrame }
}

async function command(window: FakeBrowserWindow, message: ShellCommand): Promise<void> {
  ipcMain.emit("moi:command", from_ui(window), message)
  await new Promise((resolve) => setTimeout(resolve, 5))
}

function state_of(shell: InstanceType<typeof Shell>): ShellState {
  return shell.state()
}

// Private parts of the shell that the tests drive directly.
interface ShellInside {
  on_relay_changed(status: RelayInfo, previous: RelayInfo): void
  open_original(url: string): void
}

function inside(shell: InstanceType<typeof Shell>): ShellInside {
  return shell as unknown as ShellInside
}

beforeEach(() => {
  reset_electron()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Shell window", () => {
  it("loads the UI and opens the first view in a lens", async () => {
    const { shell, window } = await started()
    expect(window.webContents.loads).toEqual(["/dist/ui/index.html"])
    expect(window.options).toMatchObject({ show: false, title: "openMoi" })
    expect(shell.lenses.get("view:feed")).toBeDefined()
    expect(state_of(shell)).toMatchObject({ active: { kind: "view", view_id: "feed" }, chat_view: "Feed", address: "", thinking: false })
    expect(state_of(shell).views.map((view) => view.view_id)).toEqual(["feed", "tech"])
  })

  it("takes commands and answers state only for the UI page itself", async () => {
    const { shell, window } = await started()
    const page = { ...ipc_event(window.webContents), senderFrame: { url: UI_URL } }
    ipcMain.emit("moi:command", page, { type: "open_tab", url: "https://a.example" })
    ipcMain.emit("moi:command", ipc_event(new FakeBrowserWindow().webContents), { type: "open_tab", url: "https://a.example" })
    expect(shell.tabs.all()).toHaveLength(0)
    const get_state = ipcMain.handlers.get("moi:get_state")
    expect(get_state?.(page)).toBeNull()
    expect(get_state?.(from_ui(window))).toMatchObject({ active: { kind: "view" } })
    await command(window, { type: "open_tab", url: "https://a.example" })
    expect(shell.tabs.all()).toHaveLength(1)
  })

  it("never navigates the UI window or opens windows from it", async () => {
    const { window } = await started()
    const navigation = { preventDefault: vi.fn() }
    window.webContents.emit("will-navigate", navigation)
    expect(navigation.preventDefault).toHaveBeenCalled()
    expect(window.webContents.open_handler?.({ url: "https://a.example" })).toEqual({ action: "deny" })
  })

  it("lays every view out below the top bar and beside the side panel when the window resizes", async () => {
    const { shell, window } = await started()
    shell.open_tab("https://a.example")
    window.size = [1000, 700]
    window.emit("resize")
    for (const child of window.contentView.children) expect(child.bounds).toEqual({ x: 0, y: 48, width: 660, height: 652 })
  })

  it("pushes its state to the UI as it changes", async () => {
    const { shell, window } = await started()
    shell.notify("hello")
    const [, last] = window.webContents.sent.at(-1) ?? []
    expect((last as ShellState).notices.map((notice) => notice.text)).toEqual(["hello"])
    window.destroyed = true
    shell.notify("not sent")
    expect((window.webContents.sent.at(-1)?.[1] as ShellState).notices).toHaveLength(1)
  })
})

describe("Shell notices", () => {
  it("keeps every Undo, even for two items with the same title, and lets a tagged notice replace its own", async () => {
    const { shell } = await started()
    for (const id of ["u1", "u2"]) shell.notify("Like in 5 s: Same title", undefined, { label: "Undo", command: { type: "undo_action", request_id: id } }, `action:${id}`)
    for (let index = 0; index < 7; index++) shell.notify(`later ${index}`)
    const notices = state_of(shell).notices
    expect(notices.filter((notice) => notice.action?.label === "Undo").map((notice) => notice.tag)).toEqual(["action:u1", "action:u2"])
    expect(notices.map((notice) => notice.text).slice(2)).toEqual(["later 3", "later 4", "later 5", "later 6"])
    shell.notify("Edition at 7:00", undefined, undefined, "edition:feed")
    shell.notify("Edition at 8:00", undefined, undefined, "edition:feed")
    expect(state_of(shell).notices.filter((notice) => notice.tag === "edition:feed").map((notice) => notice.text)).toEqual(["Edition at 8:00"])
  })

  it("shows each text once, keeps the latest six and lets you dismiss or open them", async () => {
    const { shell, window } = await started()
    shell.notify("same")
    shell.notify("same")
    for (let index = 0; index < 7; index++) shell.notify(`notice ${index}`, index === 6 ? "https://sign.in/" : undefined)
    const notices = state_of(shell).notices
    expect(notices.map((notice) => notice.text)).toEqual(["notice 1", "notice 2", "notice 3", "notice 4", "notice 5", "notice 6"])
    await command(window, { type: "dismiss_notice", notice_id: notices[0].notice_id })
    expect(state_of(shell).notices).toHaveLength(5)
    await command(window, { type: "open_notice", notice_id: notices[5].notice_id })
    expect(shell.tabs.infos().map((tab) => tab.url)).toEqual(["https://sign.in/"])
    await command(window, { type: "open_link", url: "https://news.example/1" })
    await command(window, { type: "open_link", url: "file:///etc/passwd" })
    expect(shell.tabs.infos().map((tab) => tab.url)).toEqual(["https://sign.in/", "https://news.example/1"])
    expect(state_of(shell).notices.at(-1)?.text).toBe("openMoi only opens web links, not file:///etc/passwd")
  })
})

describe("Shell originals", () => {
  it("opens web links only, in an openMoi tab without Chrome and in Chrome with it", async () => {
    const { shell, brain } = await started()
    inside(shell).open_original("javascript:alert(1)")
    expect(state_of(shell).notices.at(-1)?.text).toBe("openMoi only opens web links, not javascript:alert(1)")
    inside(shell).open_original("https://a.example/story")
    expect(shell.tabs.infos().map((tab) => tab.url)).toEqual(["https://a.example/story"])
    shell.relay.status = { connected: true, waiting_for_approval: null, paired: true }
    inside(shell).open_original("https://b.example/story")
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(brain.relay_call).toHaveBeenCalledWith("open", { url: "https://b.example/story", background: false })
    brain.relay_call.mockRejectedValueOnce(new Error("Chrome is not connected"))
    inside(shell).open_original("https://c.example/story")
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(state_of(shell).notices.at(-1)?.text).toBe("Could not open it in Chrome: Chrome is not connected")
    expect(shell.tabs.infos().map((tab) => tab.url)).toEqual(["https://a.example/story", "https://c.example/story"])
  })
})

describe("Shell tabs and commands", () => {
  it("opens, selects, navigates and closes tabs, returning to the first view", async () => {
    const { shell, window } = await started()
    await command(window, { type: "navigate", url: "a.example" })
    const [tab] = shell.tabs.all()
    expect(state_of(shell).active).toEqual({ kind: "tab", tab_id: tab.tab_id })
    expect(state_of(shell).address).toBe("https://a.example")
    await command(window, { type: "navigate", url: "https://b.example" })
    expect(shell.tabs.all()).toHaveLength(1)
    await command(window, { type: "refresh" })
    expect((tab.view.webContents as unknown as { reloads: number }).reloads).toBe(1)
    await command(window, { type: "select_tab", tab_id: 99 })
    expect(state_of(shell).active).toEqual({ kind: "tab", tab_id: tab.tab_id })
    await command(window, { type: "open_view", view_id: "feed" })
    await command(window, { type: "select_tab", tab_id: tab.tab_id })
    await command(window, { type: "close_tab", tab_id: tab.tab_id })
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "feed" })
  })

  it("refreshes the view you are looking at", async () => {
    const { brain, window } = await started()
    await command(window, { type: "refresh" })
    expect(brain.refresh).toHaveBeenLastCalledWith("feed", true)
  })

  it("passes chat, proposals and approvals on", async () => {
    const { shell, brain, window } = await started()
    await command(window, { type: "chat_send", text: "no shorts" })
    expect(brain.edit).toHaveBeenCalledWith("feed", "no shorts", undefined, "any")
    await command(window, { type: "proposal_apply", proposal_id: "p1" })
    expect(brain.apply_edit).toHaveBeenCalledWith("p1")
    expect(state_of(shell).chat.find((entry) => entry.proposal)?.status).toBe("applied")
    await command(window, { type: "relay_trust", extension_id: "abcdefghijklmnopabcdefghijklmnop" })
    expect(brain.relay_trust).not.toHaveBeenCalled()
    shell.relay.status = { connected: false, waiting_for_approval: "abcdefghijklmnopabcdefghijklmnop", paired: false }
    shell.notify("A Chrome extension wants to read pages", undefined, { label: "Allow", command: { type: "relay_trust", extension_id: "abcdefghijklmnopabcdefghijklmnop" } })
    await command(window, { type: "relay_trust", extension_id: "abcdefghijklmnopabcdefghijklmnop" })
    expect(brain.relay_trust).toHaveBeenCalledWith("abcdefghijklmnopabcdefghijklmnop")
    expect(state_of(shell).notices.some((notice) => notice.action)).toBe(false)
  })

  it("opens your openMoi folder for /settings open", async () => {
    const { window } = await started({ overview: vi.fn(async () => ({ home: "/Users/me/openMoi", view_id: "feed", view_file: "views/feed.md", sections: {}, memory: {}, model: { fast: {}, smart: {}, allow_content_to_hosted: false }, relay: { connected: false } })) })
    await command(window, { type: "chat_send", text: "/settings open" })
    expect(opened_paths).toEqual(["/Users/me/openMoi"])
  })
})

describe("Shell and Chrome", () => {
  it("clears the Allow notice once Chrome connects and says when Chrome comes and goes", async () => {
    const { shell } = await started()
    shell.notify("A Chrome extension wants to read pages", undefined, { label: "Allow", command: { type: "relay_trust", extension_id: "x" } })
    inside(shell).on_relay_changed({ connected: true, waiting_for_approval: null, paired: true }, { connected: false, waiting_for_approval: null, paired: false })
    expect(state_of(shell).notices.some((notice) => notice.action)).toBe(false)
    expect(state_of(shell).chat.at(-1)?.text).toBe("Chrome is connected: openMoi now reads through your own Chrome sessions.")
    inside(shell).on_relay_changed({ connected: false, waiting_for_approval: null, paired: true }, { connected: true, waiting_for_approval: null, paired: true })
    expect(state_of(shell).chat.at(-1)?.text).toBe("Chrome disconnected: openMoi falls back to its own session until it is back.")
  })

  it("tells you to pair again when Chrome's extension knows an earlier openMoi and clears that once it asks", async () => {
    const { shell } = await started()
    inside(shell).on_relay_changed({ connected: false, waiting_for_approval: null, paired: true, unrecognized: "abc" }, { connected: false, waiting_for_approval: null, paired: true })
    expect(state_of(shell).notices.at(-1)?.text).toContain("press Pair again")
    expect(state_of(shell).notices.at(-1)?.action).toBeUndefined()
    inside(shell).on_relay_changed({ connected: false, waiting_for_approval: "abc", paired: true }, { connected: false, waiting_for_approval: null, paired: true, unrecognized: "abc" })
    expect(state_of(shell).notices.some((notice) => notice.text.includes("Pair again"))).toBe(false)
  })

  it("shows the full extension id in the approval notice", async () => {
    const { shell } = await started({
      relay_poll: vi.fn(async () => ({ status: { ...OFFLINE, waiting_for_approval: "abcdefghijklmnopabcdefghijklmnop" }, events: [] })),
    })
    await shell.relay.poll()
    expect(state_of(shell).notices.at(-1)?.text).toContain("(id abcdefghijklmnopabcdefghijklmnop)")
  })

  it("shows a Chrome page as Mine and goes back to the view when you close it", async () => {
    const mine_request = { event: "mine" as const, handle: "512", url: "https://news.example.com/", title: "News" }
    const status = { ...OFFLINE, connected: true, paired: true }
    const relay_poll = vi.fn().mockResolvedValueOnce({ status, events: [] }).mockResolvedValueOnce({ status, events: [mine_request] }).mockResolvedValue({ status, events: [] })
    const { shell, window } = await started({ relay_poll })
    vi.spyOn(shell.mine, "enable").mockResolvedValue(true)
    await shell.relay.poll()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const [page] = state_of(shell).chrome_pages
    expect(page).toMatchObject({ title: "News", url: "https://news.example.com/" })
    expect(state_of(shell).active).toEqual({ kind: "chrome", page_id: page.page_id })
    await command(window, { type: "open_view", view_id: "feed" })
    await command(window, { type: "select_chrome_page", page_id: page.page_id })
    await command(window, { type: "close_chrome_page", page_id: page.page_id })
    expect(state_of(shell).chrome_pages).toEqual([])
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "feed" })
  })
})

describe("Shell Mine on tabs", () => {
  it("drops a Mine view whose tab you closed while it was being made", async () => {
    const { shell, window } = await started()
    shell.open_tab("https://shop.example.com/")
    const [tab] = shell.tabs.all()
    let finish: (enabled: boolean) => void = () => {}
    vi.spyOn(shell.mine, "enable").mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const disable = vi.spyOn(shell.mine, "disable")
    const toggling = command(window, { type: "toggle_mine" })
    await new Promise((resolve) => setTimeout(resolve, 1))
    await command(window, { type: "close_tab", tab_id: tab.tab_id })
    finish(true)
    await toggling
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(disable).toHaveBeenCalledWith(`tab:${tab.tab_id}`)
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "feed" })
  })

  it("leaves you where you went while a Mine view was being made, then marks the tab", async () => {
    const { shell, window } = await started()
    shell.open_tab("https://shop.example.com/")
    const [tab] = shell.tabs.all()
    let finish: (enabled: boolean) => void = () => {}
    vi.spyOn(shell.mine, "enable").mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const toggling = command(window, { type: "toggle_mine" })
    await new Promise((resolve) => setTimeout(resolve, 1))
    await command(window, { type: "open_view", view_id: "feed" })
    finish(true)
    await toggling
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(tab.mine).toBe(true)
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "feed" })
    expect(FakeWebContentsView.created.length).toBeGreaterThan(1)
  })
})

function item(item_id: string, title: string) {
  return { item: { item_id, title, url: `https://a.example/${item_id}`, source_id: "x", kind: "post" }, reasons: [] }
}

async function lens_says(contents: unknown, message: unknown): Promise<void> {
  const type = (message as { type?: string }).type
  if (type === "open" || type === "less_like_this") (contents as { press(): void }).press()
  ipcMain.emit("moi:lens_event", ipc_event(contents as never), message)
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("Shell flows through the lens", () => {
  it("renders a view when its lens is ready, opens items and turns less like this into a chat request", async () => {
    const page = { ...PAGE, items: [item("i1", "Election night"), item("i2", "Sourdough")] }
    const { shell, brain } = await started({ view_page: vi.fn(async () => page) })
    const lens = shell.lenses.get("view:feed")
    await lens_says(lens?.view.webContents, { type: "ready" })
    const renders = (lens?.view.webContents as unknown as { messages(channel: string): Array<{ type: string }> }).messages("moi:lens")
    expect(renders[0]).toMatchObject({ type: "render" })
    await lens_says(lens?.view.webContents, { type: "open", item_id: "i1" })
    expect(brain.events).toHaveBeenCalledWith([{ view_id: "feed", item_id: "i1", event_kind: "open" }])
    expect(shell.tabs.infos().map((tab) => tab.url)).toEqual(["https://a.example/i1"])
    await lens_says(lens?.view.webContents, { type: "less_like_this", item_id: "i2" })
    expect(brain.edit).toHaveBeenCalledWith("feed", "Less like this: Sourdough", "i2", "any")
  })

  it("asks for a new look when the brain says the lens is stale", async () => {
    const { shell } = await started({ view_page: vi.fn(async () => ({ ...PAGE, lens_stale: true, layout_hash: "h2" })) })
    const ensure = vi.spyOn(shell.lens_gen, "ensure").mockResolvedValue()
    await lens_says(shell.lenses.get("view:feed")?.view.webContents, { type: "ready" })
    expect(ensure).toHaveBeenCalledWith("feed", "feed", "h2")
  })
})

describe("Shell after edits", () => {
  it("opens a view an applied edit created", async () => {
    const views = vi
      .fn()
      .mockResolvedValueOnce([{ view_id: "feed", title: "Feed" }])
      .mockResolvedValue([
        { view_id: "feed", title: "Feed" },
        { view_id: "science", title: "Science" },
      ])
    const { shell, window } = await started({ views, edit: vi.fn(async () => proposal({ view_id: "science" })), apply_edit: vi.fn(async () => proposal({ view_id: "science" })) })
    await command(window, { type: "chat_send", text: "/newview science space and physics" })
    await command(window, { type: "proposal_apply", proposal_id: "p1" })
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "science" })
  })

  it("reloads the look on a rollback and re-renders on other edits", async () => {
    const { shell, brain, window } = await started({ apply_edit: vi.fn(async () => proposal({ lens_action: "rollback" })) })
    const reload = vi.spyOn(shell.views, "reload_lens")
    await command(window, { type: "chat_send", text: "bring back the previous look" })
    await command(window, { type: "proposal_apply", proposal_id: "p1" })
    expect(reload).toHaveBeenCalledWith("feed")
    brain.apply_edit.mockResolvedValue(proposal({ proposal_id: "p2" }))
    brain.edit.mockResolvedValue(proposal({ proposal_id: "p2" }))
    const after_edit = vi.spyOn(shell.views, "after_edit").mockResolvedValue()
    await command(window, { type: "chat_send", text: "no shorts" })
    await command(window, { type: "proposal_apply", proposal_id: "p2" })
    expect(after_edit).toHaveBeenCalledWith("feed")
  })

  it("makes an empty view a tab right away and rechecks after a model change", async () => {
    const views = vi
      .fn()
      .mockResolvedValueOnce([{ view_id: "feed", title: "Feed" }])
      .mockResolvedValue([
        { view_id: "feed", title: "Feed" },
        { view_id: "tech", title: "Tech" },
      ])
    const info = { fast: { provider: "ollama", model: "llama3", base_url: "", local: true, key_ready: true }, smart: { provider: "ollama", model: "llama3", base_url: "", local: true, key_ready: true }, allow_content_to_hosted: true }
    const { shell, window } = await started({ views, create_view: vi.fn(async () => ({ view_id: "tech", title: "Tech" })), update_model: vi.fn(async () => info) })
    await command(window, { type: "chat_send", text: "/newview Tech" })
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "tech" })
    const recheck = vi.spyOn(shell.views, "recheck").mockResolvedValue()
    await command(window, { type: "chat_send", text: "/model privacy on" })
    expect(recheck).toHaveBeenCalledWith("tech")
  })
})

describe("Shell Mine toggling", () => {
  it("turns Mine off again and drops it when the page navigates underneath", async () => {
    const { shell, window } = await started()
    shell.open_tab("https://shop.example.com/")
    const [tab] = shell.tabs.all()
    vi.spyOn(shell.mine, "enable").mockResolvedValue(true)
    const disable = vi.spyOn(shell.mine, "disable")
    await command(window, { type: "toggle_mine" })
    expect(tab.mine).toBe(true)
    await command(window, { type: "toggle_mine" })
    expect(tab.mine).toBe(false)
    await command(window, { type: "toggle_mine" })
    tab.view.webContents.emit("did-navigate")
    expect(tab.mine).toBe(false)
    expect(disable).toHaveBeenCalledTimes(2)
  })
})

describe("Shell guards", () => {
  it("drops a Mine view when you went to another page while it was being made", async () => {
    const { shell, window } = await started()
    shell.open_tab("https://shop.example.com/")
    const [tab] = shell.tabs.all()
    let finish: (enabled: boolean) => void = () => {}
    vi.spyOn(shell.mine, "enable").mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const disable = vi.spyOn(shell.mine, "disable")
    const toggling = command(window, { type: "toggle_mine" })
    await new Promise((resolve) => setTimeout(resolve, 1))
    ;(tab.view.webContents as unknown as { url: string }).url = "https://shop.example.com/other"
    finish(true)
    await toggling
    expect(tab.mine).toBe(false)
    expect(disable).toHaveBeenCalledWith(`tab:${tab.tab_id}`)
  })

  it("ignores a frame inside the UI and the UI window once it shows another page", async () => {
    const { shell, window } = await started()
    ipcMain.emit("moi:command", { ...ipc_event(window.webContents), senderFrame: { name: "an iframe" } }, { type: "open_tab", url: "https://a.example" })
    window.webContents.url = "https://dropped.example/"
    ipcMain.emit("moi:command", from_ui(window), { type: "open_tab", url: "https://a.example" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(shell.tabs.all()).toHaveLength(0)
  })
})


const SEVEN = "2026-11-10T07:00:00Z"
const SIX_PM = "2026-11-10T18:00:00Z"

function view_schedule(fields: Record<string, unknown> = {}) {
  return { view_id: "feed", title: "Feed", edition: null, next_edition: null, read_for: null, visit_minutes: null, ...fields }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function close_window(window: FakeBrowserWindow): { prevented: boolean } {
  const event = { prevented: false, preventDefault(): void {} }
  event.preventDefault = () => {
    event.prevented = true
  }
  window.emit("close", event)
  return event
}

describe("Shell visits", () => {
  it("asks why you are here when a view has a visit length, then opens what you chose", async () => {
    const { shell, window, brain } = await started({ schedule: vi.fn(async () => [view_schedule({ visit_minutes: 5, next_edition: SIX_PM })]) })
    expect(state_of(shell).gate).toEqual([
      { view_id: "feed", title: "Feed", visit_minutes: 5, next_edition: SIX_PM },
      { view_id: "tech", title: "Tech", visit_minutes: null, next_edition: null },
    ])
    expect(brain.lens).not.toHaveBeenCalled()
    await command(window, { type: "choose_view", view_id: "tech" })
    expect(state_of(shell).gate).toBeNull()
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "tech" })
  })

  it("opens the first view directly when no view has a visit length", async () => {
    const { shell } = await started({ schedule: vi.fn(async () => [view_schedule({ next_edition: SIX_PM })]) })
    expect(state_of(shell).gate).toBeNull()
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "feed" })
  })

  it("ends a visit with what you read, then lets you take five more minutes or stop", async () => {
    const { shell, window } = await started({ schedule: vi.fn(async () => [view_schedule({ visit_minutes: 1, next_edition: SIX_PM })]) })
    vi.spyOn(shell.views, "seen_since").mockReturnValue(["First story"])
    await command(window, { type: "choose_view", view_id: "feed" })
    await wait(60)
    expect(state_of(shell).stop).toEqual({ view_id: "feed", title: "Feed", minutes: 1, read: ["First story"], next_edition: SIX_PM })
    expect(FakeWebContentsView.created.every((view) => !view.visible)).toBe(true)
    await command(window, { type: "extend_visit" })
    expect(state_of(shell).stop).toBeNull()
    await wait(40)
    expect(state_of(shell).stop).toBeNull()
    await wait(80)
    expect(state_of(shell).stop?.minutes).toBe(5)
    await command(window, { type: "end_visit" })
    expect(state_of(shell).stop).toBeNull()
    expect(state_of(shell).gate?.map((choice) => choice.view_id)).toEqual(["feed", "tech"])
    await command(window, { type: "extend_visit" })
    expect(state_of(shell).gate).not.toBeNull()
  })

  it("lets a visit end quietly when you already went elsewhere, and ends it when you switch views", async () => {
    const { shell, window } = await started({ schedule: vi.fn(async () => [view_schedule({ visit_minutes: 1 }), view_schedule({ view_id: "tech", title: "Tech", visit_minutes: 1 })]) })
    await command(window, { type: "choose_view", view_id: "feed" })
    await command(window, { type: "open_tab", url: "https://a.example/" })
    await wait(60)
    expect(state_of(shell).stop).toBeNull()
    await command(window, { type: "open_view", view_id: "feed" })
    await command(window, { type: "open_view", view_id: "tech" })
    await wait(30)
    expect(state_of(shell).stop?.view_id).toBe("tech")
  })
})

describe("Shell in the background", () => {
  it("hides instead of closing while a view has editions, and closes once you quit", async () => {
    const { shell, window } = await started({ schedule: vi.fn(async () => [view_schedule({ next_edition: SIX_PM })]) })
    window.shown = true
    expect(close_window(window).prevented).toBe(true)
    expect(window.shown).toBe(false)
    shell.quitting = true
    expect(close_window(window).prevented).toBe(false)
  })

  it("closes normally with nothing to read on schedule", async () => {
    const { window } = await started()
    expect(close_window(window).prevented).toBe(false)
  })

  it("turns background reading and starting at login on and off from the chat", async () => {
    const { shell, window } = await started()
    await command(window, { type: "chat_send", text: "/background on" })
    expect(app.login.openAtLogin).toBe(true)
    expect(state_of(shell).chat.at(-1)?.text).toContain("starts when you log in")
    expect(close_window(window).prevented).toBe(true)
    await command(window, { type: "chat_send", text: "/background off" })
    expect(app.login.openAtLogin).toBe(false)
    expect(close_window(window).prevented).toBe(false)
  })

  it("remembers background reading turned on at login", async () => {
    app.login.openAtLogin = true
    const { window } = await started()
    expect(close_window(window).prevented).toBe(true)
  })

  it("tells you about a new edition with a system notification that opens it", async () => {
    const schedules = [[view_schedule({ edition: SEVEN })], [view_schedule({ edition: SIX_PM })]]
    const { shell, window } = await started({ schedule: vi.fn(async () => (schedules.length > 1 ? schedules.shift() : schedules[0])) })
    await shell.scheduler.tick()
    const [notification] = FakeNotification.shown
    expect(notification.options.title).toBe("Feed")
    expect(notification.options.body).toMatch(/^The .+ edition is out\.$/)
    notification.emit("click")
    await wait(5)
    expect(window.shown && window.focused).toBe(true)
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "feed" })
  })

  it("skips the notification when you are looking at openMoi", async () => {
    const schedules = [[view_schedule({ edition: SEVEN })], [view_schedule({ edition: SIX_PM })]]
    const { shell, window } = await started({ schedule: vi.fn(async () => (schedules.length > 1 ? schedules.shift() : schedules[0])) })
    window.show()
    window.focus()
    await shell.scheduler.tick()
    expect(FakeNotification.shown).toHaveLength(0)
  })

  it("looks at the schedule again when the Mac wakes", async () => {
    const { brain } = await started()
    const looks = brain.schedule.mock.calls.length
    powerMonitor.emit("resume")
    await wait(5)
    expect(brain.schedule.mock.calls.length).toBe(looks + 1)
  })

  it("runs a due read in the background and marks its edition read", async () => {
    const { shell, brain } = await started({ schedule: vi.fn(async () => [view_schedule({ view_id: "tech", read_for: SIX_PM })]) })
    await shell.scheduler.idle()
    expect(brain.refresh).toHaveBeenCalledWith("tech", true)
    expect(brain.schedule_done).toHaveBeenCalledWith("tech", SIX_PM)
  })

  it("puts openMoi in the menu bar with a window that is not headless", async () => {
    const brain = fake_brain()
    const shell = new Shell(brain as unknown as BrainClient, "/dist", false, true)
    await shell.start()
    shell.relay.stop()
    shell.scheduler.stop()
    const [window] = FakeBrowserWindow.created
    expect(window.options.show).toBe(false)
    const [tray] = FakeTray.created
    expect(tray.title).toBe("moi")
    const [open, quit] = tray.menu?.items ?? []
    open.click()
    expect(window.shown).toBe(true)
    const quits = app.quits
    quit.click()
    expect(app.quits).toBe(quits + 1)
  })
})

describe("Shell mirror and early openings", () => {
  const MIRROR = { days: 7, since: SEVEN, sources: [{ source_id: "x", listed: 10, kept: 4, seen: 3, opened: 1, strangers: null, judged: {} }], views: [] }

  it("shows the weekly mirror in the chat when one is due", async () => {
    const { shell } = await started({ weekly_mirror: vi.fn(async () => MIRROR) })
    await wait(5)
    expect(state_of(shell).chat.at(-1)?.text).toBe("Your week in openMoi.\nWhat your sources showed you in the last 7 days:\n* x: 10 items, 40% passed your rules. You saw 3 and opened 1.")
  })

  it("records visits and five more minutes for the mirror", async () => {
    const { window, brain } = await started({ schedule: vi.fn(async () => [view_schedule({ visit_minutes: 1 })]) })
    await command(window, { type: "choose_view", view_id: "feed" })
    await wait(60)
    await command(window, { type: "extend_visit" })
    expect(brain.moment.mock.calls).toEqual([
      ["feed", "visit"],
      ["feed", "extended"],
    ])
  })

  it("opens an edition early from its notice and shows what came since", async () => {
    const { shell, window, brain } = await started()
    shell.notify("That is all of the 7:00 edition of feed.", undefined, { label: "Open anyway", command: { type: "open_early", view_id: "feed" } }, "edition:feed")
    const notice = state_of(shell).notices.find((entry) => entry.tag === "edition:feed")
    expect(notice?.action?.label).toBe("Open anyway")
    const renders = brain.view_page.mock.calls.length
    await command(window, notice?.action?.command as ShellCommand)
    expect(brain.open_early).toHaveBeenCalledWith("feed")
    expect(state_of(shell).notices.some((entry) => entry.tag === "edition:feed")).toBe(false)
    expect(brain.view_page.mock.calls.length).toBeGreaterThan(renders)
  })
})

describe("Shell watch alerts", () => {
  const ALERT = { view_id: "tech", title: "Visa slots changed", text: "Added: Slot available" }

  it("puts an alert in the notices and a system notification while you are elsewhere", async () => {
    const { shell, window } = await started()
    ;(shell as unknown as { alert(alert: typeof ALERT): void }).alert(ALERT)
    const notice = state_of(shell).notices.at(-1)
    expect(notice?.text).toBe("Visa slots changed: Added: Slot available")
    expect(notice?.action).toEqual({ label: "Show", command: { type: "open_view", view_id: "tech" } })
    const [notification] = FakeNotification.shown
    expect(notification.options).toEqual({ title: "Visa slots changed", body: "Added: Slot available" })
    notification.emit("click")
    await wait(5)
    expect(state_of(shell).active).toEqual({ kind: "view", view_id: "tech" })
    window.show()
    window.focus()
    ;(shell as unknown as { alert(alert: typeof ALERT): void }).alert({ ...ALERT, text: "Added: another" })
    expect(FakeNotification.shown).toHaveLength(1)
  })

  it("looks at watched pages from the scheduler without forcing past the reader's pace", async () => {
    const WATCHED = { source_id: "watch:a", start_url: "https://a.example/", purpose: "watch" }
    const { shell } = await started({ watches_due: vi.fn(async () => [WATCHED]) })
    const check = vi.spyOn(shell.views, "check_watch").mockResolvedValue()
    await shell.scheduler.tick()
    await shell.scheduler.idle()
    expect(check).toHaveBeenCalledWith(WATCHED, false)
  })
})

describe("Shell imports", () => {
  it("hands a dropped view file to the chat, with a sane name", async () => {
    const { shell, window } = await started()
    const imported = vi.spyOn(shell.chat, "import_file").mockResolvedValue()
    await command(window, { type: "import_view", name: "x".repeat(300), text: "# AI" })
    expect(imported).toHaveBeenCalledWith("x".repeat(200), "# AI")
  })
})

describe("Shell after the review", () => {
  it("ends a visit that ran out while you were in a web tab at the stop screen when you come back", async () => {
    const { shell, window } = await started({ schedule: vi.fn(async () => [view_schedule({ visit_minutes: 1 })]) })
    await command(window, { type: "choose_view", view_id: "feed" })
    await command(window, { type: "open_tab", url: "https://a.example/" })
    await wait(60)
    expect(state_of(shell).stop).toBeNull()
    await command(window, { type: "open_view", view_id: "feed" })
    expect(state_of(shell).stop?.view_id).toBe("feed")
  })

  it("shows an open view again when its edition read is done or a new edition comes out", async () => {
    const SIX = "2026-11-10T18:00:00Z"
    const answers = [[view_schedule({ edition: SEVEN })], [view_schedule({ edition: SIX })]]
    const { shell } = await started({ schedule: vi.fn(async () => (answers.length > 1 ? answers.shift() : answers[0])) })
    const after_edit = vi.spyOn(shell.views, "after_edit").mockResolvedValue()
    await shell.scheduler.tick()
    expect(after_edit).toHaveBeenCalledWith("feed")
  })
})

describe("Shell history imports", () => {
  it("hands a dropped data export to the chat", async () => {
    const { shell, window } = await started()
    const imported = vi.spyOn(shell.chat, "import_history").mockResolvedValue()
    await command(window, { type: "import_history", name: "your_events.json", text: "[]" })
    expect(imported).toHaveBeenCalledWith("your_events.json", "[]")
  })
})

describe("Shell packs", () => {
  it("says in the chat when a pack installed or was refused, and nothing otherwise", async () => {
    const { shell } = await started({ update_packs: vi.fn(async () => ({ status: "installed pack v4" })) })
    await vi.waitFor(() => expect(state_of(shell).chat.at(-1)?.text).toBe("Site packs: installed pack v4."))
    const quiet = await started({ update_packs: vi.fn(async () => ({ status: "pack v4 is current" })) })
    await wait(5)
    expect(state_of(quiet.shell).chat.some((entry) => entry.text.startsWith("Site packs"))).toBe(false)
  })
})

describe("Shell system browser", () => {
  it("opens only https addresses in your system browser", async () => {
    const { shell, window } = await started({ google_connect: vi.fn(async () => ({ auth_url: "https://accounts.google.com/x" })), google_status: vi.fn(async () => ({ connected: true, status: "connected", client: true })) })
    await command(window, { type: "chat_send", text: "/google connect" })
    await vi.waitFor(() => expect(external_urls).toEqual(["https://accounts.google.com/x"]))
    ;(shell.chat as unknown as { hooks: { open_external(url: string): void } }).hooks.open_external("javascript:alert(1)")
    expect(external_urls).toHaveLength(1)
  })
})

describe("Shell player", () => {
  it("closes the player from its bar and whenever another view or tab comes to the front", async () => {
    const { shell, window } = await started()
    const video = { item_id: "v1", url: "https://www.youtube.com/watch?v=VIDEO00001A", title: "Sky" } as never
    expect(shell.player.play(video)).toBe(true)
    expect(state_of(shell).player).toEqual({ item_id: "v1", title: "Sky", url: "https://www.youtube.com/watch?v=VIDEO00001A" })
    await command(window, { type: "close_player" })
    expect(state_of(shell).player).toBeNull()
    shell.player.play(video)
    await command(window, { type: "open_tab", url: "https://a.example/" })
    expect(state_of(shell).player).toBeNull()
  })
})

describe("Shell collections", () => {
  it("keeps one saved notice per collection, offers a tab while none reads it and makes that tab", async () => {
    const { shell, window, brain } = await started({ collection_view: vi.fn(async () => ({ view_id: "read_later", title: "Read later" })) })
    const inside = shell as unknown as { on_saved(info: unknown, saved: boolean): void }
    inside.on_saved({ name: "read_later", title: "Read later", count: 1, views: [] }, true)
    inside.on_saved({ name: "read_later", title: "Read later", count: 2, views: [] }, true)
    inside.on_saved({ name: "read_later", title: "Read later", count: 1, views: [] }, false)
    const notices = state_of(shell).notices.filter((notice) => notice.tag === "collection:read_later")
    expect(notices.map((notice) => notice.text)).toEqual(["Saved to Read later (2)."])
    expect(notices[0].action).toEqual({ label: "Make a Read later tab", command: { type: "collection_view", name: "read_later" } })
    await command(window, { type: "collection_view", name: "read_later" })
    expect((brain as unknown as { collection_view: ReturnType<typeof vi.fn> }).collection_view).toHaveBeenCalledWith("read_later")
    expect(state_of(shell).notices.filter((notice) => notice.tag === "collection:read_later")).toEqual([])
    inside.on_saved({ name: "read_later", title: "Read later", count: 3, views: ["read_later"] }, true)
    expect(state_of(shell).notices.at(-1)?.action).toBeUndefined()
  })
})

describe("Shell omnibox", () => {
  it("finds your views and items for words, nothing for addresses or a single letter, and only the latest words", async () => {
    const hit = { item: { item_id: "i1", title: "Lithium recycling", text: null, url: "https://blog.example/1", source_id: "rss:blog", published_at: "2026-11-10T09:00:00Z", fetched_at: "2026-11-10T09:00:00Z" }, score: 1 }
    const { shell, window, brain } = await started({ search: vi.fn(async () => [hit]) })
    const inside = shell as unknown as { view_infos: Array<{ view_id: string; title: string }> }
    inside.view_infos = [{ view_id: "feed", title: "Feed" }, { view_id: "lithium", title: "Lithium watch" }]
    await command(window, { type: "omnibox", text: "lithium" })
    expect(state_of(shell).omnibox).toEqual({
      query: "lithium",
      hits: [
        { label: "Lithium watch", detail: "your view", target: { kind: "view", view_id: "lithium" } },
        { label: "Lithium recycling", detail: "rss:blog · 2026-11-10", target: { kind: "link", url: "https://blog.example/1" } },
      ],
    })
    for (const text of ["l", "example.com", "https://a.example/x", ""]) {
      await command(window, { type: "omnibox", text })
      expect(state_of(shell).omnibox).toBeNull()
    }
    const searches = (brain as unknown as { search: ReturnType<typeof vi.fn> }).search
    let finish: (value: unknown) => void = () => {}
    searches.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const slow = command(window, { type: "omnibox", text: "slow words" })
    await command(window, { type: "omnibox", text: "lithium" })
    finish([])
    await slow
    expect(state_of(shell).omnibox?.query).toBe("lithium")
    await command(window, { type: "navigate", url: "lithium" })
    expect(state_of(shell).omnibox).toBeNull()
  })
})

describe("Shell shopping", () => {
  it("opens the view it shops in, made or not, and reads its stores", async () => {
    const { shell } = await started()
    const inside = shell as unknown as { on_shopping(view_id: string, created: boolean): Promise<void>; on_view_created(view_id: string): Promise<void> }
    const opened = vi.spyOn(shell, "open_view").mockResolvedValue()
    const created = vi.spyOn(inside, "on_view_created").mockResolvedValue()
    const refreshed = vi.spyOn(shell.views, "refresh").mockResolvedValue()
    await inside.on_shopping("feed", false)
    expect(opened).toHaveBeenCalledWith("feed")
    expect(refreshed).toHaveBeenCalledWith(shell.lenses.get("view:feed"), true)
    await inside.on_shopping("shop", true)
    expect(created).toHaveBeenCalledWith("shop")
  })
})

describe("Shell actions", () => {
  it("hands confirm, cancel and undo to the action controller and shows what waits on the sheet", async () => {
    const { shell, window } = await started()
    const confirm = vi.spyOn(shell.actions, "confirm").mockResolvedValue()
    const decline = vi.spyOn(shell.actions, "decline").mockResolvedValue()
    const undo = vi.spyOn(shell.actions, "undo").mockResolvedValue()
    await command(window, { type: "confirm_action", request_id: "r1" })
    await command(window, { type: "decline_action", request_id: "r2" })
    await command(window, { type: "undo_action", request_id: "r3" })
    expect([confirm.mock.calls, decline.mock.calls, undo.mock.calls]).toEqual([[["r1"]], [["r2"]], [["r3"]]])
    shell.actions.pending = { request_id: "r9" } as never
    expect(state_of(shell).confirm).toEqual({ request_id: "r9" })
  })
})

describe("Shell omnibox after Enter", () => {
  it("does not bring back results for words you already went to", async () => {
    let finish: (value: unknown) => void = () => {}
    const { shell, window } = await started({ search: vi.fn(() => new Promise((resolve) => (finish = resolve))) })
    const pending = command(window, { type: "omnibox", text: "lithium" })
    await command(window, { type: "navigate", url: "lithium" })
    finish([{ item: { item_id: "i", title: "Lithium", text: null, url: "https://a.example/1", source_id: "rss:a", published_at: null, fetched_at: "2026-11-10T00:00:00Z" }, score: 1 }])
    await pending
    expect(state_of(shell).omnibox).toBeNull()
  })
})
