import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// One fake Electron for every fresh import of main.ts and the preloads, so the test sees what they did.
const fake = await vi.hoisted(async () => await import("./fake_electron"))
const { app, contextBridge, error_boxes, exposed, ipcRenderer, reset_electron } = fake

vi.mock("electron", () => fake)

const started = { sessions: 0, shells: [] as Array<{ dist: string; headless: boolean }>, stops: 0, fail: null as Error | null }

class FakeShell {
  constructor(_brain: unknown, dist: string, headless: boolean) {
    started.shells.push({ dist, headless })
  }

  async start(): Promise<void> {}
}

const brain_process = { client: { base_url: "http://127.0.0.1:1" }, stop: () => (started.stops += 1) }

vi.mock("../../src/main/sessions", () => ({ configure_sessions: () => (started.sessions += 1) }))
vi.mock("../../src/main/shell", () => ({ Shell: FakeShell }))
vi.mock("../../src/main/brain", () => ({
  BrainProcess: {
    start: async (repo_dir: string) => {
      if (started.fail) throw started.fail
      expect(repo_dir.endsWith("openMoi") || repo_dir.length > 0).toBe(true)
      return brain_process
    },
  },
}))

async function launch(): Promise<void> {
  vi.resetModules()
  await import("../../src/main/main")
  app.make_ready()
  await new Promise((resolve) => setTimeout(resolve, 5))
}

beforeEach(() => {
  reset_electron()
  app.removeAllListeners()
  app.quits = 0
  started.sessions = 0
  started.shells = []
  started.stops = 0
  started.fail = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("main", () => {
  it("configures sessions, starts the brain and the window and stops the brain on quit", async () => {
    process.env.MOI_HEADLESS = "1"
    await launch()
    expect(started.sessions).toBe(1)
    expect(started.shells).toHaveLength(1)
    expect(started.shells[0].headless).toBe(true)
    app.emit("window-all-closed")
    expect(app.quits).toBe(1)
    app.emit("before-quit")
    expect(started.stops).toBe(1)
  })

  it("shows why it could not start, stops what started and quits", async () => {
    started.fail = new Error("the brain could not be started with uv (spawn uv ENOENT); install uv, see the README")
    vi.spyOn(console, "error").mockImplementation(ignore)
    await launch()
    expect(error_boxes).toEqual([["openMoi could not start", started.fail.message]])
    expect(app.quits).toBe(1)
  })
})

function ignore(): void {}

describe("preloads", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("gives the chrome UI commands, state and state updates, nothing else", async () => {
    await import("../../src/preload/chrome")
    const bridge = exposed.shell as { command(command: unknown): void; get_state(): Promise<unknown>; on_state(listener: (state: unknown) => void): void }
    bridge.command({ type: "refresh" })
    expect(ipcRenderer.sent).toEqual([["moi:command", { type: "refresh" }]])
    ipcRenderer.invoke_result = { views: [] }
    expect(await bridge.get_state()).toEqual({ views: [] })
    expect(ipcRenderer.invoked).toEqual(["moi:get_state"])
    const states: unknown[] = []
    bridge.on_state((state) => states.push(state))
    ipcRenderer.emit("moi:state", {}, { views: ["feed"] })
    expect(states).toEqual([{ views: ["feed"] }])
    expect(Object.keys(exposed)).toEqual(["shell"])
  })

  it("gives a lens the moi helper and coerces what it sends", async () => {
    await import("../../src/preload/lens")
    const moi = exposed.moi as Record<string, (...args: unknown[]) => unknown>
    const rendered: unknown[] = []
    const appended: unknown[] = []
    moi.on_render((items: unknown, cursor: unknown) => rendered.push([items, cursor]))
    moi.on_append((items: unknown, cursor: unknown) => appended.push([items, cursor]))
    ipcRenderer.emit("moi:lens", {}, { type: "render", items: ["a"], cursor: null })
    ipcRenderer.emit("moi:lens", {}, { type: "append", items: ["b"], cursor: "more" })
    ipcRenderer.emit("moi:lens", {}, { type: "unknown", items: [], cursor: null })
    expect(rendered).toEqual([[["a"], null]])
    expect(appended).toEqual([[["b"], "more"]])
    moi.ready()
    moi.open(42)
    moi.more({ toString: () => "deeper" })
    moi.seen(new Set([1, "b"]))
    moi.less_like_this("c")
    expect(ipcRenderer.sent.map(([, message]) => message)).toEqual([
      { type: "ready" },
      { type: "open", item_id: "42" },
      { type: "more", cursor: "deeper" },
      { type: "seen", item_ids: ["1", "b"] },
      { type: "less_like_this", item_id: "c" },
    ])
    expect(contextBridge).toBeDefined()
  })

  it("answers page operations in openMoi's own pages, errors included", async () => {
    await import("../../src/preload/page")
    document.title = "Home / X"
    ipcRenderer.emit("moi:page_request", {}, { request_id: 1, op: "info", args: {} })
    ipcRenderer.emit("moi:page_request", {}, { request_id: 2, op: "format_disk", args: {} })
    expect(ipcRenderer.sent).toEqual([
      ["moi:page_response", { request_id: 1, result: { url: location.href, title: "Home / X" } }],
      ["moi:page_response", { request_id: 2, error: "Error: unknown page op format_disk" }],
    ])
  })
})
