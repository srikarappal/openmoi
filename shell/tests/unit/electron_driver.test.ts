import { beforeEach, describe, expect, it, vi } from "vitest"
import { FakeWebContents, FakeWebContentsView, ipc_event, ipcMain, reset_electron } from "./fake_electron"
import type { ViewHost } from "../../src/main/host"

vi.mock("electron", async () => await import("./fake_electron"))

const { ElectronDriver } = await import("../../src/main/drivers")
const { call_page } = await import("../../src/main/page_rpc")
const { configure_sessions, lens_preferences, web_preferences, LENS_PARTITION, WEB_PARTITION } = await import("../../src/main/sessions")
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

  it("adopts a tab's page without closing it, and refuses pages that were destroyed", async () => {
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
    lens.request_handler?.({ url: "https://pbs.twimg.com/media/a.jpg", resourceType: "image" }, (response) => decisions.push(response.cancel))
    lens.request_handler?.({ url: "https://evil.example/steal?data=1", resourceType: "xhr" }, (response) => decisions.push(response.cancel))
    expect(decisions).toEqual([false, true])
  })

  it("keeps lenses and pages sandboxed and isolated", () => {
    expect(lens_preferences("/p.js")).toEqual({ partition: "lens", preload: "/p.js", sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(web_preferences("/p.js", false)).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true })
  })
})
