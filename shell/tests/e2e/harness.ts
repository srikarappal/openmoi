// Launches the real app against the shared fake services, in a throwaway home and assets folder.
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, _electron as electron, type BrowserContext, type ElectronApplication, type Page, type Worker } from "@playwright/test"
import { BrainClient } from "../../src/main/brain"
import { sleep, wait_for } from "../../src/shared/timing"

export const SHELL_DIR = path.resolve(__dirname, "..", "..")
export const REPO_DIR = path.resolve(SHELL_DIR, "..")
const EXTENSION_DIR = path.join(SHELL_DIR, "dist", "extension")

// Chrome names an unpacked extension after its folder: the first 32 hex digits of sha256(path), written with the letters a to p.
export function unpacked_extension_id(folder = EXTENSION_DIR): string {
  const hex = createHash("sha256").update(folder).digest("hex").slice(0, 32)
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("")
}
export const TOKEN = "e2e_token"

export function free_port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })
}

export class FakeWorld {
  private constructor(
    readonly base_url: string,
    private readonly child: ChildProcess,
  ) {}

  static async start(): Promise<FakeWorld> {
    const port = await free_port()
    const child = spawn("uv", ["run", "--project", path.join(REPO_DIR, "brain"), "python", path.join(REPO_DIR, "fixtures", "fake_services.py"), "--port", String(port)], {
      stdio: "ignore",
    })
    const world = new FakeWorld(`http://127.0.0.1:${port}`, child)
    await wait_for(() => fetch(`${world.base_url}/rss/tech.xml`).then((response) => response.text()), 60_000, 200)
    return world
  }

  stop(): void {
    this.child.kill()
  }

  // Model calls the fake services received, newest last.
  async model_calls(task: string): Promise<Array<{ path: string; payload: { messages: Array<{ content: string }> } }>> {
    return (await fetch(`${this.base_url}/__requests?task=${task}`)).json()
  }

  // Requests that reached the fake world at paths starting with prefix: method, path and headers.
  async hits(prefix: string): Promise<Array<{ method: string; path: string; headers: Record<string, string> }>> {
    return (await fetch(`${this.base_url}/__hits?prefix=${encodeURIComponent(prefix)}`)).json()
  }

  page(name: string): string {
    return `${this.base_url}/pages/${name}`
  }
}

export function fixture_view(name: string, base_url: string): string {
  return readFileSync(path.join(REPO_DIR, "fixtures", "views", `${name}.md`), "utf-8").replaceAll("{base_url}", base_url)
}

export interface LaunchOptions {
  x_page?: string
  views?: Record<string, string>
  fast_slot?: { base_url: string; model: string }
  // The fake model also judges lenses from screenshots.
  vision?: boolean
  // Files to put in the assets folder (site policy, extractor specs), by path inside it.
  assets?: Record<string, string>
  files?: Record<string, string>
  // The folder of an earlier run, to start openMoi again on the same home, as after a restart.
  root?: string
  env?: Record<string, string>
  // More settings for .moi/config.json, such as a pack channel.
  config?: Record<string, unknown>
  // A packaged openMoi to launch instead of the shell's dist/main.js.
  executable?: string
}

export class Harness {
  private constructor(
    readonly app: ElectronApplication,
    readonly chrome: Page,
    readonly brain_socket: string,
    readonly root: string,
    readonly relay_port: number,
  ) {}

  get home(): string {
    return path.join(this.root, "home")
  }

  static async launch(world: FakeWorld, options: LaunchOptions = {}): Promise<Harness> {
    const root = options.root ?? mkdtempSync(path.join(tmpdir(), "moi_e2e_"))
    const assets = path.join(root, "assets")
    const home = path.join(root, "home")
    if (!options.root) Harness.prepare(world, options, assets, home)
    // The brain answers on a Unix socket in the run's own folder, as it does for the shell.
    const brain_socket = path.join(root, "brain.sock")
    const relay_port = await free_port()
    const app = await electron.launch({
      ...(options.executable ? { executablePath: options.executable, args: [] } : { args: [path.join(SHELL_DIR, "dist", "main.js")] }),
      env: {
        ...process.env,
        MOI_HOME: home,
        MOI_ASSETS_DIR: assets,
        MOI_YOUTUBE_BASE: world.base_url,
        MOI_EMBED_BASE: world.base_url,
        MOI_MEDIA_LOOPBACK: "1",
        MOI_HEADLESS: "1",
        MOI_BRAIN_SOCKET: brain_socket,
        MOI_TOKEN: TOKEN,
        MOI_RELAY_PORT: String(relay_port),
        ...options.env,
      },
    })
    const chrome = await app.firstWindow()
    return new Harness(app, chrome, brain_socket, root, relay_port)
  }

  // A fresh home and assets folder with the fixture views, the X extractor pointed at the fake world and the fake model.
  static prepare(world: FakeWorld, options: LaunchOptions, assets: string, home: string): void {
    for (const folder of ["templates", "lenses"]) cpSync(path.join(REPO_DIR, folder), path.join(assets, folder), { recursive: true })
    mkdirSync(path.join(assets, "extractors"), { recursive: true })
    const x_spec = JSON.parse(readFileSync(path.join(REPO_DIR, "extractors", "x_home_timeline.json"), "utf-8"))
    x_spec.start_url = `${world.base_url}/pages/${options.x_page ?? "x_home.html"}`
    writeFileSync(path.join(assets, "extractors", "x_home_timeline.json"), JSON.stringify(x_spec))
    mkdirSync(path.join(home, "views"), { recursive: true })
    mkdirSync(path.join(home, ".moi"), { recursive: true })
    const views = options.views ?? { feed: fixture_view("feed", world.base_url) }
    for (const [view_id, text] of Object.entries(views)) writeFileSync(path.join(home, "views", `${view_id}.md`), text)
    for (const [relative, text] of Object.entries(options.files ?? {})) {
      mkdirSync(path.dirname(path.join(home, relative)), { recursive: true })
      writeFileSync(path.join(home, relative), text)
    }
    for (const [relative, text] of Object.entries(options.assets ?? {})) {
      mkdirSync(path.dirname(path.join(assets, relative)), { recursive: true })
      writeFileSync(path.join(assets, relative), text)
    }
    const slot = { base_url: `${world.base_url}/llm/v1`, model: "fake" }
    writeFileSync(path.join(home, ".moi", "config.json"), JSON.stringify({ fast: options.fast_slot ?? slot, smart: slot, ...(options.vision ? { vision: slot } : {}), ...options.config }))
  }

  async brain<T>(route: string, body?: unknown): Promise<T> {
    return new BrainClient(this.brain_socket, TOKEN).request<T>(body === undefined ? "GET" : "POST", route, body)
  }

  // Runs script in every lens view and returns the results, in creation order.
  async in_lenses<T>(script: string): Promise<T[]> {
    return this.app.evaluate(async ({ webContents }, code) => {
      const lenses = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("data:text/html"))
      // As if you did it: clicks the script makes count as yours, the way a lens sees a real click.
      return Promise.all(lenses.sort((first, second) => first.id - second.id).map((contents) => contents.executeJavaScript(code, true)))
    }, script)
  }

  // Clicks, with real mouse input through the main process, the element the expression finds in the first lens that
  // has it (the newest first when newest is set), the way you would; returns that element's data-item-id, or null
  // when no lens has it.
  async click_lens(find: string, newest = false): Promise<string | null> {
    return this.app.evaluate(async ({ webContents }, [expression, newest_first]) => {
      const lenses = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("data:text/html"))
      const ordered = lenses.sort((first, second) => (newest_first ? second.id - first.id : first.id - second.id))
      for (const contents of ordered) {
        const point = await contents.executeJavaScript(
          `(() => { const node = ${expression}; if (!node) return null; node.scrollIntoView({ block: "center" }); const box = node.getBoundingClientRect(); ` +
            `return { x: Math.round(box.left + Math.min(box.width / 2, 24)), y: Math.round(box.top + Math.min(box.height / 2, 12)), id: node.closest("[data-item-id]")?.dataset.itemId ?? "" } })()`,
        )
        if (!point) continue
        for (const type of ["mouseDown", "mouseUp"] as const) contents.sendInputEvent({ type, x: point.x, y: point.y, button: "left", clickCount: 1 })
        return point.id as string
      }
      return null
    }, [find, newest] as const)
  }

  async in_tabs<T>(script: string): Promise<T[]> {
    return this.app.evaluate(async ({ webContents }, code) => {
      const tabs = webContents.getAllWebContents().filter((contents) => /^https?:/.test(contents.getURL()) && contents.getURL().includes("/articles/"))
      return Promise.all(tabs.map((contents) => contents.executeJavaScript(code)))
    }, script)
  }

  async lens_text(): Promise<string> {
    return (await this.in_lenses<string>("document.body.innerText")).join("\n")
  }

  // Types into the chat panel and waits for openMoi's answer.
  async chat(text: string): Promise<void> {
    const before = await this.chrome.locator(".message.moi").count()
    await this.chrome.locator(".composer input").fill(text)
    await this.chrome.locator(".composer input").press("Enter")
    await this.chrome.locator(".message.moi").nth(before).waitFor()
  }

  file(relative: string): string {
    return readFileSync(path.join(this.home, relative), "utf-8")
  }

  write(relative: string, content: string): void {
    writeFileSync(path.join(this.home, relative), content)
  }

  files_in(relative: string): string[] {
    return readdirSync(path.join(this.home, relative)).sort()
  }

  // Opens a page in a new tab from the address bar and waits until its title shows in the tab.
  async open_page(url: string, title: string): Promise<void> {
    await this.chrome.locator(".address input").fill(url)
    await this.chrome.locator(".address input").press("Enter")
    await this.chrome.locator(".tab.web.active .tab_title").filter({ hasText: title }).waitFor()
  }

  // The newest lens view's text: a Mine page opens after the Feed lens.
  async last_lens_text(): Promise<string> {
    return (await this.in_lenses<string>("document.body.innerText")).at(-1) ?? ""
  }

  // keep leaves the home in place for a relaunch with { root }.
  async close(keep = false): Promise<void> {
    await this.app.close()
    if (!keep) rmSync(this.root, { recursive: true, force: true })
  }
}

// Polls probe until predicate holds and returns that value; a wait that runs out fails with the last value it saw.
export async function eventually<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, timeout_ms = 45_000): Promise<T> {
  const deadline = Date.now() + timeout_ms
  let value = await probe()
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(250)
    value = await probe()
  }
  // A wait that ran out is a failure, never a silent pass for whatever comes after it.
  if (!predicate(value)) throw new Error(`gave up after ${timeout_ms} ms; last value: ${JSON.stringify(value)?.slice(0, 800)}`)
  return value
}

// Your Chrome in the tests: a Chromium with the openMoi extension loaded, signed in to the fake X by cookie.
export class ChromeWithExtension {
  private constructor(
    readonly context: BrowserContext,
    readonly worker: Worker,
    private readonly profile: string,
  ) {}

  // With a secret the extension starts out paired, as if you had allowed it in an earlier session.
  static async launch(world: FakeWorld, relay_port: number, secret?: string): Promise<ChromeWithExtension> {
    const profile = mkdtempSync(path.join(tmpdir(), "moi_chrome_"))
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    })
    await context.addCookies([{ name: "moi_session", value: "1", url: world.base_url }])
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
    await worker.evaluate(
      ([url, paired]) => chrome.storage.local.set((paired ? { relay_url: url, relay_secret: paired } : { relay_url: url }) as Record<string, string>),
      [`ws://127.0.0.1:${relay_port}/relay`, secret ?? ""],
    )
    return new ChromeWithExtension(context, worker, profile)
  }

  // Presses Mine for the open tab showing url, the way the popup button does.
  async mine(url: string): Promise<boolean> {
    return this.worker.evaluate(async (target) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === target)
      const relay = (globalThis as unknown as { moi_relay: { mine_tab(tab: chrome.tabs.Tab): boolean } }).moi_relay
      return tab ? relay.mine_tab(tab) : false
    }, url)
  }

  urls(): string[] {
    return this.context.pages().map((page) => page.url())
  }

  async close(): Promise<void> {
    await this.context.close()
    rmSync(this.profile, { recursive: true, force: true })
  }
}
