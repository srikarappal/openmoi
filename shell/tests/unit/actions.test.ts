import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ActionController, perform, type ActionPage, type Point } from "../../src/main/actions"
import type { BrainClient } from "../../src/main/brain"
import type { ActionDecision, Item } from "../../src/shared/types"

const ITEM = { item_id: "i1", url: "https://x.com/maya/status/1", title: "Bakery opens" } as Item
const FOCAL = "article[tabindex='-1']"

function decision(fields: Partial<ActionDecision> = {}): ActionDecision {
  return {
    request_id: "r1",
    action: "like",
    label: "Like",
    tier: 1,
    allowed: true,
    confirm: false,
    undo_seconds: 0,
    reason: "",
    url: ITEM.url,
    title: "Bakery opens",
    site: "x.com",
    text: "",
    anchor: { within: FOCAL, select: "[data-testid='like']", active_state: "[data-testid='unlike']", changed: null, input: null, submit: null },
    origin: "gesture",
    plan_id: null,
    ...fields,
  }
}

// A page that answers the executor's scripts from what it shows, and records clicks and typing. Each script is a
// function called with one JSON argument, which the page reads back.
class FakePage implements ActionPage {
  readonly clicks: Point[] = []
  readonly typed: string[] = []
  address = ITEM.url
  shown = new Set<string>()
  // How many times a selector matches, when not once.
  counts = new Map<string, number>()
  // How many times the item's own part of the page matches, when not once.
  roots = new Map<string, number>()
  texts = new Map<string, string>()
  body = ""
  box = ""
  on_click: (point: Point) => void = () => {}

  url(): string {
    return this.address
  }

  async run<T>(script: string): Promise<T> {
    const args = JSON.parse(script.slice(script.lastIndexOf(")({") + 2, -1)) as { within?: string | null; select?: string; input?: string; text?: string }
    if (script.includes("scrollIntoView")) {
      const roots = args.within ? (this.roots.get(args.within) ?? 1) : 1
      if (roots !== 1) return { count: 0, roots } as T
      const count = this.counts.get(args.select ?? "") ?? (this.shown.has(args.select ?? "") ? 1 : 0)
      return (count === 1 ? { count, roots, x: 10, y: 20 } : { count, roots }) as T
    }
    if (script.includes("textContent")) return (this.texts.get(args.select ?? "") ?? null) as T
    if (script.includes("innerText")) return (this.body.includes(args.text ?? "") && !this.box.includes(args.text ?? "")) as T
    return true as T
  }

  click(point: Point): void {
    this.clicks.push(point)
    this.on_click(point)
  }

  async type(text: string): Promise<void> {
    this.typed.push(text)
  }
}

describe("perform", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("clicks the control and checks the page shows it worked", async () => {
    const page = new FakePage()
    page.shown.add("[data-testid='like']")
    page.on_click = () => page.shown.add("[data-testid='unlike']")
    expect(await perform(page, decision())).toEqual({ ok: true, detail: "the page shows it" })
    expect(page.clicks).toEqual([{ x: 10, y: 20 }])
  })

  it("fails when the control never shows or the page never changes", async () => {
    const missing = perform(new FakePage(), decision())
    await vi.advanceTimersByTimeAsync(11_000)
    expect(await missing).toEqual({ ok: false, detail: "the Like button: it was not on the page" })
    const page = new FakePage()
    page.shown.add("[data-testid='like']")
    const unseen = perform(page, decision())
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await unseen).toEqual({ ok: false, detail: "the page did not show it worked" })
  })

  const REPLY = { within: FOCAL, select: "[data-testid='reply']", active_state: null, changed: null, input: "[data-testid='box']", submit: "[data-testid='send']" }

  it("writes a reply in its box, sends it and finds your words on the page, out of the box", async () => {
    const page = new FakePage()
    for (const selector of ["[data-testid='reply']", "[data-testid='box']", "[data-testid='send']"]) page.shown.add(selector)
    page.on_click = () => {
      if (page.typed.length) page.body = `Thread\n${page.typed[0]}`
    }
    const reply = decision({ action: "reply", label: "Reply", tier: 2, text: "See you Saturday", anchor: REPLY })
    expect(await perform(page, reply)).toEqual({ ok: true, detail: "your words are on the page" })
    expect(page.clicks).toHaveLength(3)
    expect(page.typed).toEqual(["See you Saturday"])
  })

  it("a reply still in its box was not sent", async () => {
    const page = new FakePage()
    for (const selector of ["[data-testid='reply']", "[data-testid='box']", "[data-testid='send']"]) page.shown.add(selector)
    page.on_click = () => {
      if (page.typed.length) page.body = page.box = page.typed[0]
    }
    const running = perform(page, decision({ action: "reply", label: "Reply", tier: 2, text: "See you Saturday", anchor: REPLY }))
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await running).toEqual({ ok: false, detail: "your words were not sent" })
  })

  it("checks a cart by its count changing, and finds the count before it clicks", async () => {
    const page = new FakePage()
    page.shown.add("#add-to-cart-button")
    page.shown.add("#nav-cart-count")
    page.texts.set("#nav-cart-count", "0")
    page.on_click = () => page.texts.set("#nav-cart-count", "1")
    const cart = decision({ action: "add_to_cart", label: "Add to cart", tier: 2, anchor: { within: null, select: "#add-to-cart-button", active_state: null, changed: "#nav-cart-count", input: null, submit: null } })
    expect(await perform(page, cart)).toEqual({ ok: true, detail: "the page changed" })
    expect(await perform(page, { ...cart, anchor: null })).toEqual({ ok: false, detail: "no control to use" })
    const countless = new FakePage()
    countless.shown.add("#add-to-cart-button")
    const running = perform(countless, cart)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(await running).toEqual({ ok: false, detail: "what shows it worked: it was not on the page" })
    expect(countless.clicks).toEqual([])
  })

  it("acts only on the site the gate allowed", async () => {
    const page = new FakePage()
    page.shown.add("[data-testid='like']")
    page.address = "https://evil.example/x.com/maya"
    expect(await perform(page, decision())).toEqual({ ok: false, detail: "the page went to evil.example, not x.com" })
    page.address = "about:blank"
    expect((await perform(page, decision())).detail).toBe("the page went to an unknown address, not x.com")
    page.address = "https://www.x.com/maya/status/1"
    page.on_click = () => page.shown.add("[data-testid='unlike']")
    expect(await perform(page, decision())).toEqual({ ok: true, detail: "the page shows it" })
    expect(page.clicks).toHaveLength(1)
  })

  it("does not click what the page shows done already, so a like is never turned into an unlike", async () => {
    const page = new FakePage()
    page.shown.add("[data-testid='like']")
    page.shown.add("[data-testid='unlike']")
    expect(await perform(page, decision())).toEqual({ ok: false, detail: "the page shows it done already" })
    expect(page.clicks).toEqual([])
  })

  it("refuses when it cannot tell which item or which control is yours", async () => {
    const twice = new FakePage()
    twice.shown.add("[data-testid='like']")
    twice.roots.set(FOCAL, 2)
    expect(await perform(twice, decision())).toEqual({ ok: false, detail: "the Like button: the page holds more than one such item, so openMoi cannot tell which is yours" })
    const two_buttons = new FakePage()
    two_buttons.counts.set("[data-testid='like']", 2)
    expect(await perform(two_buttons, decision())).toEqual({ ok: false, detail: "the Like button: more than one control matched" })
    expect([...twice.clicks, ...two_buttons.clicks]).toEqual([])
  })
})

function make_controller(answer: ActionDecision) {
  const page = new FakePage()
  page.shown.add("[data-testid='like']")
  page.on_click = () => page.shown.add("[data-testid='unlike']")
  const brain = {
    check_action: vi.fn(async () => answer),
    action_result: vi.fn(async () => ({ recorded: true, item: { ...ITEM, extra: { "acted:like": "yes" } } })),
    pending_actions: vi.fn(async (): Promise<ActionDecision[]> => []),
  }
  const hooks = { open_page: vi.fn(async () => page), open_original: vi.fn(), notify: vi.fn(), retract: vi.fn(), changed: vi.fn(), item_changed: vi.fn() }
  return { controller: new ActionController(brain as unknown as BrainClient, hooks), brain, hooks, page }
}

describe("ActionController", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("waits five seconds for an undo before a like, then does it on the page", async () => {
    const { controller, brain, hooks, page } = make_controller(decision({ undo_seconds: 5 }))
    await controller.request(ITEM, "like", "")
    expect(brain.check_action).toHaveBeenCalledWith("i1", "like", "")
    expect(hooks.notify).toHaveBeenCalledWith("Like in 5 s: Bakery opens", undefined, { label: "Undo", command: { type: "undo_action", request_id: "r1" } }, "action:r1")
    expect(hooks.open_page).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(hooks.open_page).toHaveBeenCalledWith(ITEM.url)
    expect(page.clicks).toHaveLength(1)
    expect(brain.action_result).toHaveBeenCalledWith("r1", "done", "the page shows it")
    expect(hooks.item_changed).toHaveBeenCalled()
    expect(hooks.notify).toHaveBeenLastCalledWith("Like done on x.com: Bakery opens")
  })

  it("undone in time, the like never happens", async () => {
    const { controller, brain, hooks } = make_controller(decision({ undo_seconds: 5 }))
    await controller.request(ITEM, "like", "")
    await controller.undo("r1")
    await controller.undo("r1")
    await vi.advanceTimersByTimeAsync(6_000)
    expect(hooks.open_page).not.toHaveBeenCalled()
    expect(hooks.retract).toHaveBeenCalledWith("action:r1")
    expect(brain.action_result.mock.calls).toEqual([["r1", "undone"]])
  })

  it("puts what speaks for you on the confirm sheet, and does it only when you confirm", async () => {
    const reply = decision({ action: "reply", label: "Reply", tier: 2, confirm: true, text: "Hi" })
    const { controller, brain, hooks } = make_controller(reply)
    await controller.request(ITEM, "reply", "Hi")
    expect(controller.pending).toEqual(reply)
    expect(hooks.open_page).not.toHaveBeenCalled()
    await controller.confirm("other")
    expect(controller.pending).toEqual(reply)
    await controller.confirm("r1")
    expect(controller.pending).toBeNull()
    expect(hooks.open_page).toHaveBeenCalledTimes(1)
    await controller.request(ITEM, "reply", "Hi")
    await controller.decline("r1")
    expect(brain.action_result).toHaveBeenLastCalledWith("r1", "declined")
    expect(hooks.open_page).toHaveBeenCalledTimes(1)
  })

  it("the sheet never changes under you: a second action for it is refused while one waits there", async () => {
    const { controller, brain, hooks } = make_controller(decision({ confirm: true, tier: 2 }))
    await controller.request(ITEM, "reply", "a")
    brain.check_action.mockResolvedValueOnce(decision({ request_id: "r2", confirm: true, tier: 2 }))
    await controller.request(ITEM, "reply", "b")
    expect(brain.action_result.mock.calls).toEqual([["r2", "declined", "a confirm sheet was already open"]])
    expect(hooks.notify).toHaveBeenLastCalledWith("Finish the action waiting for your confirm first.")
    expect(controller.pending?.request_id).toBe("r1")
  })

  it("a second like for an item whose like waits for its undo time is ignored", async () => {
    const { controller, brain, hooks, page } = make_controller(decision({ undo_seconds: 5 }))
    await controller.request(ITEM, "like", "")
    brain.check_action.mockResolvedValueOnce(decision({ request_id: "r2", undo_seconds: 5 }))
    await controller.request(ITEM, "like", "")
    expect(brain.action_result).toHaveBeenCalledWith("r2", "declined", "the same action already waits for its undo time")
    expect(hooks.notify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(hooks.open_page).toHaveBeenCalledTimes(1)
    expect(page.clicks).toHaveLength(1)
  })

  it("says why the gate refused, and for money or the irreversible opens the page for you to do it", async () => {
    const { controller, hooks } = make_controller(decision({ allowed: false, reason: "Actions are off for blog.example." }))
    await controller.request(ITEM, "like", "")
    expect(hooks.notify).toHaveBeenCalledWith("Actions are off for blog.example.")
    expect(hooks.open_original).not.toHaveBeenCalled()
    const order = make_controller(decision({ allowed: false, tier: 3, reason: "openMoi never does this for you." }))
    await order.controller.request(ITEM, "place_order", "")
    expect(order.hooks.open_original).toHaveBeenCalledWith(ITEM.url)
    expect(order.hooks.open_page).not.toHaveBeenCalled()
  })

  it("reports an action that did not work, and one whose page would not open", async () => {
    const { controller, brain, hooks, page } = make_controller(decision())
    page.on_click = () => undefined
    const running = controller.request(ITEM, "like", "")
    await vi.advanceTimersByTimeAsync(7_000)
    await running
    expect(brain.action_result).toHaveBeenCalledWith("r1", "failed", "the page did not show it worked")
    expect(hooks.notify).toHaveBeenLastCalledWith("Like did not work on x.com: the page did not show it worked")
    hooks.open_page.mockRejectedValueOnce(new Error("no network"))
    await controller.request(ITEM, "like", "")
    expect(brain.action_result).toHaveBeenLastCalledWith("r1", "failed", "no network")
  })
})

describe("ActionController offers from agents", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("puts allowed actions an agent proposed on the confirm sheet one at a time, each once", async () => {
    const { controller, brain, hooks } = make_controller(decision())
    const first = decision({ request_id: "a1", confirm: true, tier: 1 })
    const second = decision({ request_id: "a2", confirm: true, tier: 2, action: "reply", label: "Reply", text: "Hi" })
    controller.offer(first)
    controller.offer(second)
    controller.offer(first)
    controller.offer(decision({ request_id: "a3", allowed: false, confirm: false }))
    expect(controller.pending?.request_id).toBe("a1")
    await controller.decline("a1")
    expect(controller.pending?.request_id).toBe("a2")
    expect(brain.action_result).toHaveBeenCalledWith("a1", "declined")
    hooks.open_page.mockResolvedValueOnce(Object.assign(new FakePage(), { body: "" }) as never)
    const confirming = controller.confirm("a2")
    await vi.advanceTimersByTimeAsync(20_000)
    await confirming
    expect(controller.pending).toBeNull()
  })

  it("runs an agent's action only while its plan still stands", async () => {
    const { controller, brain, hooks, page } = make_controller(decision())
    const planned = decision({ request_id: "p1", confirm: true, origin: "plan", plan_id: "plan1" })
    controller.offer(planned)
    await controller.confirm("p1")
    expect(hooks.open_page).not.toHaveBeenCalled()
    expect(hooks.notify).toHaveBeenLastCalledWith("Like was withdrawn: the agent that proposed it was stopped or its plan expired.")
    const still = decision({ request_id: "p2", confirm: true, origin: "plan", plan_id: "plan1" })
    brain.pending_actions.mockResolvedValueOnce([still])
    controller.offer(still)
    const confirming = controller.confirm("p2")
    await vi.advanceTimersByTimeAsync(7_000)
    await confirming
    expect(page.clicks).toHaveLength(1)
    expect(brain.action_result).toHaveBeenLastCalledWith("p2", "done", "the page shows it")
  })

  it("takes withdrawn agent actions off the sheet and out of its queue", () => {
    const { controller, hooks } = make_controller(decision())
    for (const request_id of ["a1", "a2", "a3"]) controller.offer(decision({ request_id, confirm: true, origin: "plan", plan_id: "plan1" }))
    hooks.changed.mockClear()
    controller.withdraw(["a1", "a2"])
    expect(controller.pending?.request_id).toBe("a3")
    controller.withdraw(["nothing"])
    expect(hooks.changed).toHaveBeenCalledTimes(1)
    controller.withdraw(["a3"])
    expect(controller.pending).toBeNull()
  })
})
