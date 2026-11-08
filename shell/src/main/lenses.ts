// Lens views: each shows one view (or one Mine page) through sandboxed generated HTML.
import { ipcMain, WebContentsView } from "electron"
import { item_images, lens_data_url, parse_lens_message } from "../shared/lens_doc"
import type { HostToLens, Item, LensToHost } from "../shared/types"
import type { ViewHost } from "./host"
import { allow_lens_images, forget_lens, lens_preferences } from "./sessions"

// A lens may open an item or ask for less like it at most this often: a click, not a script looping over items.
// Less like this is paced per item (2 s) and per lens (one every 500 ms), so two different items in a row both count
// but a lens firing it for every item does not.
const ACTION_INTERVAL_MS: Partial<Record<LensToHost["type"], number>> = { open: 800, less_like_this: 2_000 }
const LESS_LIKE_THIS_PER_LENS_MS = 500

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
    allow_lens_images(this.view.webContents.id, item_images(message.items))
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
  private readonly last_action = new Map<string, number>()

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
    } else if (this.in_time(context, message)) {
      this.events.on_event(context, message)
    }
  }

  // Open is paced per lens (a double click opens once); less like this per item, so two items in a row both count.
  private in_time(context: LensContext, message: LensToHost): boolean {
    const interval = ACTION_INTERVAL_MS[message.type]
    if (interval === undefined) return true
    const now = Date.now()
    const paces: Array<[string, number]> = [[`${context.key}\0${message.type}`, message.type === "less_like_this" ? LESS_LIKE_THIS_PER_LENS_MS : interval]]
    if (message.type === "less_like_this") paces.push([`${context.key}\0${message.type}\0${message.item_id}`, interval])
    if (paces.some(([key, wait]) => now - (this.last_action.get(key) ?? 0) < wait)) return false
    for (const [key] of paces) this.last_action.set(key, now)
    return true
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
    forget_lens(context.view.webContents.id)
    this.host.detach(context.view)
    context.view.webContents.close()
  }

  all(): LensContext[] {
    return [...this.contexts.values()]
  }
}
