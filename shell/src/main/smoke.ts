// The lens smoke test: render synthetic items in a hidden window and report the first thing that went wrong.
import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron"
import { synthetic_view_items } from "../shared/fixtures"
import { lens_data_url } from "../shared/lens_doc"
import { sleep, with_timeout } from "../shared/timing"
import type { LensKind } from "../shared/types"
import { lens_preferences } from "./sessions"

const READY_TIMEOUT_MS = 5_000
const RENDER_SETTLE_MS = 600
const INSPECT_TIMEOUT_MS = 3_000
const RENDERED_IDS = `[...document.querySelectorAll("[data-item-id]")].map((node) => node.dataset.itemId)`

function ignore(): void {}

// Resolves true when the given web contents sends the lens ready message, false after the timeout.
class ReadySignal {
  readonly promise: Promise<boolean>
  private resolve: (ready: boolean) => void = ignore
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    private readonly contents_id: number,
    timeout_ms: number,
  ) {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
    this.timer = setTimeout(() => this.finish(false), timeout_ms)
    ipcMain.on("moi:lens_event", this.listener)
  }

  private readonly listener = (event: IpcMainEvent, message: unknown): void => {
    if (event.sender.id === this.contents_id && (message as { type?: string } | null)?.type === "ready") this.finish(true)
  }

  finish(ready: boolean): void {
    clearTimeout(this.timer)
    ipcMain.removeListener("moi:lens_event", this.listener)
    this.resolve(ready)
  }
}

export class SmokeTester {
  constructor(private readonly lens_preload: string) {}

  // null when the lens renders every synthetic item with data-item-id and logs no errors.
  async problem(html: string, kind: LensKind): Promise<string | null> {
    const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: lens_preferences(this.lens_preload) })
    const contents = window.webContents
    const errors: string[] = []
    contents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message)
    })
    contents.on("render-process-gone", (_event, details) => errors.push(`the lens crashed: ${details.reason}`))
    const ready = new ReadySignal(contents.id, READY_TIMEOUT_MS)
    try {
      await contents.loadURL(lens_data_url(html))
      if (!(await ready.promise)) return errors[0] ? `script error: ${errors[0]}` : "the lens never called moi.ready()"
      const items = synthetic_view_items(kind)
      contents.send("moi:lens", { type: "render", items, cursor: null })
      await sleep(RENDER_SETTLE_MS)
      const shown = new Set(await with_timeout<string[]>(contents.executeJavaScript(RENDERED_IDS), INSPECT_TIMEOUT_MS, "rendering"))
      if (errors.length) return `script error: ${errors[0]}`
      const missing = items.filter((view_item) => !shown.has(view_item.item.item_id)).length
      return missing ? `${missing} of ${items.length} items were not rendered with data-item-id` : null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      ready.finish(false)
      window.destroy()
    }
  }
}
