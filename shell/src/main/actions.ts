// Actions on sites, through the brain's gate: your click in a lens asks, the gate answers, and an allowed action runs
// visibly in a tab on the real page, with real input, and is checked there. Tier 1 waits five seconds for an undo;
// tier 2 waits for you to confirm the exact text, target and site; tier 3 only opens the page for you.
import type { WebContents } from "electron"
import { sleep, with_timeout } from "../shared/timing"
import type { ActionAnchor, ActionDecision, Item, Notice } from "../shared/types"
import type { BrainClient } from "./brain"

const FIND_TIMEOUT_MS = 10_000
const VERIFY_TIMEOUT_MS = 6_000
const POLL_MS = 200
const LOAD_TIMEOUT_MS = 20_000

export interface Point {
  x: number
  y: number
}

// A real page an action runs on: scripts read it, clicks and typing are real input.
export interface ActionPage {
  // The address the page is at now, after any redirect.
  url(): string
  run<T>(script: string): Promise<T>
  click(point: Point): void
  type(text: string): Promise<void>
}

// A tab's page as an action sees it: its own scripts read it; clicks and typing arrive as real input.
export class TabPage implements ActionPage {
  constructor(private readonly contents: WebContents) {}

  url(): string {
    return this.contents.getURL()
  }

  run<T>(script: string): Promise<T> {
    return this.contents.executeJavaScript(script)
  }

  click(point: Point): void {
    for (const type of ["mouseDown", "mouseUp"] as const) this.contents.sendInputEvent({ type, x: point.x, y: point.y, button: "left", clickCount: 1 })
  }

  type(text: string): Promise<void> {
    return this.contents.insertText(text)
  }
}

// Resolves once a tab has finished loading (or failed to), and after the timeout either way.
export function loaded(contents: WebContents): Promise<void> {
  const finished = new Promise<void>((resolve) => {
    contents.once("did-finish-load", () => resolve())
    contents.once("did-fail-load", () => resolve())
  })
  return with_timeout(finished, LOAD_TIMEOUT_MS, "loading the page").catch(() => undefined)
}

export interface ActionHooks {
  // A visible tab on the item's page, loaded.
  open_page(url: string): Promise<ActionPage>
  open_original(url: string): void
  notify(text: string, url?: string, action?: Notice["action"], tag?: string): void
  retract(tag: string): void
  changed(): void
  // An item the action changed (liked, followed): lenses showing it update.
  item_changed(item: Item): void
}

export interface Outcome {
  ok: boolean
  detail: string
}

// Scripts the executor runs on the page, each a function of one JSON argument, so what it asks is plain to read.
const FIND_SCRIPT = `(args) => {
  const roots = args.within ? [...document.querySelectorAll(args.within)] : [document]
  if (roots.length !== 1) return { count: 0, roots: roots.length }
  const found = [...roots[0].querySelectorAll(args.select)]
  if (found.length !== 1) return { count: found.length, roots: 1 }
  found[0].scrollIntoView({ block: "center" })
  const box = found[0].getBoundingClientRect()
  return { count: 1, roots: 1, x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
}`
const TEXT_SCRIPT = `(args) => { const node = document.querySelector(args.select); return node ? node.textContent : null }`
const FOCUS_SCRIPT = `(args) => { document.querySelector(args.select)?.focus(); return true }`
// Sent means your words are on the page and no longer only in the box you wrote them in.
const SENT_SCRIPT = `(args) => { const box = document.querySelector(args.input); return document.body.innerText.includes(args.text) && !(box && box.innerText.includes(args.text)) }`

export interface Found {
  count: number
  roots: number
  x?: number
  y?: number
}

function call(script: string, args: Record<string, unknown>): string {
  return `(${script})(${JSON.stringify(args)})`
}

function host_of(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

async function find(page: ActionPage, within: string | null, select: string): Promise<Found> {
  return (await page.run<Found | null>(call(FIND_SCRIPT, { within, select })).catch(() => null)) ?? { count: 0, roots: 0 }
}

// The one control the selector names inside the item's own part of the page, once the page shows it; or why not.
export async function wait_for(page: ActionPage, within: string | null, select: string, timeout_ms = FIND_TIMEOUT_MS): Promise<Point | string> {
  const deadline = Date.now() + timeout_ms
  for (;;) {
    const found = await find(page, within, select)
    if (found.roots > 1) return "the page holds more than one such item, so openMoi cannot tell which is yours"
    if (found.count > 1) return "more than one control matched"
    if (found.count === 1 && found.x !== undefined && found.y !== undefined) return { x: found.x, y: found.y }
    if (Date.now() > deadline) return "it was not on the page"
    await sleep(POLL_MS)
  }
}

async function until(check: () => Promise<boolean>, timeout_ms: number): Promise<boolean> {
  const deadline = Date.now() + timeout_ms
  for (;;) {
    if (await check().catch(() => false)) return true
    if (Date.now() > deadline) return false
    await sleep(POLL_MS)
  }
}

// How the page shows the action worked: the anchor's active state in the item's own part of the page, a text that
// changed, or your words on the page and out of the box you wrote them in.
async function verified(page: ActionPage, anchor: ActionAnchor, text: string, before: string | null): Promise<Outcome> {
  if (anchor.active_state) {
    const shown = await until(async () => (await find(page, anchor.within, anchor.active_state ?? "")).count >= 1, VERIFY_TIMEOUT_MS)
    return shown ? { ok: true, detail: "the page shows it" } : { ok: false, detail: "the page did not show it worked" }
  }
  if (anchor.changed) {
    const moved = await until(async () => (await page.run<string | null>(call(TEXT_SCRIPT, { select: anchor.changed }))) !== before, VERIFY_TIMEOUT_MS)
    return moved ? { ok: true, detail: "the page changed" } : { ok: false, detail: "the page did not change" }
  }
  if (text && anchor.input) {
    const sent = await until(() => page.run<boolean>(call(SENT_SCRIPT, { input: anchor.input, text })), VERIFY_TIMEOUT_MS)
    return sent ? { ok: true, detail: "your words are on the page" } : { ok: false, detail: "your words were not sent" }
  }
  return { ok: true, detail: "done; the page gives no sign to check" }
}

// Runs an allowed action on its item's page: only on the site the gate allowed, only on the one control in the item's
// own part of the page, not when the page shows it done already; then for a reply the box and the send button; then
// the check.
export async function perform(page: ActionPage, decision: ActionDecision): Promise<Outcome> {
  const anchor = decision.anchor
  if (!anchor) return { ok: false, detail: "no control to use" }
  const landed = host_of(page.url())
  if (landed !== decision.site) return { ok: false, detail: `the page went to ${landed || "an unknown address"}, not ${decision.site}` }
  if (anchor.active_state && (await find(page, anchor.within, anchor.active_state)).count >= 1) return { ok: false, detail: "the page shows it done already" }
  let before: string | null = null
  if (anchor.changed) {
    const counter = await wait_for(page, null, anchor.changed)
    if (typeof counter === "string") return { ok: false, detail: `what shows it worked: ${counter}` }
    before = await page.run<string | null>(call(TEXT_SCRIPT, { select: anchor.changed }))
  }
  const control = await wait_for(page, anchor.within, anchor.select)
  if (typeof control === "string") return { ok: false, detail: `the ${decision.label} button: ${control}` }
  page.click(control)
  if (decision.text && anchor.input) {
    const box = await wait_for(page, null, anchor.input)
    if (typeof box === "string") return { ok: false, detail: `the box to write in: ${box}` }
    page.click(box)
    // A box with nothing in it may have no height for a click to land on; it is focused for the typing either way.
    await page.run(call(FOCUS_SCRIPT, { select: anchor.input }))
    await page.type(decision.text)
    if (anchor.submit) {
      const send = await wait_for(page, null, anchor.submit)
      if (typeof send === "string") return { ok: false, detail: `the send button: ${send}` }
      page.click(send)
    }
  }
  return verified(page, anchor, decision.text, before)
}

export class ActionController {
  // The action on the confirm sheet, and those an agent proposed waiting for it, one at a time.
  pending: ActionDecision | null = null
  private readonly queued: ActionDecision[] = []
  private readonly offered = new Set<string>()
  private readonly waiting = new Map<string, { decision: ActionDecision; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly brain: BrainClient,
    private readonly hooks: ActionHooks,
  ) {}

  // Your click on an item asks the gate; what it allows is confirmed, given its undo time, or done.
  async request(item: Item, action: string, text: string): Promise<void> {
    const decision = await this.brain.check_action(item.item_id, action, text)
    if (!decision.allowed) {
      this.hooks.notify(decision.reason)
      if (decision.tier === 3) this.hooks.open_original(item.url)
      return
    }
    if (decision.confirm) {
      // The sheet never changes under you: while one is open, a new request is refused, not put in its place.
      if (this.pending) {
        await this.brain.action_result(decision.request_id, "declined", "a confirm sheet was already open")
        this.hooks.notify("Finish the action waiting for your confirm first.")
        return
      }
      this.pending = decision
      this.hooks.changed()
      return
    }
    if (decision.undo_seconds > 0) {
      const same = [...this.waiting.values()].find((waiting) => waiting.decision.url === decision.url && waiting.decision.action === decision.action)
      if (same) {
        await this.brain.action_result(decision.request_id, "declined", "the same action already waits for its undo time")
        return
      }
      const timer = setTimeout(() => this.run_waiting(decision.request_id), decision.undo_seconds * 1000)
      this.waiting.set(decision.request_id, { decision, timer })
      this.hooks.notify(`${decision.label} in ${decision.undo_seconds} s: ${decision.title}`, undefined, { label: "Undo", command: { type: "undo_action", request_id: decision.request_id } }, tag_of(decision))
      return
    }
    await this.execute(decision)
  }

  // An allowed action an agent's plan proposed, already through the gate: it waits its turn on the confirm sheet.
  offer(decision: ActionDecision): void {
    if (!decision.allowed || !decision.confirm || this.offered.has(decision.request_id)) return
    this.offered.add(decision.request_id)
    if (this.pending) this.queued.push(decision)
    else this.pending = decision
    this.hooks.changed()
  }

  async confirm(request_id: string): Promise<void> {
    const decision = this.pending
    if (!decision || decision.request_id !== request_id) return
    this.next()
    // An agent's action runs only while its plan still stands: not after you stopped it or it expired.
    if (decision.origin === "plan" && !(await this.brain.pending_actions()).some((waiting) => waiting.request_id === request_id)) {
      this.hooks.notify(`${decision.label} was withdrawn: the agent that proposed it was stopped or its plan expired.`)
      return
    }
    await this.execute(decision)
  }

  // Agent actions no longer waiting (their plan stopped or expired) leave the sheet and its queue.
  withdraw(request_ids: string[]): void {
    const gone = new Set(request_ids)
    const kept = this.queued.filter((decision) => !gone.has(decision.request_id))
    const changed = kept.length !== this.queued.length || (this.pending !== null && gone.has(this.pending.request_id))
    this.queued.splice(0, this.queued.length, ...kept)
    if (this.pending && gone.has(this.pending.request_id)) this.pending = this.queued.shift() ?? null
    if (changed) this.hooks.changed()
  }

  async decline(request_id: string): Promise<void> {
    if (!this.pending || this.pending.request_id !== request_id) return
    this.next()
    await this.brain.action_result(request_id, "declined")
  }

  private next(): void {
    this.pending = this.queued.shift() ?? null
    this.hooks.changed()
  }

  async undo(request_id: string): Promise<void> {
    const waiting = this.waiting.get(request_id)
    if (!waiting) return
    clearTimeout(waiting.timer)
    this.waiting.delete(request_id)
    this.hooks.retract(tag_of(waiting.decision))
    await this.brain.action_result(request_id, "undone")
  }

  private run_waiting(request_id: string): void {
    const waiting = this.waiting.get(request_id)
    if (!waiting) return
    this.waiting.delete(request_id)
    this.hooks.retract(tag_of(waiting.decision))
    this.execute(waiting.decision).catch((error) => this.hooks.notify(`${waiting.decision.label} failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  private async execute(decision: ActionDecision): Promise<void> {
    let outcome: Outcome
    try {
      outcome = await perform(await this.hooks.open_page(decision.url), decision)
    } catch (error) {
      outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
    const result = await this.brain.action_result(decision.request_id, outcome.ok ? "done" : "failed", outcome.detail)
    if (result.item) this.hooks.item_changed(result.item)
    this.hooks.notify(outcome.ok ? `${decision.label} done on ${decision.site}: ${decision.title}` : `${decision.label} did not work on ${decision.site}: ${outcome.detail}`)
  }
}

function tag_of(decision: ActionDecision): string {
  return `action:${decision.request_id}`
}
