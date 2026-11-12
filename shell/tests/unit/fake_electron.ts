// A small stand in for the parts of Electron the main process and preloads use, so they run under vitest.
// Tests mock "electron" with this module and inspect the fakes it hands out.
import { EventEmitter } from "node:events"
import { pathToFileURL } from "node:url"

type OpenHandler = (details: { url: string }) => { action: string }
type PermissionHandler = (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void
type RequestHandler = (details: { url: string; resourceType: string }, callback: (response: { cancel: boolean }) => void) => void
type RedirectHandler = (details: { url: string; redirectURL: string; webContentsId?: number }) => void

let next_contents_id = 1

export class FakeWebContents extends EventEmitter {
  readonly id = next_contents_id++
  url = ""
  title = ""
  destroyed = false
  muted = false
  sent: Array<[string, unknown]> = []
  loads: string[] = []
  load_error: Error | null = null
  scripts: string[] = []
  script_result: unknown = []
  open_handler: OpenHandler | null = null
  readonly mainFrame = { name: "main frame" }
  // Lets a test play the page: called with everything the main process sends to this web contents.
  on_send: ((channel: string, message: unknown) => void) | null = null

  send(channel: string, message: unknown): void {
    this.sent.push([channel, message])
    this.on_send?.(channel, message)
  }

  // A real click on this web contents, as the main process sees input.
  press(): void {
    this.emit("input-event", {}, { type: "mouseDown" })
  }

  // Like Electron, the address changes as the load starts; a failure comes a moment later.
  load_options: unknown[] = []

  async loadURL(url: string, options?: unknown): Promise<void> {
    this.loads.push(url)
    if (options !== undefined) this.load_options.push(options)
    this.url = url
    await Promise.resolve()
    if (this.load_error) throw this.load_error
  }

  async loadFile(file: string): Promise<void> {
    this.loads.push(file)
  }

  getURL(): string {
    return this.url
  }

  reloads = 0

  reload(): void {
    this.reloads += 1
  }

  getTitle(): string {
    return this.title
  }

  close(): void {
    this.destroyed = true
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  setAudioMuted(muted: boolean): void {
    this.muted = muted
  }

  setWindowOpenHandler(handler: OpenHandler): void {
    this.open_handler = handler
  }

  // Answers for scripts that start with a given text, before the general script_result.
  script_answers: Array<[string, unknown]> = []
  captured_png: Buffer | null = Buffer.from("png")

  async executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code)
    const answer = this.script_answers.find(([start]) => code.startsWith(start))
    return answer ? answer[1] : this.script_result
  }

  async capturePage(): Promise<{ isEmpty(): boolean; toPNG(): Buffer }> {
    const png = this.captured_png
    return { isEmpty: () => png === null, toPNG: () => png ?? Buffer.alloc(0) }
  }

  messages(channel: string): unknown[] {
    return this.sent.filter(([name]) => name === channel).map(([, message]) => message)
  }
}

export class FakeWebContentsView {
  static created: FakeWebContentsView[] = []
  readonly webContents = new FakeWebContents()
  bounds: unknown = null
  visible = true

  constructor(readonly options: { webPreferences?: Record<string, unknown> } = {}) {
    FakeWebContentsView.created.push(this)
  }

  setBounds(bounds: unknown): void {
    this.bounds = bounds
  }

  setVisible(visible: boolean): void {
    this.visible = visible
  }
}

class FakeContentView {
  children: FakeWebContentsView[] = []

  addChildView(view: FakeWebContentsView, index?: number): void {
    this.children = this.children.filter((child) => child !== view)
    if (index === undefined) this.children.push(view)
    else this.children.splice(index, 0, view)
  }

  removeChildView(view: FakeWebContentsView): void {
    this.children = this.children.filter((child) => child !== view)
  }
}

export class FakeBrowserWindow extends EventEmitter {
  static created: FakeBrowserWindow[] = []
  // Lets a test script each window as it is made (the smoke tester makes its own).
  static on_created: ((window: FakeBrowserWindow) => void) | null = null
  readonly webContents = new FakeWebContents()
  readonly contentView = new FakeContentView()
  size: [number, number] = [1280, 860]
  shown = false
  focused = false
  destroyed = false

  constructor(readonly options: Record<string, unknown> = {}) {
    super()
    FakeBrowserWindow.created.push(this)
    FakeBrowserWindow.on_created?.(this)
  }

  async loadFile(file: string): Promise<void> {
    this.webContents.loads.push(file)
    this.webContents.url = pathToFileURL(file).href
  }

  getContentSize(): [number, number] {
    return this.size
  }

  show(): void {
    this.shown = true
  }

  hide(): void {
    this.shown = false
    this.focused = false
  }

  isVisible(): boolean {
    return this.shown
  }

  isFocused(): boolean {
    return this.focused
  }

  focus(): void {
    this.focused = true
  }

  destroy(): void {
    this.destroyed = true
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeIpcMain extends EventEmitter {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()

  handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, handler)
  }
}

export class FakeSession extends EventEmitter {
  user_agent = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) openmoi_shell/0.1.0 Chrome/140.0.0.0 Electron/45.2.3 Safari/537.36"
  permission_handler: PermissionHandler | null = null
  request_handler: RequestHandler | null = null
  redirect_handler: RedirectHandler | null = null
  readonly webRequest = {
    onBeforeRequest: (handler: RequestHandler): void => {
      this.request_handler = handler
    },
    onBeforeRedirect: (handler: RedirectHandler): void => {
      this.redirect_handler = handler
    },
  }

  setUserAgent(user_agent: string): void {
    this.user_agent = user_agent
  }

  getUserAgent(): string {
    return this.user_agent
  }

  setPermissionRequestHandler(handler: PermissionHandler): void {
    this.permission_handler = handler
  }

  check_handler: ((contents: unknown, permission: string) => boolean) | null = null

  setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void {
    this.check_handler = handler
  }

  // Custom protocol handlers by scheme, and what fetch answers (a test sets it).
  readonly protocols = new Map<string, (request: Request) => Promise<Response> | Response>()
  readonly protocol = {
    handle: (scheme: string, handler: (request: Request) => Promise<Response> | Response): void => {
      this.protocols.set(scheme, handler)
    },
  }
  fetched: Array<[string, RequestInit | undefined]> = []
  fetch_answer: (url: string) => Response = () => new Response("missing", { status: 404 })

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.fetched.push([url, init])
    return this.fetch_answer(url)
  }
}

const sessions = new Map<string, FakeSession>()

class FakeApp extends EventEmitter {
  quits = 0
  login = { openAtLogin: false, wasOpenedAtLogin: false }

  getLoginItemSettings(): { openAtLogin: boolean; wasOpenedAtLogin: boolean } {
    return { ...this.login }
  }

  setLoginItemSettings(settings: { openAtLogin: boolean }): void {
    this.login.openAtLogin = settings.openAtLogin
  }

  private ready_resolve: () => void = () => {}
  private ready = new Promise<void>((resolve) => {
    this.ready_resolve = resolve
  })

  whenReady(): Promise<void> {
    return this.ready
  }

  make_ready(): void {
    this.ready_resolve()
  }

  quit(): void {
    this.quits += 1
  }
}

class FakeIpcRenderer extends EventEmitter {
  sent: Array<[string, unknown]> = []
  invoked: string[] = []
  invoke_result: unknown = null

  send(channel: string, message: unknown): void {
    this.sent.push([channel, message])
  }

  async invoke(channel: string): Promise<unknown> {
    this.invoked.push(channel)
    return this.invoke_result
  }
}

export class FakeNotification extends EventEmitter {
  static shown: FakeNotification[] = []

  constructor(readonly options: { title: string; body: string }) {
    super()
  }

  show(): void {
    FakeNotification.shown.push(this)
  }
}

export class FakeTray {
  static created: FakeTray[] = []
  title = ""
  tooltip = ""
  menu: { items: Array<{ label: string; click: () => void }> } | null = null

  constructor(readonly image: unknown) {
    FakeTray.created.push(this)
  }

  setTitle(title: string): void {
    this.title = title
  }

  setToolTip(tooltip: string): void {
    this.tooltip = tooltip
  }

  setContextMenu(menu: { items: Array<{ label: string; click: () => void }> }): void {
    this.menu = menu
  }
}

export const exposed: Record<string, unknown> = {}
export const opened_paths: string[] = []

export const ipcMain = new FakeIpcMain()
export const ipcRenderer = new FakeIpcRenderer()
export const app = new FakeApp()
export const WebContentsView = FakeWebContentsView
export const Notification = FakeNotification
export const Tray = FakeTray
export const Menu = {
  buildFromTemplate(items: Array<{ label: string; click: () => void }>): { items: Array<{ label: string; click: () => void }> } {
    return { items }
  },
}
export const nativeImage = {
  createEmpty(): object {
    return {}
  },
}
export const powerMonitor = new EventEmitter()
export const privileged_schemes: Array<{ scheme: string; privileges: Record<string, boolean> }> = []
export const protocol = {
  registerSchemesAsPrivileged: (schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>): void => {
    privileged_schemes.push(...schemes)
  },
}
export const BrowserWindow = FakeBrowserWindow
export const session = {
  fromPartition(partition: string): FakeSession {
    const existing = sessions.get(partition) ?? new FakeSession()
    sessions.set(partition, existing)
    return existing
  },
}
export const external_urls: string[] = []
export const shell = {
  async openPath(target: string): Promise<string> {
    opened_paths.push(target)
    return ""
  },
  async openExternal(url: string): Promise<void> {
    external_urls.push(url)
  },
  showItemInFolder(target: string): void {
    opened_paths.push(target)
  },
}
export const error_boxes: Array<[string, string]> = []
export const dialog = {
  showErrorBox(title: string, content: string): void {
    error_boxes.push([title, content])
  },
}
export const contextBridge = {
  exposeInMainWorld(name: string, api: unknown): void {
    exposed[name] = api
  },
}

// The event object Electron passes to ipcMain listeners.
export function ipc_event(sender: FakeWebContents): { sender: FakeWebContents } {
  return { sender }
}

export function reset_electron(): void {
  FakeWebContentsView.created = []
  FakeBrowserWindow.created = []
  FakeBrowserWindow.on_created = null
  ipcMain.removeAllListeners()
  ipcMain.handlers.clear()
  ipcRenderer.removeAllListeners()
  ipcRenderer.sent = []
  ipcRenderer.invoked = []
  sessions.clear()
  FakeNotification.shown = []
  FakeTray.created = []
  powerMonitor.removeAllListeners()
  app.login = { openAtLogin: false, wasOpenedAtLogin: false }
  opened_paths.length = 0
  external_urls.length = 0
  error_boxes.length = 0
  for (const name of Object.keys(exposed)) delete exposed[name]
}
