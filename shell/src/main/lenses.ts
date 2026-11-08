// Lens views: each shows one view (or one Mine page) through sandboxed generated HTML.
import { ipcMain, WebContentsView } from "electron"
import { lens_data_url, parse_lens_message } from "../shared/lens_doc"
import type { HostToLens, Item, LensToHost } from "../shared/types"
import type { ViewHost } from "./host"
import { lens_preferences } from "./sessions"

export class LensContext {
  readonly rendered = new Map<string, Item>()
  ready = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly key: string,
    readonly view_id: string,
    readonly view: WebContentsView,
  ) {}

  send(message: HostToLens): void {
    if (message.type === "render") this.rendered.clear()
    for (const view_item of message.items) this.rendered.set(view_item.item.item_id, view_item.item)
    this.view.webContents.send("moi:lens", message)
  }

  // Runs page fetches one at a time so concurrent refreshes and scrolls never append the same items twice.
  serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(ignore).then(task)
    this.queue = next
    return next
  }
}

function ignore(): void {}

export interface LensEvents {
  on_ready(context: LensContext): void
  on_event(context: LensContext, message: LensToHost): void
}

export class LensManager {
  private readonly contexts = new Map<string, LensContext>()
  private readonly by_contents = new Map<number, LensContext>()

  constructor(
    private readonly host: ViewHost,
    private readonly events: LensEvents,
  ) {
    ipcMain.on("moi:lens_event", (event, raw) => this.dispatch(event.sender.id, raw))
  }

  private dispatch(contents_id: number, raw: unknown): void {
    const context = this.by_contents.get(contents_id)
    const message = parse_lens_message(raw)
    if (!context || !message) return
    if (message.type === "ready") {
      // A lens that calls ready again (say inside its render listener) must not start render and refresh over and over.
      if (context.ready) return
      context.ready = true
      this.events.on_ready(context)
    } else {
      this.events.on_event(context, message)
    }
  }

  get(key: string): LensContext | undefined {
    return this.contexts.get(key)
  }

  async open(key: string, view_id: string, html: string): Promise<LensContext> {
    const existing = this.contexts.get(key)
    if (existing) return existing
    const view = new WebContentsView({ webPreferences: lens_preferences(this.host.lens_preload) })
    view.webContents.on("will-navigate", (event) => event.preventDefault())
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    const context = new LensContext(key, view_id, view)
    this.contexts.set(key, context)
    this.by_contents.set(view.webContents.id, context)
    this.host.attach(view)
    await this.load(context, html)
    return context
  }

  // Replaces the lens HTML; the lens calls ready again and gets a fresh render.
  async load(context: LensContext, html: string): Promise<void> {
    context.ready = false
    context.rendered.clear()
    await context.view.webContents.loadURL(lens_data_url(html))
  }

  close(key: string): void {
    const context = this.contexts.get(key)
    if (!context) return
    this.contexts.delete(key)
    this.by_contents.delete(context.view.webContents.id)
    this.host.detach(context.view)
    context.view.webContents.close()
  }

  all(): LensContext[] {
    return [...this.contexts.values()]
  }
}
