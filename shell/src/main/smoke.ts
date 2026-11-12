// The lens test gate: render the synthetic scenarios (no items, one, 50 timed, the hard cases, 500) in a hidden
// window and report the first thing that went wrong: a script error, items not rendered, 50 items taking 50 ms or
// more, a serious accessibility problem, or a load from outside. A lens that passes comes with a screenshot of its 50
// item render for the visual judge.
import { readFileSync } from "node:fs"
import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron"
import { lens_scenarios, type LensScenario } from "../shared/fixtures"
import { lens_data_url, with_media } from "../shared/lens_doc"
import { sleep, with_timeout } from "../shared/timing"
import type { LensKind } from "../shared/types"
import { forget_media, media_url } from "./media"
import { blocked_lens_requests, forget_lens, lens_preferences } from "./sessions"

const READY_TIMEOUT_MS = 5_000
const RENDER_TIMEOUT_MS = 5_000
const RENDER_SETTLE_MS = 300
const INSPECT_TIMEOUT_MS = 5_000
export const MAX_RENDER_MS = 50
const RENDERED_IDS = `[...document.querySelectorAll("[data-item-id]")].map((node) => node.dataset.itemId)`
// Serious and critical WCAG A and AA problems fail a lens; the rest are left to taste.
const AXE_RUN = `axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, resultTypes: ["violations"] })
  .then((result) => result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")
  .map((violation) => violation.id + ": " + violation.help + " (" + violation.nodes.length + " elements)"))`

export interface LensCheck {
  problem: string | null
  // A PNG, base64, of the timed render, for the visual judge.
  screenshot: string | null
  render_ms: number | null
}

function ignore(): void {}

// Resolves with the first matching message the given web contents sends on a channel, or null after the timeout.
class Signal<T> {
  readonly promise: Promise<T | null>
  private resolve: (value: T | null) => void = ignore
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    private readonly channel: string,
    private readonly contents_id: number,
    private readonly wanted: (message: unknown) => T | null,
    timeout_ms: number,
  ) {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
    this.timer = setTimeout(() => this.finish(null), timeout_ms)
    ipcMain.on(channel, this.listener)
  }

  private readonly listener = (event: IpcMainEvent, message: unknown): void => {
    const value = event.sender.id === this.contents_id ? this.wanted(message) : null
    if (value !== null) this.finish(value)
  }

  finish(value: T | null): void {
    clearTimeout(this.timer)
    ipcMain.removeListener(this.channel, this.listener)
    this.resolve(value)
  }
}

function is_ready(message: unknown): true | null {
  return (message as { type?: string } | null)?.type === "ready" ? true : null
}

function render_ms(message: unknown): number | null {
  const timing = message as { type?: string; ms?: unknown } | null
  return timing?.type === "render" && typeof timing.ms === "number" && Number.isFinite(timing.ms) ? timing.ms : null
}

function failed(problem: string): LensCheck {
  return { problem, screenshot: null, render_ms: null }
}

export class SmokeTester {
  private axe: string | null = null

  constructor(
    private readonly lens_preload: string,
    private readonly lens_tokens = "",
    private readonly axe_path: string | null = null,
  ) {}

  // The problem message a model can fix, or null; kept for callers that only want that.
  async problem(html: string, kind: LensKind): Promise<string | null> {
    return (await this.check(html, kind)).problem
  }

  async check(html: string, kind: LensKind): Promise<LensCheck> {
    // Never throttled, so the frames a lens renders over are timed as they would run in front of you.
    const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { ...lens_preferences(this.lens_preload), backgroundThrottling: false } })
    const contents = window.webContents
    contents.on("will-navigate", (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    const errors: string[] = []
    contents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message)
    })
    contents.on("render-process-gone", (_event, details) => errors.push(`the lens crashed: ${details.reason}`))
    const ready = new Signal("moi:lens_event", contents.id, is_ready, READY_TIMEOUT_MS)
    try {
      await contents.loadURL(lens_data_url(html, this.lens_tokens))
      if (!(await ready.promise)) return failed(errors[0] ? `script error: ${errors[0]}` : "the lens never called moi.ready()")
      await sleep(RENDER_SETTLE_MS)
      if (errors.length) return failed(`script error: ${errors[0]}`)
      let passed: LensCheck = { problem: null, screenshot: null, render_ms: null }
      for (const scenario of lens_scenarios(kind)) {
        const result = await this.scenario(window, scenario, errors)
        if (result.problem) return result
        if (scenario.timed) passed = result
      }
      const [stray] = blocked_lens_requests(contents.id)
      return stray ? failed(`the lens tried to load ${stray.slice(0, 120)}, which is not an item's image`) : passed
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    } finally {
      ready.finish(null)
      forget_lens(contents.id)
      window.destroy()
    }
  }

  private async scenario(window: BrowserWindow, scenario: LensScenario, errors: string[]): Promise<LensCheck> {
    const contents = window.webContents
    const timing = new Signal("moi:lens_timing", contents.id, render_ms, RENDER_TIMEOUT_MS)
    forget_media(contents.id)
    contents.send("moi:lens", { type: "render", items: with_media(scenario.items, (url) => media_url(contents.id, url)), cursor: null })
    const ms = await timing.promise
    await sleep(RENDER_SETTLE_MS)
    if (errors.length) return failed(`script error with ${scenario.name}: ${errors[0]}`)
    if (ms === null) return failed(`the lens did not finish rendering ${scenario.name}`)
    const shown = new Set(await with_timeout<string[]>(contents.executeJavaScript(RENDERED_IDS), INSPECT_TIMEOUT_MS, "rendering"))
    const missing = scenario.items.filter((view_item) => !shown.has(view_item.item.item_id)).length
    if (missing) return failed(`${missing} of ${scenario.items.length} items were not rendered with data-item-id (${scenario.name})`)
    if (!scenario.timed) return { problem: null, screenshot: null, render_ms: ms }
    if (ms >= MAX_RENDER_MS) return failed(`rendering ${scenario.name} took ${Math.round(ms)} ms; it must take under ${MAX_RENDER_MS} ms`)
    const [violation] = await this.accessibility(contents)
    if (violation) return failed(`an accessibility problem with ${scenario.name}: ${violation}`)
    const image = await contents.capturePage()
    return { problem: null, screenshot: image.isEmpty() ? null : image.toPNG().toString("base64"), render_ms: ms }
  }

  // Serious and critical accessibility problems axe-core finds; none when axe-core is not built in.
  private async accessibility(contents: Electron.WebContents): Promise<string[]> {
    if (!this.axe_path) return []
    this.axe ??= readFileSync(this.axe_path, "utf-8")
    await with_timeout(contents.executeJavaScript(this.axe), INSPECT_TIMEOUT_MS, "loading the accessibility check")
    return with_timeout<string[]>(contents.executeJavaScript(AXE_RUN), INSPECT_TIMEOUT_MS * 2, "the accessibility check")
  }
}
