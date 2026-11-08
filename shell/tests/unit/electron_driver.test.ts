import { beforeEach, describe, expect, it, vi } from "vitest"
import { FakeSession, FakeWebContents, FakeWebContentsView, ipc_event, ipcMain, reset_electron } from "./fake_electron"
import type { ViewHost } from "../../src/main/host"

vi.mock("electron", async () => await import("./fake_electron"))

const { ElectronDriver } = await import("../../src/main/drivers")
const { call_page } = await import("../../src/main/page_rpc")
const { allow_lens_images, blocked_lens_requests, configure_sessions, forget_lens, lens_preferences, web_preferences, LENS_PARTITION, WEB_PARTITION } = await import("../../src/main/sessions")
const { session } = await import("./fake_electron")

function make_host(): ViewHost & { behind: unknown[]; detached: unknown[] } {
  const behind: unknown[] = []
  const detached: unknown[] = []
  return {
    page_preload: "/dist/preload_page.js",
    lens_preload: "/dist/preload_lens.js",
    attach: vi.fn(),
    attach_behind: (view) => behind.push(view),
    detach: (view) => detached.push(view),
    behind,
    detached,
  }
}

// Plays a page preload: answers every page request with result(op, args), or an error.
function answer_requests(contents: FakeWebContents, result: (op: string, args: Record<string, unknown>) => unknown): void {
  contents.on_send = (channel, message) => {
    if (channel !== "moi:page_request") return
    const request = message as { request_id: number; op: string; args: Record<string, unknown> }
    queueMicrotask(() => {
      try {
        ipcMain.emit("moi:page_response", ipc_event(contents), { request_id: request.request_id, result: result(request.op, request.args) })
      } catch (error) {
        ipcMain.emit("moi:page_response", ipc_event(contents), { request_id: request.request_id, error: String(error) })
      }
    })
  }
}

describe("ElectronDriver", () => {
  beforeEach(() => {
    FakeWebContentsView.created = []
  })

  it("opens a muted hidden view behind the lens, runs page operations and cleans up on close", async () => {
    const host = make_host()
    const driver = new ElectronDriver(host)
    const handle = await driver.open("https://x.com/home", true)
    const [view] = FakeWebContentsView.created
    expect(handle).toBe("view:1")
    expect(view.webContents.muted).toBe(true)
    expect(view.webContents.open_handler?.({ url: "https://evil.example" })).toEqual({ action: "deny" })
    expect(view.options.webPreferences).toMatchObject({ partition: "persist:web", backgroundThrottling: false })
    expect(host.behind).toEqual([view])
    answer_requests(view.webContents, (op, args) => ({ op, args }))
    expect(await driver.run(handle, "extract", { spec: 1 })).toEqual({ op: "extract", args: { spec: 1 } })
    expect(await driver.url(handle)).toBe("https://x.com/home")
    await driver.close(handle)
    expect(host.detached).toEqual([view])
    expect(view.webContents.isDestroyed()).toBe(true)
    await expect(driver.run(handle, "extract")).rejects.toThrow("page view:1 is gone")
    await driver.close(handle)
  })

  it("adopts a tab's page without closing it and refuses pages that were destroyed", async () => {
    const driver = new ElectronDriver(make_host())
    const contents = new FakeWebContents()
    const handle = driver.adopt(contents as never)
    expect(handle).toBe(`contents:${contents.id}`)
    await driver.close(handle)
    expect(contents.isDestroyed()).toBe(false)
    const gone = new FakeWebContents()
    const gone_handle = driver.adopt(gone as never)
    gone.close()
    await expect(driver.url(gone_handle)).rejects.toThrow("is gone")
  })
})

describe("call_page", () => {
  it("turns page errors and silence into rejections", async () => {
    const contents = new FakeWebContents()
    answer_requests(contents, () => {
      throw new Error("no such element")
    })
    await expect(call_page(contents as never, "extract")).rejects.toThrow("no such element")
    const silent = new FakeWebContents()
    await expect(call_page(silent as never, "scroll", {}, 20)).rejects.toThrow("page scroll timed out")
  })
})

// Asks the lens session whether a lens web contents may load url, recording whether it was cancelled.
function ask_lens(lens: FakeSession, decisions: boolean[], url: string, resourceType: string, webContentsId: number): void {
  lens.request_handler?.({ url, resourceType, webContentsId } as never, (response) => decisions.push(response.cancel))
}

describe("sessions", () => {
  beforeEach(() => reset_electron())

  it("drops Electron from the user agent, allows only fullscreen on the web and nothing in lenses", () => {
    configure_sessions()
    const web = session.fromPartition(WEB_PARTITION)
    expect(web.getUserAgent()).toBe("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
    const answers: boolean[] = []
    web.permission_handler?.(null, "fullscreen", (allowed) => answers.push(allowed))
    web.permission_handler?.(null, "geolocation", (allowed) => answers.push(allowed))
    const lens = session.fromPartition(LENS_PARTITION)
    lens.permission_handler?.(null, "fullscreen", (allowed) => answers.push(allowed))
    expect(answers).toEqual([true, false, false])
    const decisions: boolean[] = []
    const image = "https://pbs.twimg.com/media/a.jpg"
    allow_lens_images(7, [image])
    ask_lens(lens, decisions, image, "image", 7)
    ask_lens(lens, decisions, image, "image", 8)
    ask_lens(lens, decisions, "https://collector.example/p.gif?d=items", "image", 7)
    ask_lens(lens, decisions, "https://evil.example/steal?data=1", "xhr", 7)
    expect(decisions).toEqual([false, true, true, true])
    expect(blocked_lens_requests(7)).toEqual(["https://collector.example/p.gif?d=items", "https://evil.example/steal?data=1"])
    forget_lens(7)
    expect(blocked_lens_requests(7)).toEqual([])
    ask_lens(lens, decisions, image, "image", 7)
    expect(decisions.at(-1)).toBe(true)
  })

  it("keeps lenses and pages sandboxed and isolated", () => {
    expect(lens_preferences("/p.js")).toEqual({ partition: "lens", preload: "/p.js", sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(web_preferences("/p.js", false)).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true })
  })
})

describe("RelayDriver", () => {
  it("sends every page operation to your Chrome through the brain", async () => {
    const { RelayDriver } = await import("../../src/main/drivers")
    const relay_call = vi.fn(async (op: string) => (op === "open" ? { handle: "512" } : op === "url" ? "https://x.com/home" : null))
    const driver = new RelayDriver({ relay_call } as never)
    expect(await driver.open("https://x.com/home", true)).toBe("512")
    expect(await driver.url("512")).toBe("https://x.com/home")
    await driver.close("512")
    expect(relay_call.mock.calls).toEqual([
      ["open", { url: "https://x.com/home", background: true }],
      ["url", { handle: "512" }],
      ["close", { handle: "512" }],
    ])
  })
})

describe("ElectronDriver loads", () => {
  it("keeps a page whose load was cut short by a redirect and closes one that failed", async () => {
    const host = make_host()
    const driver = new ElectronDriver(host)
    FakeWebContentsView.created = []
    const opening = driver.open("https://x.com/home", true)
    const [view] = FakeWebContentsView.created
    view.webContents.load_error = Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED" })
    expect(await opening.catch((error: Error) => error.message)).toMatch(/^view:/)
    const failing = driver.open("https://offline.example", true)
    const second = FakeWebContentsView.created[1]
    second.webContents.load_error = Object.assign(new Error("ERR_NAME_NOT_RESOLVED"), { code: "ERR_NAME_NOT_RESOLVED" })
    await expect(failing).rejects.toThrow("ERR_NAME_NOT_RESOLVED")
    expect(host.detached).toEqual([second])
    expect(second.webContents.isDestroyed()).toBe(true)
  })
})
