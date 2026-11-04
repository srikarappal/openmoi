// The window: chrome UI on top and on the right, one content area showing a lens or a web tab.
import path from "node:path"
import { BrowserWindow, ipcMain, type WebContentsView } from "electron"
import type { ActiveTarget, LensToHost, Notice, ShellCommand, ShellState, ViewInfo } from "../shared/types"
import type { BrainClient } from "./brain"
import type { ViewHost } from "./host"
import { LensManager, type LensContext } from "./lenses"
import { SourceReader } from "./sources"
import { TabManager, type Tab } from "./tabs"
import { ViewController, view_lens_key } from "./views"

const TOP_BAR_HEIGHT = 48
const SIDE_PANEL_WIDTH = 340
const MAX_NOTICES = 6

export class Shell implements ViewHost {
  readonly window: BrowserWindow
  readonly page_preload: string
  readonly lens_preload: string
  readonly tabs: TabManager
  readonly lenses: LensManager
  readonly sources: SourceReader
  readonly views: ViewController
  private active: ActiveTarget = { kind: "view", view_id: "feed" }
  private view_infos: ViewInfo[] = []
  private notices: Notice[] = []
  private next_notice_id = 1

  constructor(
    private readonly brain: BrainClient,
    private readonly dist_dir: string,
    headless: boolean,
  ) {
    this.page_preload = path.join(dist_dir, "preload_page.js")
    this.lens_preload = path.join(dist_dir, "preload_lens.js")
    this.window = new BrowserWindow({
      width: 1280,
      height: 860,
      show: !headless,
      title: "openMoi",
      webPreferences: { preload: path.join(dist_dir, "preload_chrome.js"), sandbox: true, contextIsolation: true },
    })
    this.tabs = new TabManager(this, () => this.push_state(), (tab) => this.activate({ kind: "tab", tab_id: tab.tab_id }))
    this.sources = new SourceReader(this)
    this.lenses = new LensManager(this, { on_ready: (context) => this.on_lens_ready(context), on_event: (context, message) => this.on_lens_event(context, message) })
    this.views = new ViewController(brain, this.lenses, this.sources, { open_tab: (url) => this.open_tab(url), notify: (text, url) => this.notify(text, url) })
    this.window.on("resize", () => this.layout())
    ipcMain.on("moi:command", (event, command: ShellCommand) => {
      if (event.sender === this.window.webContents) this.run(command).catch((error) => this.notify(String(error)))
    })
    ipcMain.handle("moi:get_state", () => this.state())
  }

  async start(): Promise<void> {
    await this.window.loadFile(path.join(this.dist_dir, "ui", "index.html"))
    this.view_infos = await this.brain.views()
    await this.open_view(this.view_infos[0]?.view_id ?? "feed")
  }

  attach(view: WebContentsView): void {
    view.setVisible(false)
    this.window.contentView.addChildView(view)
    view.setBounds(this.content_bounds())
  }

  attach_behind(view: WebContentsView): void {
    this.window.contentView.addChildView(view, 0)
    view.setBounds(this.content_bounds())
  }

  detach(view: WebContentsView): void {
    this.window.contentView.removeChildView(view)
  }

  private content_bounds(): Electron.Rectangle {
    const [width, height] = this.window.getContentSize()
    return { x: 0, y: TOP_BAR_HEIGHT, width: Math.max(width - SIDE_PANEL_WIDTH, 320), height: Math.max(height - TOP_BAR_HEIGHT, 240) }
  }

  private layout(): void {
    const bounds = this.content_bounds()
    for (const child of this.window.contentView.children) child.setBounds(bounds)
  }

  private active_tab(): Tab | undefined {
    return this.active.kind === "tab" ? this.tabs.get(this.active.tab_id) : undefined
  }

  private active_view(): WebContentsView | undefined {
    if (this.active.kind === "view") return this.lenses.get(view_lens_key(this.active.view_id))?.view
    return this.active_tab()?.view
  }

  // Shows the active lens or tab on top; hidden source views stay attached underneath and keep rendering.
  private activate(target: ActiveTarget): void {
    this.active = target
    const shown = this.active_view()
    for (const view of [...this.lenses.all().map((context) => context.view), ...this.tabs.all().map((tab) => tab.view)]) {
      view.setVisible(view === shown)
    }
    if (shown) this.window.contentView.addChildView(shown)
    this.push_state()
  }

  async open_view(view_id: string): Promise<void> {
    await this.views.show(view_id)
    this.activate({ kind: "view", view_id })
  }

  open_tab(url: string): void {
    this.activate({ kind: "tab", tab_id: this.tabs.open(url).tab_id })
  }

  notify(text: string, url?: string): void {
    if (this.notices.some((notice) => notice.text === text)) return
    this.notices = [...this.notices, { notice_id: this.next_notice_id++, text, url }].slice(-MAX_NOTICES)
    this.push_state()
  }

  private on_lens_ready(context: LensContext): void {
    if (this.views.owns(context)) this.views.on_ready(context)
  }

  private on_lens_event(context: LensContext, message: LensToHost): void {
    if (this.views.owns(context)) this.views.on_event(context, message).catch((error) => this.notify(String(error)))
  }

  private async run(command: ShellCommand): Promise<void> {
    switch (command.type) {
      case "open_view":
        await this.open_view(command.view_id)
        return
      case "open_tab":
        this.open_tab(command.url)
        return
      case "select_tab":
        this.activate({ kind: "tab", tab_id: command.tab_id })
        return
      case "close_tab":
        this.tabs.close(command.tab_id)
        if (this.active.kind === "tab" && this.active.tab_id === command.tab_id) await this.open_view(this.view_infos[0]?.view_id ?? "feed")
        else this.push_state()
        return
      case "navigate": {
        const tab = this.active_tab()
        if (tab) {
          this.tabs.navigate(tab, command.url)
          this.activate({ kind: "tab", tab_id: tab.tab_id })
        } else {
          this.open_tab(command.url)
        }
        return
      }
      case "refresh": {
        const context = this.active.kind === "view" ? this.lenses.get(view_lens_key(this.active.view_id)) : undefined
        if (context) await this.views.refresh(context, true)
        else this.active_tab()?.view.webContents.reload()
        return
      }
      case "open_notice": {
        const notice = this.notices.find((candidate) => candidate.notice_id === command.notice_id)
        if (notice?.url) this.open_tab(notice.url)
        return
      }
      case "dismiss_notice":
        this.notices = this.notices.filter((notice) => notice.notice_id !== command.notice_id)
        this.push_state()
        return
    }
  }

  state(): ShellState {
    const tab = this.active_tab()
    return {
      views: this.view_infos,
      tabs: this.tabs.infos(),
      active: this.active,
      address: tab ? tab.view.webContents.getURL() : "",
      notices: this.notices,
    }
  }

  push_state(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send("moi:state", this.state())
  }
}
