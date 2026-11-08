// Where page operations run: in your own Chrome through the relay, or in openMoi's own hidden views as a fallback.
import { WebContentsView, type WebContents } from "electron"
import type { PageOp } from "../shared/types"
import type { BrainClient } from "./brain"
import type { ViewHost } from "./host"
import { call_page } from "./page_rpc"
import { web_preferences } from "./sessions"

export type DriverKind = "chrome" | "openmoi"

export interface PageDriver {
  readonly kind: DriverKind
  // Opens a page and resolves once it has loaded; background pages are for reading, not for you to look at.
  open(url: string, background: boolean): Promise<string>
  run<T>(handle: string, op: PageOp, args?: Record<string, unknown>): Promise<T>
  url(handle: string): Promise<string>
  close(handle: string): Promise<void>
}

function is_aborted(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ERR_ABORTED"
}

// Your Chrome, with your sessions, through the openMoi extension.
export class RelayDriver implements PageDriver {
  readonly kind = "chrome" as const

  constructor(private readonly brain: BrainClient) {}

  async open(url: string, background: boolean): Promise<string> {
    return (await this.brain.relay_call<{ handle: string }>("open", { url, background })).handle
  }

  run<T>(handle: string, op: PageOp, args: Record<string, unknown> = {}): Promise<T> {
    return this.brain.relay_call<T>("run", { handle, op, args })
  }

  url(handle: string): Promise<string> {
    return this.brain.relay_call<string>("url", { handle })
  }

  async close(handle: string): Promise<void> {
    await this.brain.relay_call("close", { handle })
  }
}

interface ElectronPage {
  contents: WebContents
  view?: WebContentsView
}

// openMoi's own Chromium session: hidden views for reading, or one of openMoi's web tabs for Mine.
export class ElectronDriver implements PageDriver {
  readonly kind = "openmoi" as const
  private readonly pages = new Map<string, ElectronPage>()
  private next_id = 1

  constructor(private readonly host: ViewHost) {}

  async open(url: string, background: boolean): Promise<string> {
    const view = new WebContentsView({ webPreferences: web_preferences(this.host.page_preload, background) })
    view.webContents.setAudioMuted(true)
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    this.host.attach_behind(view)
    const handle = `view:${this.next_id++}`
    this.pages.set(handle, { contents: view.webContents, view })
    try {
      await view.webContents.loadURL(url)
    } catch (error) {
      // A load cut short by a redirect (a sign in wall, say) still leaves a page to look at; anything else closes the view.
      if (!is_aborted(error)) {
        await this.close(handle)
        throw error
      }
    }
    return handle
  }

  // A page openMoi already shows (a web tab), used in place; closing the handle leaves the tab alone.
  adopt(contents: WebContents): string {
    const handle = `contents:${contents.id}`
    this.pages.set(handle, { contents })
    return handle
  }

  async run<T>(handle: string, op: PageOp, args: Record<string, unknown> = {}): Promise<T> {
    return call_page<T>(this.page(handle).contents, op, args)
  }

  async url(handle: string): Promise<string> {
    return this.page(handle).contents.getURL()
  }

  async close(handle: string): Promise<void> {
    const page = this.pages.get(handle)
    this.pages.delete(handle)
    if (!page?.view) return
    this.host.detach(page.view)
    page.view.webContents.close()
  }

  private page(handle: string): ElectronPage {
    const page = this.pages.get(handle)
    if (!page || page.contents.isDestroyed()) throw new Error(`page ${handle} is gone`)
    return page
  }
}
