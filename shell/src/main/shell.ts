// The window: chrome UI on top and on the right, one content area showing a lens or a web tab.
import path from "node:path"
import { BrowserWindow, ipcMain, type WebContentsView } from "electron"
import { site_domain } from "../shared/address"
import type {
  ActiveTarget,
  ChromePageInfo,
  Item,
  LensKind,
  LensToHost,
  MineRequestEvent,
  Notice,
  Proposal,
  RelayInfo,
  ShellCommand,
  ShellState,
  ViewInfo,
} from "../shared/types"
import type { BrainClient } from "./brain"
import { ChatController, explain } from "./chat"
import { ElectronDriver } from "./drivers"
import type { ViewHost } from "./host"
import { LensGenerator, view_label } from "./lens_gen"
import { LensManager, type LensContext } from "./lenses"
import { MineController, chrome_mine_key, tab_mine_key } from "./mine"
import { RelayLink } from "./relay_link"
import { SmokeTester } from "./smoke"
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
  readonly mine: MineController
  readonly chat: ChatController
  readonly lens_gen: LensGenerator
  readonly electron: ElectronDriver
  readonly relay: RelayLink
  private readonly chrome_pages = new Map<number, ChromePageInfo>()
  private next_chrome_page = 1
  private active: ActiveTarget = { kind: "view", view_id: "feed" }
  private activations = 0
  private chat_view_id = "feed"
  private view_infos: ViewInfo[] = []
  private notices: Notice[] = []
  private next_notice_id = 1

  constructor(
    private readonly brain: BrainClient,
    private readonly dist_dir: string,
    private readonly headless: boolean,
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
    this.tabs = new TabManager(this, {
      changed: () => this.push_state(),
      opened: (tab) => this.activate({ kind: "tab", tab_id: tab.tab_id }),
      navigated: (tab) => this.on_navigated(tab),
    })
    this.electron = new ElectronDriver(this)
    this.relay = new RelayLink(brain, this.electron, {
      changed: (status, previous) => this.on_relay_changed(status, previous),
      approval_needed: (extension_id) => this.ask_approval(extension_id),
      mine: (request) => this.open_chrome_page(request).catch((error) => this.notify(explain(error))),
    })
    this.sources = new SourceReader(() => this.relay.driver())
    this.lenses = new LensManager(this, { on_ready: (context) => this.on_lens_ready(context), on_event: (context, message) => this.on_lens_event(context, message) })
    this.chat = new ChatController(brain, {
      chat_view: () => this.chat_view_id,
      on_applied: (proposal) => this.on_applied(proposal),
      changed: () => this.push_state(),
    })
    this.lens_gen = new LensGenerator(brain, new SmokeTester(this.lens_preload), {
      say: (text) => this.chat.say(text),
      on_new_lens: (view_id, kind) => this.reload_lens(view_id, kind),
    })
    this.views = new ViewController(brain, this.lenses, this.sources, {
      open_original: (url) => this.open_original(url),
      notify: (text, url) => this.notify(text, url),
      echo: (text) => this.chat.say(text),
      less_like_this: (view_id, item) => this.less_like_this(view_id, item),
      lens_stale: (view_id, layout_hash) => this.lens_gen.ensure(view_id, "feed", layout_hash),
    })
    this.mine = new MineController(brain, this.lenses, {
      notify: (text) => this.notify(text),
      open_original: (key, url) => this.open_mine_original(key, url),
      lens_stale: (view_id, kind, layout_hash) => this.lens_gen.ensure(view_id, kind, layout_hash),
      less_like_this: (view_id, item) => this.less_like_this(view_id, item),
    })
    this.window.on("resize", () => this.layout())
    ipcMain.on("moi:command", (event, command: ShellCommand) => {
      if (event.sender === this.window.webContents) this.run(command).catch((error) => this.notify(String(error)))
    })
    ipcMain.handle("moi:get_state", () => this.state())
  }

  async start(): Promise<void> {
    await this.window.loadFile(path.join(this.dist_dir, "ui", "index.html"))
    this.view_infos = await this.brain.views()
    this.relay.start()
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

  // A tab in Mine shows its Mine lens; a Chrome page always does; otherwise the page itself.
  private active_view(): WebContentsView | undefined {
    if (this.active.kind === "view") return this.lenses.get(view_lens_key(this.active.view_id))?.view
    if (this.active.kind === "chrome") return this.lenses.get(chrome_mine_key(this.active.page_id))?.view
    const tab = this.active_tab()
    return tab?.mine ? (this.lenses.get(tab_mine_key(tab.tab_id))?.view ?? tab.view) : tab?.view
  }

  // Shows the active lens or tab on top; hidden source views stay attached underneath and keep rendering.
  private activate(target: ActiveTarget): void {
    this.activations += 1
    this.active = target
    const tab = this.active_tab()
    if (target.kind === "view") this.chat_view_id = target.view_id
    else if (target.kind === "chrome") this.chat_view_id = this.mine.view_for(chrome_mine_key(target.page_id)) ?? this.chat_view_id
    else if (tab?.mine) this.chat_view_id = this.mine.view_for(tab_mine_key(tab.tab_id)) ?? this.chat_view_id
    const shown = this.active_view()
    for (const view of [...this.lenses.all().map((context) => context.view), ...this.tabs.all().map((each) => each.view)]) {
      view.setVisible(view === shown)
    }
    if (shown) this.window.contentView.addChildView(shown)
    this.push_state()
  }

  // Loading a view can take a moment; if you opened something else meanwhile, that stays in front.
  async open_view(view_id: string): Promise<void> {
    const ticket = this.activations
    await this.views.show(view_id)
    if (ticket === this.activations) this.activate({ kind: "view", view_id })
  }

  open_tab(url: string): void {
    this.activate({ kind: "tab", tab_id: this.tabs.open(url).tab_id })
  }

  notify(text: string, url?: string, action?: Notice["action"]): void {
    if (this.notices.some((notice) => notice.text === text)) return
    this.notices = [...this.notices, { notice_id: this.next_notice_id++, text, url, action }].slice(-MAX_NOTICES)
    this.push_state()
  }

  // Originals open where your sessions are: your Chrome when connected, an openMoi tab otherwise.
  private open_original(url: string): void {
    if (!this.relay.status.connected) {
      this.open_tab(url)
      return
    }
    this.relay.chrome.open(url, false).catch((error) => {
      this.notify(`Could not open it in Chrome: ${explain(error)}`)
      this.open_tab(url)
    })
  }

  private open_mine_original(key: string, url: string): void {
    if (key.startsWith("tab:")) this.open_in_tab(Number(key.slice(4)), url)
    else this.open_original(url)
  }

  private on_relay_changed(status: RelayInfo, previous: RelayInfo): void {
    if (status.connected && !previous.connected) {
      this.notices = this.notices.filter((notice) => notice.action?.command.type !== "relay_trust")
      this.chat.say("Chrome is connected: openMoi now reads through your own Chrome sessions.")
    } else if (!status.connected && previous.connected) {
      this.chat.say("Chrome disconnected: openMoi falls back to its own session until it is back.")
    }
    this.push_state()
  }

  private ask_approval(extension_id: string): void {
    this.notify(`A Chrome extension (${extension_id.slice(0, 8)}) wants to read pages for openMoi in your Chrome.`, undefined, {
      label: "Allow",
      command: { type: "relay_trust", extension_id },
    })
  }

  // You pressed Mine on a page in Chrome: read it there and show your version here.
  private async open_chrome_page(request: MineRequestEvent): Promise<void> {
    const page_id = this.next_chrome_page++
    const info = { page_id, title: request.title || site_domain(request.url), url: request.url }
    this.chat.say(`Making your version of ${site_domain(request.url)} from Chrome.`)
    const target = { key: chrome_mine_key(page_id), driver: this.relay.chrome, handle: request.handle, url: request.url }
    if (!(await this.mine.enable(target))) return
    this.chrome_pages.set(page_id, info)
    this.activate({ kind: "chrome", page_id })
    if (!this.headless) {
      this.window.show()
      this.window.focus()
    }
  }

  private close_chrome_page(page_id: number): Promise<void> {
    this.mine.disable(chrome_mine_key(page_id))
    this.chrome_pages.delete(page_id)
    if (this.active.kind === "chrome" && this.active.page_id === page_id) return this.open_view(this.view_infos[0]?.view_id ?? "feed")
    this.push_state()
    return Promise.resolve()
  }

  private set_mine_off(tab: Tab): void {
    if (!tab.mine) return
    tab.mine = false
    this.mine.disable(tab_mine_key(tab.tab_id))
  }

  private async toggle_mine(tab: Tab): Promise<void> {
    if (tab.mine) {
      this.set_mine_off(tab)
    } else {
      const url = tab.view.webContents.getURL()
      this.chat.say(`Making your version of ${site_domain(url)}.`)
      tab.mine = await this.mine.enable({ key: tab_mine_key(tab.tab_id), driver: this.electron, handle: this.electron.adopt(tab.view.webContents), url })
    }
    this.activate({ kind: "tab", tab_id: tab.tab_id })
  }

  private open_in_tab(tab_id: number, url: string): void {
    const tab = this.tabs.get(tab_id)
    if (!tab) return
    this.set_mine_off(tab)
    this.tabs.navigate(tab, url)
    this.activate({ kind: "tab", tab_id })
  }

  // A page that changed underneath a Mine view no longer matches it.
  private on_navigated(tab: Tab): void {
    if (tab.mine) {
      this.set_mine_off(tab)
      if (this.active.kind === "tab" && this.active.tab_id === tab.tab_id) this.activate(this.active)
    }
    this.push_state()
  }

  private less_like_this(view_id: string, item: Item): void {
    const label = item.title || item.text?.slice(0, 80) || item.url
    this.chat.send(`Less like this: ${label}`, item.item_id, view_id).catch((error) => this.notify(String(error)))
  }

  private async reload_lens(view_id: string, kind: LensKind): Promise<void> {
    if (kind === "feed") await this.views.reload_lens(view_id)
    else await this.mine.reload_lens(view_id)
  }

  // An applied edit can rename views, change rules, change the layout or roll the lens back.
  private async on_applied(proposal: Proposal): Promise<void> {
    this.view_infos = await this.brain.views()
    if (proposal.lens_action === "rollback") {
      await this.views.reload_lens(proposal.view_id)
      await this.mine.reload_lens(proposal.view_id)
    } else {
      await this.views.after_edit(proposal.view_id)
      await this.mine.after_edit(proposal.view_id)
    }
    this.push_state()
  }

  private on_lens_ready(context: LensContext): void {
    if (this.views.owns(context)) this.views.on_ready(context)
    else if (this.mine.owns(context)) this.mine.on_ready(context)
  }

  private on_lens_event(context: LensContext, message: LensToHost): void {
    const handled = this.views.owns(context) ? this.views.on_event(context, message) : this.mine.on_event(context, message)
    handled.catch((error) => this.notify(String(error)))
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
      case "close_tab": {
        const tab = this.tabs.get(command.tab_id)
        if (tab) this.set_mine_off(tab)
        this.tabs.close(command.tab_id)
        if (this.active.kind === "tab" && this.active.tab_id === command.tab_id) await this.open_view(this.view_infos[0]?.view_id ?? "feed")
        else this.push_state()
        return
      }
      case "navigate": {
        const tab = this.active_tab()
        if (tab) this.open_in_tab(tab.tab_id, command.url)
        else this.open_tab(command.url)
        return
      }
      case "refresh": {
        const context = this.active.kind === "view" ? this.lenses.get(view_lens_key(this.active.view_id)) : undefined
        if (context) await this.views.refresh(context, true)
        else this.active_tab()?.view.webContents.reload()
        return
      }
      case "toggle_mine": {
        const tab = this.active_tab()
        if (tab) await this.toggle_mine(tab)
        return
      }
      case "select_chrome_page":
        if (this.chrome_pages.has(command.page_id)) this.activate({ kind: "chrome", page_id: command.page_id })
        return
      case "close_chrome_page":
        await this.close_chrome_page(command.page_id)
        return
      case "relay_trust":
        await this.relay.trust(command.extension_id)
        return
      case "open_notice": {
        const notice = this.notices.find((candidate) => candidate.notice_id === command.notice_id)
        if (notice?.url) this.open_original(notice.url)
        return
      }
      case "dismiss_notice":
        this.notices = this.notices.filter((notice) => notice.notice_id !== command.notice_id)
        this.push_state()
        return
      case "chat_send":
        await this.chat.send(command.text)
        return
      case "proposal_apply":
        await this.chat.apply(command.proposal_id)
        return
      case "proposal_discard":
        await this.chat.discard(command.proposal_id)
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
      chat: this.chat.list(),
      chat_view: this.view_infos.find((view) => view.view_id === this.chat_view_id)?.title ?? view_label(this.chat_view_id),
      thinking: this.chat.thinking,
      chrome_pages: [...this.chrome_pages.values()],
      relay: this.relay.status,
    }
  }

  push_state(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send("moi:state", this.state())
  }
}
