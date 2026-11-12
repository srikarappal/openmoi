// The window: chrome UI on top and on the right, one content area showing a lens or a web tab.
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, shell as desktop, Tray, type WebContentsView } from "electron"
import { is_search, is_web_url, site_domain } from "../shared/address"
import type {
  ActiveTarget,
  ChromePageInfo,
  CollectionInfo,
  OmniHit,
  Omnibox,
  GateChoice,
  Item,
  LensKind,
  LensToHost,
  MineRequestEvent,
  MomentKind,
  Notice,
  Proposal,
  RelayInfo,
  ShellCommand,
  ShellState,
  StopScreen,
  ViewInfo,
  ViewSchedule,
  WatchAlert,
} from "../shared/types"
import type { BrainClient } from "./brain"
import { format_mirror } from "../shared/commands"
import { ChatController, explain } from "./chat"
import { ElectronDriver } from "./drivers"
import type { ViewHost } from "./host"
import { LensGenerator, view_label } from "./lens_gen"
import { LensManager, type LensContext } from "./lenses"
import { MineController, chrome_mine_key, tab_mine_key } from "./mine"
import { ActivityTracker } from "./activity"
import { RelayLink } from "./relay_link"
import { Player } from "./player"
import { SmokeTester } from "./smoke"
import { ReaderPool } from "./readers"
import { Scheduler } from "./scheduler"
import { TabManager, type Tab } from "./tabs"
import { ViewController, clock_time, view_lens_key } from "./views"

function ignore(): void {}

const TOP_BAR_HEIGHT = 48
const SIDE_PANEL_WIDTH = 340
const MAX_NOTICES = 6
const MIN_OMNIBOX = 2
const OMNIBOX_HITS = 6
const OMNIBOX_LABEL = 90
const UNRECOGNIZED_TAG = "relay:unrecognized"
// Tests run time faster; a minute is a minute otherwise.
const MINUTE_MS = Number(process.env.MOI_MINUTE_MS) || 60_000
const EXTRA_MINUTES = 5
// A visit that ran out while you were elsewhere still ends at the stop screen if you come back this soon.
const OVERDUE_MINUTES = 30

interface Visit {
  view_id: string
  minutes: number
  started_at: number
  timer: ReturnType<typeof setTimeout>
}

// The shared design tokens; a build without them still runs, with lenses on their own styles.
function read_tokens(file: string): string {
  try {
    return readFileSync(file, "utf-8")
  } catch {
    return ""
  }
}

export class Shell implements ViewHost {
  readonly window: BrowserWindow
  readonly page_preload: string
  readonly lens_preload: string
  readonly lens_tokens: string
  readonly tabs: TabManager
  readonly lenses: LensManager
  readonly readers: ReaderPool
  readonly views: ViewController
  readonly mine: MineController
  readonly chat: ChatController
  readonly lens_gen: LensGenerator
  readonly player: Player
  private omnibox: Omnibox | null = null
  private omnibox_ticket = 0
  readonly electron: ElectronDriver
  readonly relay: RelayLink
  readonly scheduler: Scheduler
  readonly activity = new ActivityTracker(() => this.push_state())
  // Set once you quit, so closing the window then really closes it.
  quitting = false
  private tray: Tray | null = null
  private background = false
  private gate: GateChoice[] | null = null
  private stop: StopScreen | null = null
  private visit: Visit | null = null
  private overdue: (Visit & { ended_at: number }) | null = null
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
    start_hidden = false,
  ) {
    this.page_preload = path.join(dist_dir, "preload_page.js")
    this.lens_preload = path.join(dist_dir, "preload_lens.js")
    this.lens_tokens = read_tokens(path.join(dist_dir, "lens_tokens.css"))
    this.window = new BrowserWindow({
      width: 1280,
      height: 860,
      show: !headless && !start_hidden,
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
    this.readers = new ReaderPool(() => this.relay.reading_driver(), brain, undefined, undefined, undefined, (source, feeds) => this.views.offer_feeds(source, feeds))
    this.lenses = new LensManager(this, { on_ready: (context) => this.on_lens_ready(context), on_event: (context, message) => this.on_lens_event(context, message) })
    this.chat = new ChatController(brain, {
      chat_view: () => this.chat_view_id,
      on_applied: (proposal) => this.on_applied(proposal),
      view_created: (view_id) => this.on_view_created(view_id),
      shopping: (view_id, created) => this.on_shopping(view_id, created),
      model_changed: () => {
        this.views.recheck(this.chat_view_id).catch((error) => this.notify(String(error)))
      },
      track: (label, work) => this.activity.track(label, work),
      open_folder: (folder) => {
        desktop.openPath(folder).catch(ignore)
      },
      set_background: (on) => this.set_background(on),
      show_file: (file) => desktop.showItemInFolder(file),
      open_external: (url) => {
        if (url.startsWith("https://")) desktop.openExternal(url).catch(ignore)
      },
      changed: () => this.push_state(),
    })
    this.player = new Player(this, { open_original: (url) => this.open_original(url), changed: () => this.push_state() })
    this.lens_gen = new LensGenerator(brain, new SmokeTester(this.lens_preload, this.lens_tokens, path.join(dist_dir, "axe.min.js")), {
      say: (text) => this.chat.say(text),
      on_new_lens: (view_id, kind) => this.reload_lens(view_id, kind),
      track: (label, work) => this.activity.track(label, work),
    })
    this.views = new ViewController(brain, this.lenses, this.readers, {
      open_original: (url) => this.open_original(url),
      play: (item) => this.player.play(item),
      saved: (info, saved) => this.on_saved(info, saved),
      notify: (text, url, tag, action) => this.notify(text, url, action, tag),
      retract: (tag) => this.retract(tag),
      echo: (text) => this.chat.say(text),
      less_like_this: (view_id, item) => this.less_like_this(view_id, item),
      lens_stale: (view_id, layout_hash) => this.lens_gen.ensure(view_id, "feed", layout_hash),
      alert: (alert) => this.alert(alert),
      track: (label, work) => this.activity.track(label, work),
    })
    this.mine = new MineController(brain, this.lenses, {
      notify: (text) => this.notify(text),
      open_original: (key, url) => this.open_mine_original(key, url),
      lens_stale: (view_id, kind, layout_hash) => this.lens_gen.ensure(view_id, kind, layout_hash),
      less_like_this: (view_id, item) => this.less_like_this(view_id, item),
      play: (item) => this.player.play(item),
    })
    this.scheduler = new Scheduler(
      brain,
      {
        read: (view_id) => this.views.read_for_edition(view_id),
        // Not forced: a page that keeps failing is tried at most every 10 minutes, not every minute.
        watch: (source) => this.views.check_watch(source, false),
        summarize: (wanted) => this.views.summarize(wanted),
        packs: (status) => {
          if (status.startsWith("installed") || status.startsWith("pack refused")) this.chat.say(`Site packs: ${status}.`)
        },
        read_done: (view_id) => {
          this.views.after_edit(view_id).catch((error) => this.notify(String(error)))
        },
        edition_out: (schedule) => this.edition_out(schedule),
        failed: (text) => this.notify(text),
      },
      MINUTE_MS,
    )
    this.window.on("resize", () => this.layout())
    // With editions to read (or background reading on) closing the window only hides it; quitting closes it.
    this.window.on("close", (event) => {
      this.player.close()
      if (this.quitting || !this.keeps_running()) return
      event.preventDefault()
      this.window.hide()
    })
    // The chrome UI never navigates (a link dropped on it would otherwise take the shell bridge with it),
    // and only the UI page itself may send commands or read the state.
    this.window.webContents.on("will-navigate", (event) => event.preventDefault())
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    ipcMain.on("moi:command", (event, command: ShellCommand) => {
      if (this.from_ui(event)) this.run(command).catch((error) => this.notify(String(error)))
    })
    ipcMain.handle("moi:get_state", (event) => (this.from_ui(event) ? this.state() : null))
  }

  // The UI's own main frame: never a frame inside it and never another page that ended up in the window.
  private from_ui(event: { sender: unknown; senderFrame?: unknown }): boolean {
    return event.sender === this.window.webContents && event.senderFrame === this.window.webContents.mainFrame && this.window.webContents.getURL() === this.ui_url
  }

  private get ui_url(): string {
    return pathToFileURL(path.join(this.dist_dir, "ui", "index.html")).href
  }

  // With a view that has a visit length, openMoi first asks why you are here instead of opening a feed.
  async start(): Promise<void> {
    await this.window.loadFile(path.join(this.dist_dir, "ui", "index.html"))
    this.view_infos = await this.brain.views()
    this.background = app.getLoginItemSettings().openAtLogin
    this.relay.start()
    await this.scheduler.tick()
    this.scheduler.start()
    powerMonitor.on("resume", () => {
      this.scheduler.tick().catch(ignore)
    })
    if (!this.headless) this.make_tray()
    this.brain
      .weekly_mirror()
      .then((mirror) => mirror && this.chat.say(`Your week in openMoi.\n${format_mirror(mirror)}`))
      .catch(ignore)
    if (this.view_infos.length > 1 && this.scheduler.schedules.some((schedule) => schedule.visit_minutes)) {
      this.gate = this.choices()
      this.push_state()
      return
    }
    await this.open_view(this.view_infos[0]?.view_id ?? "feed")
  }

  show(): void {
    this.window.show()
    this.window.focus()
  }

  private keeps_running(): boolean {
    return this.background || this.scheduler.schedules.some((schedule) => schedule.next_edition)
  }

  private make_tray(): void {
    this.tray = new Tray(nativeImage.createEmpty())
    this.tray.setTitle("moi")
    this.tray.setToolTip("openMoi")
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open openMoi", click: () => this.show() },
        { label: "Quit openMoi", click: () => app.quit() },
      ]),
    )
  }

  private set_background(on: boolean): string {
    app.setLoginItemSettings({ openAtLogin: on })
    this.background = on
    if (on) return "openMoi now starts when you log in and keeps reading on schedule while its window is closed. Quit it from moi in the menu bar."
    return "openMoi no longer starts at login. Closing its window quits it, unless a view comes out in editions."
  }

  private schedule_of(view_id: string): ViewSchedule | undefined {
    return this.scheduler.schedules.find((schedule) => schedule.view_id === view_id)
  }

  // "Why are you here?": every view, with its visit length and next edition.
  private choices(): GateChoice[] {
    return this.view_infos.map((view) => {
      const schedule = this.schedule_of(view.view_id)
      return { view_id: view.view_id, title: view.title, visit_minutes: schedule?.visit_minutes ?? null, next_edition: schedule?.next_edition ?? null }
    })
  }

  // A visit starts when you open a view that has a visit length; opening another view ends it.
  private begin_visit(view_id: string, minutes = this.schedule_of(view_id)?.visit_minutes ?? 0, kind: MomentKind = "visit"): void {
    if (this.visit?.view_id === view_id) return
    const overdue = this.overdue
    this.overdue = null
    if (kind === "visit" && overdue?.view_id === view_id && Date.now() - overdue.ended_at < OVERDUE_MINUTES * MINUTE_MS) {
      this.show_stop(overdue)
      return
    }
    if (this.visit) clearTimeout(this.visit.timer)
    this.visit = null
    if (minutes <= 0) return
    this.visit = { view_id, minutes, started_at: Date.now(), timer: setTimeout(() => this.visit_over(), minutes * MINUTE_MS) }
    this.brain.moment(view_id, kind).catch(ignore)
  }

  // Time is up: if you are still in the view, it gives way to the stop screen with what you read; if you went
  // elsewhere, the stop screen waits for you to come back to the view.
  private visit_over(): void {
    const visit = this.visit
    this.visit = null
    if (!visit) return
    if (this.active.kind !== "view" || this.active.view_id !== visit.view_id) {
      this.overdue = { ...visit, ended_at: Date.now() }
      return
    }
    this.show_stop(visit)
  }

  private show_stop(visit: Visit): void {
    this.stop = {
      view_id: visit.view_id,
      title: this.view_infos.find((view) => view.view_id === visit.view_id)?.title ?? visit.view_id,
      minutes: visit.minutes,
      read: this.views.seen_since(visit.view_id, visit.started_at),
      next_edition: this.schedule_of(visit.view_id)?.next_edition ?? null,
    }
    this.activate(this.active)
  }

  // A watched page changed in a way you care about: a notice here, and a system notification while you are elsewhere.
  private alert(alert: WatchAlert): void {
    this.notify(`${alert.title}: ${alert.text}`, undefined, { label: "Show", command: { type: "open_view", view_id: alert.view_id } })
    if (this.window.isVisible() && this.window.isFocused()) return
    const notification = new Notification({ title: alert.title, body: alert.text })
    notification.on("click", () => {
      this.show()
      this.run({ type: "open_view", view_id: alert.view_id }).catch((error) => this.notify(String(error)))
    })
    notification.show()
  }

  // An edition that came out while the window is away from you shows as a system notification; click it to read.
  private edition_out(schedule: ViewSchedule): void {
    this.views.after_edit(schedule.view_id).catch((error) => this.notify(String(error)))
    if (!schedule.edition || (this.window.isVisible() && this.window.isFocused())) return
    const notification = new Notification({ title: schedule.title, body: `The ${clock_time(schedule.edition)} edition is out.` })
    notification.on("click", () => {
      this.show()
      this.run({ type: "open_view", view_id: schedule.view_id }).catch((error) => this.notify(String(error)))
    })
    notification.show()
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

  // A tab in Mine shows its Mine lens; a Chrome page always does; otherwise the page itself. The gate and the stop
  // screen are drawn by the chrome UI, so nothing covers them.
  private active_view(): WebContentsView | undefined {
    if (this.gate || this.stop) return undefined
    if (this.active.kind === "view") return this.lenses.get(view_lens_key(this.active.view_id))?.view
    if (this.active.kind === "chrome") return this.lenses.get(chrome_mine_key(this.active.page_id))?.view
    const tab = this.active_tab()
    return tab?.mine ? (this.lenses.get(tab_mine_key(tab.tab_id))?.view ?? tab.view) : tab?.view
  }

  // Shows the active lens or tab on top; hidden source views stay attached underneath and keep rendering.
  private activate(target: ActiveTarget): void {
    this.activations += 1
    this.player.close()
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
    if (ticket !== this.activations) return
    this.activate({ kind: "view", view_id })
    this.begin_visit(view_id)
  }

  open_tab(url: string): void {
    this.activate({ kind: "tab", tab_id: this.tabs.open(url).tab_id })
  }

  notify(text: string, url?: string, action?: Notice["action"], tag?: string): void {
    if (this.notices.some((notice) => notice.text === text)) return
    this.notices = [...this.notices, { notice_id: this.next_notice_id++, text, url, action, tag }].slice(-MAX_NOTICES)
    this.push_state()
  }

  private retract(tag: string): void {
    const kept = this.notices.filter((notice) => notice.tag !== tag)
    if (kept.length === this.notices.length) return
    this.notices = kept
    this.push_state()
  }

  // Originals open where your sessions are: your Chrome when connected, an openMoi tab otherwise.
  private open_original(url: string): void {
    if (!is_web_url(url)) {
      this.notify(`openMoi only opens web links, not ${url.slice(0, 40)}`)
      return
    }
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
    if (status.connected || status.waiting_for_approval) this.retract(UNRECOGNIZED_TAG)
    else if (status.unrecognized && status.unrecognized !== previous.unrecognized) {
      this.notify(
        "Chrome's openMoi extension was paired with an earlier openMoi. In Chrome, open the openMoi extension's menu and press Pair again; then allow it here.",
        undefined,
        undefined,
        UNRECOGNIZED_TAG,
      )
    }
    if (status.connected && !previous.connected) {
      this.notices = this.notices.filter((notice) => notice.action?.command.type !== "relay_trust")
      this.chat.say("Chrome is connected: openMoi now reads through your own Chrome sessions.")
      this.views.chrome_connected().catch((error) => this.notify(String(error)))
    } else if (!status.connected && previous.connected) {
      this.chat.say("Chrome disconnected: openMoi falls back to its own session until it is back.")
    }
    this.push_state()
  }

  private ask_approval(extension_id: string): void {
    this.notify(`A Chrome extension wants to read pages for openMoi in your Chrome. Allow it only if this is the openMoi extension you installed (id ${extension_id}).`, undefined, {
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

  // Making a Mine view can take minutes; a tab closed meanwhile drops it and one you left stays in the background.
  private async toggle_mine(tab: Tab): Promise<void> {
    if (tab.mine) {
      this.set_mine_off(tab)
      this.activate({ kind: "tab", tab_id: tab.tab_id })
      return
    }
    const ticket = this.activations
    const url = tab.view.webContents.getURL()
    const key = tab_mine_key(tab.tab_id)
    this.chat.say(`Making your version of ${site_domain(url)}.`)
    const enabled = await this.mine.enable({ key, driver: this.electron, handle: this.electron.adopt(tab.view.webContents), url })
    if (!this.tabs.get(tab.tab_id) || tab.view.webContents.getURL() !== url) {
      // Closed, or you went to another page meanwhile: a Mine view of the old page would not match it.
      this.mine.disable(key)
      if (this.tabs.get(tab.tab_id)) this.push_state()
      return
    }
    tab.mine = enabled
    if (ticket === this.activations) this.activate({ kind: "tab", tab_id: tab.tab_id })
    else this.push_state()
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

  // The address bar searches your own reality first: views by name, then what you were shown, before the web. Only
  // the latest words typed are shown; an address or a word too short shows nothing.
  private async search_reality(text: string): Promise<void> {
    const ticket = ++this.omnibox_ticket
    const query = text.trim()
    if (query.length < MIN_OMNIBOX || !is_search(query)) {
      this.omnibox = null
      this.push_state()
      return
    }
    const wanted = query.toLowerCase()
    const views: OmniHit[] = this.view_infos
      .filter((view) => view.title.toLowerCase().includes(wanted))
      .map((view) => ({ label: view.title, detail: "your view", target: { kind: "view", view_id: view.view_id } }))
    const found = await this.brain.search(query, OMNIBOX_HITS).catch(() => [])
    if (ticket !== this.omnibox_ticket) return
    const items: OmniHit[] = found.map((hit) => ({
      label: (hit.item.title || hit.item.text || hit.item.url).replace(/\s+/g, " ").slice(0, OMNIBOX_LABEL),
      detail: `${hit.item.source_id} · ${(hit.item.published_at ?? hit.item.fetched_at).slice(0, 10)}`,
      target: { kind: "link", url: hit.item.url },
    }))
    this.omnibox = { query, hits: [...views, ...items] }
    this.push_state()
  }

  // One notice per collection says it was saved to, offering a tab for it while no view reads it.
  private on_saved(info: CollectionInfo, saved: boolean): void {
    if (!saved) return
    this.retract(`collection:${info.name}`)
    const action = info.views.length ? undefined : { label: `Make a ${info.title} tab`, command: { type: "collection_view" as const, name: info.name } }
    this.notify(`Saved to ${info.title} (${info.count}).`, undefined, action, `collection:${info.name}`)
  }

  private async on_shopping(view_id: string, created: boolean): Promise<void> {
    if (created) await this.on_view_created(view_id)
    else await this.open_view(view_id)
    const context = this.lenses.get(view_lens_key(view_id))
    if (context) await this.views.refresh(context, true)
  }

  private async on_view_created(view_id: string): Promise<void> {
    this.view_infos = await this.brain.views()
    await this.open_view(view_id)
  }

  // An applied edit can create or rename views, change rules, change the layout or roll the lens back.
  private async on_applied(proposal: Proposal): Promise<void> {
    const known = new Set(this.view_infos.map((view) => view.view_id))
    this.view_infos = await this.brain.views()
    if (!known.has(proposal.view_id) && this.view_infos.some((view) => view.view_id === proposal.view_id)) {
      await this.open_view(proposal.view_id)
      return
    }
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
      case "choose_view":
        this.gate = null
        this.stop = null
        await this.open_view(command.view_id)
        return
      case "extend_visit": {
        const stop = this.stop
        if (!stop) return
        this.stop = null
        this.begin_visit(stop.view_id, EXTRA_MINUTES, "extended")
        this.activate({ kind: "view", view_id: stop.view_id })
        return
      }
      case "import_view":
        await this.chat.import_file(command.name.slice(0, 200), command.text)
        return
      case "import_history":
        await this.chat.import_history(command.name.slice(0, 200), command.text)
        return
      case "open_early":
        await this.brain.open_early(command.view_id)
        this.retract(`edition:${command.view_id}`)
        await this.views.after_edit(command.view_id)
        return
      case "end_visit":
        this.stop = null
        this.gate = this.choices()
        this.activate(this.active)
        return
      case "open_tab":
        this.open_tab(command.url)
        return
      case "open_link":
        this.open_original(command.url)
        return
      case "close_player":
        this.player.close()
        return
      case "omnibox":
        await this.search_reality(command.text)
        return
      case "collection_view": {
        const view = await this.brain.collection_view(command.name)
        this.retract(`collection:${command.name}`)
        await this.on_view_created(view.view_id)
        return
      }
      case "select_tab":
        if (this.tabs.get(command.tab_id)) this.activate({ kind: "tab", tab_id: command.tab_id })
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
        this.omnibox = null
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
        // Only the extension asking right now and only once: a second click must not change its secret.
        if (this.relay.status.waiting_for_approval !== command.extension_id) return
        this.notices = this.notices.filter((notice) => notice.action?.command.type !== "relay_trust")
        this.push_state()
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
      activities: this.activity.list(),
      chrome_pages: [...this.chrome_pages.values()],
      relay: this.relay.status,
      gate: this.gate,
      stop: this.stop,
      player: this.player.playing,
      omnibox: this.omnibox,
    }
  }

  push_state(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send("moi:state", this.state())
  }
}
