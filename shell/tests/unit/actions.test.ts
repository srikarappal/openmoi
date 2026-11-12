import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ActionController, perform, type ActionPage, type Point } from "../../src/main/actions"
import type { BrainClient } from "../../src/main/brain"
import type { ActionDecision, Item } from "../../src/shared/types"

const ITEM = { item_id: "i1", url: "https://x.com/maya/status/1", title: "Bakery opens" } as Item

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
    anchor: { select: "[data-testid='like']", active_state: "[data-testid='unlike']", changed: null, input: null, submit: null },
    ...fields,
  }
}

// A page that answers selectors from a script of what it shows, and records clicks and typing.
class FakePage implements ActionPage {
  readonly clicks: Point[] = []
  readonly typed: string[] = []
  shown = new Set<string>()
  texts = new Map<string, string>()
  body = ""
  on_click: (point: Point) => void = () => {}

  async run<T>(script: string): Promise<T> {
    const selector = /querySelector\(("(?:[^"\\]|\\.)*")\)/.exec(script)
    if (script === "document.body.innerText") return this.body as T
    const wanted = selector ? (JSON.parse(selector[1]) as string) : ""
    if (script.includes("textContent")) return (this.texts.get(wanted) ?? null) as T
    return (this.shown.has(wanted) ? { x: 10, y: 20 } : null) as T
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
    expect(await missing).toEqual({ ok: false, detail: "the Like button was not on the page" })
    const page = new FakePage()
    page.shown.add("[data-testid='like']")
    const unseen = perform(page, decision())
    await vi.advanceTimersByTimeAsync(7_000)
    expect(await unseen).toEqual({ ok: false, detail: "the page did not show it worked" })
  })

  it("writes a reply in its box, sends it and finds your words on the page", async () => {
    const page = new FakePage()
    for (const selector of ["[data-testid='reply']", "[data-testid='box']", "[data-testid='send']"]) page.shown.add(selector)
    page.on_click = () => {
      if (page.typed.length) page.body = `Thread\n${page.typed[0]}`
    }
    const reply = decision({ action: "reply", label: "Reply", tier: 2, text: "See you Saturday", anchor: { select: "[data-testid='reply']", active_state: null, changed: null, input: "[data-testid='box']", submit: "[data-testid='send']" } })
    expect(await perform(page, reply)).toEqual({ ok: true, detail: "your words are on the page" })
    expect(page.clicks).toHaveLength(3)
    expect(page.typed).toEqual(["See you Saturday"])
  })

  it("checks a cart by its count changing", async () => {
    const page = new FakePage()
    page.shown.add("#add-to-cart-button")
    page.texts.set("#nav-cart-count", "0")
    page.on_click = () => page.texts.set("#nav-cart-count", "1")
    const cart = decision({ action: "add_to_cart", label: "Add to cart", tier: 2, anchor: { select: "#add-to-cart-button", active_state: null, changed: "#nav-cart-count", input: null, submit: null } })
    expect(await perform(page, cart)).toEqual({ ok: true, detail: "the page changed" })
    expect(await perform(page, { ...cart, anchor: null })).toEqual({ ok: false, detail: "no control to use" })
  })
})

function make_controller(answer: ActionDecision) {
  const page = new FakePage()
  page.shown.add("[data-testid='like']")
  page.on_click = () => page.shown.add("[data-testid='unlike']")
  const brain = {
    check_action: vi.fn(async () => answer),
    action_result: vi.fn(async () => ({ recorded: true, item: { ...ITEM, extra: { "acted:like": "yes" } } })),
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

  it("a second action for the sheet declines the one waiting there", async () => {
    const { controller, brain } = make_controller(decision({ confirm: true, tier: 2 }))
    await controller.request(ITEM, "reply", "a")
    brain.check_action.mockResolvedValueOnce(decision({ request_id: "r2", confirm: true, tier: 2 }))
    await controller.request(ITEM, "reply", "b")
    expect(brain.action_result).toHaveBeenCalledWith("r1", "declined", "another action came to the confirm sheet")
    expect(controller.pending?.request_id).toBe("r2")
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
