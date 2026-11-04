// Launches the real app against the shared fake services, in a throwaway home and assets folder.
import { spawn, type ChildProcess } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import { sleep, wait_for } from "../../src/shared/timing"

export const SHELL_DIR = path.resolve(__dirname, "..", "..")
export const REPO_DIR = path.resolve(SHELL_DIR, "..")
const TOKEN = "e2e_token"

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
}

export function fixture_view(name: string, base_url: string): string {
  return readFileSync(path.join(REPO_DIR, "fixtures", "views", `${name}.md`), "utf-8").replaceAll("{base_url}", base_url)
}

export interface LaunchOptions {
  x_page?: string
  views?: Record<string, string>
  fast_slot?: { base_url: string; model: string }
}

export class Harness {
  private constructor(
    readonly app: ElectronApplication,
    readonly chrome: Page,
    readonly brain_url: string,
    readonly root: string,
  ) {}

  get home(): string {
    return path.join(this.root, "home")
  }

  static async launch(world: FakeWorld, options: LaunchOptions = {}): Promise<Harness> {
    const root = mkdtempSync(path.join(tmpdir(), "moi_e2e_"))
    const assets = path.join(root, "assets")
    const home = path.join(root, "home")
    for (const folder of ["templates", "lenses"]) cpSync(path.join(REPO_DIR, folder), path.join(assets, folder), { recursive: true })
    mkdirSync(path.join(assets, "extractors"), { recursive: true })
    const x_spec = JSON.parse(readFileSync(path.join(REPO_DIR, "extractors", "x_home_timeline.json"), "utf-8"))
    x_spec.start_url = `${world.base_url}/pages/${options.x_page ?? "x_home.html"}`
    writeFileSync(path.join(assets, "extractors", "x_home_timeline.json"), JSON.stringify(x_spec))
    mkdirSync(path.join(home, "views"), { recursive: true })
    mkdirSync(path.join(home, ".moi"), { recursive: true })
    const views = options.views ?? { feed: fixture_view("feed", world.base_url) }
    for (const [view_id, text] of Object.entries(views)) writeFileSync(path.join(home, "views", `${view_id}.md`), text)
    const slot = { base_url: `${world.base_url}/llm/v1`, model: "fake" }
    writeFileSync(path.join(home, ".moi", "config.json"), JSON.stringify({ fast: options.fast_slot ?? slot, smart: slot }))
    const brain_port = await free_port()
    const app = await electron.launch({
      args: [path.join(SHELL_DIR, "dist", "main.js")],
      env: {
        ...process.env,
        MOI_HOME: home,
        MOI_ASSETS_DIR: assets,
        MOI_YOUTUBE_BASE: world.base_url,
        MOI_HEADLESS: "1",
        MOI_BRAIN_PORT: String(brain_port),
        MOI_TOKEN: TOKEN,
      },
    })
    const chrome = await app.firstWindow()
    return new Harness(app, chrome, `http://127.0.0.1:${brain_port}`, root)
  }

  async brain<T>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.brain_url}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-moi-token": TOKEN, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return (await response.json()) as T
  }

  // Runs script in every lens view and returns the results, in creation order.
  async in_lenses<T>(script: string): Promise<T[]> {
    return this.app.evaluate(async ({ webContents }, code) => {
      const lenses = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("data:text/html"))
      return Promise.all(lenses.sort((first, second) => first.id - second.id).map((contents) => contents.executeJavaScript(code)))
    }, script)
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

  async close(): Promise<void> {
    await this.app.close()
    rmSync(this.root, { recursive: true, force: true })
  }
}

// Polls probe until predicate holds; returns the last value so assertions can show it.
export async function eventually<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, timeout_ms = 45_000): Promise<T> {
  const deadline = Date.now() + timeout_ms
  let value = await probe()
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(250)
    value = await probe()
  }
  return value
}
