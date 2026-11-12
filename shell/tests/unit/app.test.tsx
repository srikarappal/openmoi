import { act } from "react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import type { ChatEntry, ShellCommand, ShellState } from "../../src/shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BASE: ShellState = {
  views: [
    { view_id: "feed", title: "Feed" },
    { view_id: "tech", title: "Tech" },
  ],
  tabs: [],
  active: { kind: "view", view_id: "feed" },
  address: "",
  notices: [],
  chat: [],
  chat_view: "Feed",
  thinking: false,
  activities: [],
  chrome_pages: [],
  relay: { connected: false, waiting_for_approval: null, paired: false },
  gate: null,
  stop: null,
  player: null,
  omnibox: null,
  confirm: null,
}

// The preload bridge as the UI sees it: commands are recorded, states are pushed by the test.
class FakeBridge {
  readonly sent: ShellCommand[] = []
  listener: (state: ShellState) => void = () => {}
  resolve_state: (state: ShellState) => void = () => {}

  command(command: ShellCommand): void {
    this.sent.push(command)
  }

  get_state(): Promise<ShellState> {
    return new Promise((resolve) => (this.resolve_state = resolve))
  }

  on_state(listener: (state: ShellState) => void): void {
    this.listener = listener
  }
}

const bridge = new FakeBridge()

async function show(fields: Partial<ShellState>): Promise<void> {
  await act(async () => bridge.listener({ ...BASE, ...fields }))
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("nothing to click")
  await act(async () => (element as HTMLElement).click())
}

async function type_into(input: Element | null, value: string): Promise<void> {
  const field = input as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function submit(form: Element | null): Promise<void> {
  await act(async () => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
}

function last_sent(): ShellCommand | undefined {
  return bridge.sent.at(-1)
}

function query(selector: string): Element | null {
  return document.querySelector(selector)
}

function texts(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector), (node) => node.textContent ?? "")
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  Object.assign(window, { shell: bridge })
  await act(async () => {
    await import("../../src/ui/app")
  })
})

describe("the openMoi window", () => {
  it("says it is starting until the first state arrives", async () => {
    expect(query(".loading")?.textContent).toBe("Starting openMoi")
    await act(async () => bridge.resolve_state(BASE))
    expect(texts("button.tab.view")).toEqual(["Feed", "Tech"])
  })

  it("shows view tabs, Chrome's state and Refresh", async () => {
    await show({})
    expect(query("button.tab.view.active")?.textContent).toBe("Feed")
    expect(query(".relay")?.textContent).toBe("Chrome not connected")
    await click(document.querySelectorAll("button.tab.view")[1])
    expect(last_sent()).toEqual({ type: "open_view", view_id: "tech" })
    await click(Array.from(document.querySelectorAll("button.action")).find((node) => node.textContent === "Refresh") ?? null)
    expect(last_sent()).toEqual({ type: "refresh" })
    await show({ relay: { connected: false, waiting_for_approval: "abc", paired: false } })
    expect(query(".relay")?.textContent).toBe("Chrome waiting")
    await show({ relay: { connected: false, waiting_for_approval: null, paired: true, unrecognized: "abc" } })
    expect(query(".relay")?.textContent).toBe("Chrome: pair again")
    await show({ relay: { connected: true, waiting_for_approval: null, paired: true } })
    expect(query(".relay.on")?.textContent).toBe("Chrome connected")
  })

  it("shows web tabs and Chrome pages, with Mine on the active tab", async () => {
    await show({
      tabs: [{ tab_id: 3, title: "", url: "https://shop.example.com/", mine: true }],
      chrome_pages: [{ page_id: 1, title: "News", url: "https://news.example.com/" }],
      active: { kind: "tab", tab_id: 3 },
      address: "https://shop.example.com/",
    })
    expect(texts(".tab.web .tab_title")).toEqual(["https://shop.example.com/"])
    expect(texts(".tab.chrome .tab_title")).toEqual(["Mine: News"])
    await click(query(".tab.web .tab_title"))
    expect(last_sent()).toEqual({ type: "select_tab", tab_id: 3 })
    await click(query(".tab.web .close"))
    expect(last_sent()).toEqual({ type: "close_tab", tab_id: 3 })
    await click(query(".tab.chrome .tab_title"))
    expect(last_sent()).toEqual({ type: "select_chrome_page", page_id: 1 })
    await click(query(".tab.chrome .close"))
    expect(last_sent()).toEqual({ type: "close_chrome_page", page_id: 1 })
    expect(query("button.mine.on")?.textContent).toBe("Mine")
    await click(query("button.mine"))
    expect(last_sent()).toEqual({ type: "toggle_mine" })
    expect((query(".address input") as HTMLInputElement).value).toBe("https://shop.example.com/")
    await show({})
    expect(query("button.mine")).toBeNull()
  })

  it("navigates to what you type in the address bar and ignores blanks", async () => {
    await show({})
    const sent = bridge.sent.length
    await type_into(query(".address input"), "   ")
    await submit(query("form.address"))
    expect(bridge.sent).toHaveLength(sent)
    await type_into(query(".address input"), "  example.com  ")
    await submit(query("form.address"))
    expect(last_sent()).toEqual({ type: "navigate", url: "example.com" })
  })

  it("shows notices with their actions", async () => {
    await show({
      notices: [
        { notice_id: 1, text: "x needs you in Chrome", url: "https://x.com/login" },
        { notice_id: 2, text: "A Chrome extension wants to read pages", action: { label: "Allow", command: { type: "relay_trust", extension_id: "abc" } } },
      ],
    })
    expect(texts(".notice > span:first-child")).toEqual(["x needs you in Chrome", "A Chrome extension wants to read pages"])
    const [first, second] = Array.from(document.querySelectorAll(".notice"))
    expect(Array.from(first.querySelectorAll("button"), (button) => button.textContent)).toEqual(["Open", "Dismiss"])
    await click(first.querySelector("button"))
    expect(last_sent()).toEqual({ type: "open_notice", notice_id: 1 })
    await click(second.querySelector("button"))
    expect(last_sent()).toEqual({ type: "relay_trust", extension_id: "abc" })
    await click(Array.from(second.querySelectorAll("button")).at(-1) ?? null)
    expect(last_sent()).toEqual({ type: "dismiss_notice", notice_id: 2 })
  })

  it("says Idle, or what is running and for how long", async () => {
    await show({})
    expect(query(".status.idle")?.textContent).toBe("Idle")
    await show({ activities: [{ activity_id: 1, label: "Designing a new look for feed, usually under a minute", started_at: Date.now() - 12_000 }] })
    expect(texts(".activity_label")).toEqual(["Designing a new look for feed, usually under a minute"])
    expect(query(".elapsed")?.textContent).toBe("12 s")
  })
})

describe("the chat", () => {
  const PENDING: ChatEntry = {
    entry_id: 2,
    role: "moi",
    text: "Added a rule.",
    status: "pending",
    proposal: { proposal_id: "p1", view_id: "feed", lens_action: null, reply: "Added a rule.", changes: [{ file: "views/feed.md", diff: "--- a/views/feed.md\n+++ b/views/feed.md\n@@ -1 +1 @@\n ## Rules\n-* old\n+* No shorts.\n" }] },
  }

  it("shows messages, diffs and Confirm or Discard for a pending proposal", async () => {
    await show({ chat: [{ entry_id: 1, role: "you", text: "no shorts" }, PENDING], chat_view: "Tech" })
    expect(texts(".message .message_text")).toEqual(["no shorts", "Added a rule."])
    expect(texts(".diff_file")).toEqual(["views/feed.md"])
    expect(Array.from(document.querySelectorAll(".diff > div:not(.diff_file)"), (line) => `${line.className}:${line.textContent}`)).toEqual([
      "same: ## Rules",
      "remove:-* old",
      "add:+* No shorts.",
      "same: ",
    ])
    expect(query(".chat_view")?.textContent).toBe("Changes apply to Tech")
    await show({ chat: [{ entry_id: 3, role: "moi", text: "Found: https://news.example/1 and more" }], chat_view: "Tech" })
    expect(texts(".message .message_text")).toEqual(["Found: https://news.example/1 and more"])
    await click(query(".message_text a"))
    expect(last_sent()).toEqual({ type: "open_link", url: "https://news.example/1" })
    await show({ chat: [{ entry_id: 1, role: "you", text: "no shorts" }, PENDING], chat_view: "Tech" })
    await click(query(".proposal_actions .confirm"))
    expect(last_sent()).toEqual({ type: "proposal_apply", proposal_id: "p1" })
    await click(document.querySelectorAll(".proposal_actions button")[1])
    expect(last_sent()).toEqual({ type: "proposal_discard", proposal_id: "p1" })
  })

  it("shows what became of a proposal and a rollback", async () => {
    const rollback = { ...PENDING, entry_id: 3, status: "applied" as const, proposal: { ...PENDING.proposal!, changes: [], lens_action: "rollback" as const } }
    await show({ chat: [rollback], thinking: true })
    expect(query(".lens_action")?.textContent).toBe("Bring back the previous look")
    expect(query(".proposal_status.applied")?.textContent).toBe("applied")
    expect(query(".message.thinking")?.textContent).toBe("Thinking")
  })

  it("sends what you type, offers commands as you type a slash and fills one in when picked", async () => {
    await show({})
    const input = query(".composer input")
    await type_into(input, "/me")
    expect(texts(".hint .hint_usage")).toEqual(["/memory <what to remember or forget>"])
    const sent_before_pick = bridge.sent.length
    await click(query(".hint"))
    expect((input as HTMLInputElement).value).toBe("/memory ")
    expect(bridge.sent).toHaveLength(sent_before_pick)
    expect(texts(".hint .hint_usage")).toEqual(["/memory <what to remember or forget>"])
    await type_into(input, "/memory I")
    expect(query(".hints")).toBeNull()
    const sent = bridge.sent.length
    await type_into(input, "   ")
    await submit(query("form.composer"))
    expect(bridge.sent).toHaveLength(sent)
    await type_into(input, "  /memory I'm vegetarian ")
    await submit(query("form.composer"))
    expect(last_sent()).toEqual({ type: "chat_send", text: "/memory I'm vegetarian" })
    expect((input as HTMLInputElement).value).toBe("")
  })

  it("follows new messages to the bottom", async () => {
    const list = query(".messages") as HTMLDivElement
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 900 })
    await show({ chat: [{ entry_id: 1, role: "you", text: "one" }, { entry_id: 2, role: "moi", text: "two" }, { entry_id: 3, role: "moi", text: "three" }] })
    expect(list.scrollTop).toBe(900)
    const full = Array.from({ length: 60 }, (_, index) => ({ entry_id: 100 + index, role: "moi" as const, text: `line ${index}` }))
    await show({ chat: full })
    list.scrollTop = 0
    await show({ chat: [...full.slice(1), { entry_id: 200, role: "moi", text: "New look for feed is live" }] })
    expect(list.scrollTop).toBe(900)
  })
})

describe("App gate and stop screen", () => {
  it("asks why you are here and opens what you pick", async () => {
    await show({
      gate: [
        { view_id: "break", title: "Break", visit_minutes: 5, next_edition: null },
        { view_id: "feed", title: "Feed", visit_minutes: null, next_edition: "2026-11-10T18:00:00Z" },
        { view_id: "tech", title: "Tech", visit_minutes: null, next_edition: null },
      ],
    })
    expect(query(".gate h1")?.textContent).toBe("Why are you here?")
    expect(texts(".choice .choice_title")).toEqual(["Break", "Feed", "Tech"])
    expect(texts(".choice .choice_note")[0]).toBe("5 minute visit")
    expect(texts(".choice .choice_note")[1]).toMatch(/^next edition /)
    expect(texts(".choice .choice_note")).toHaveLength(2)
    await click(document.querySelectorAll(".choice")[0])
    expect(last_sent()).toEqual({ type: "choose_view", view_id: "break" })
  })

  it("shows what you read when a visit ends and offers more time or done", async () => {
    await show({ stop: { view_id: "feed", title: "Feed", minutes: 10, read: ["First story", "Second story"], next_edition: "2026-11-10T18:00:00Z" }, gate: [] })
    expect(query(".stop h1")?.textContent).toBe("Your 10 minutes in Feed are up.")
    expect(texts(".read li")).toEqual(["First story", "Second story"])
    expect(query(".stop .next")?.textContent).toMatch(/^The next edition comes out at /)
    expect(query(".gate")).toBeNull()
    await click(query(".stop_actions .primary"))
    expect(last_sent()).toEqual({ type: "end_visit" })
    await click(document.querySelectorAll(".stop_actions button")[1])
    expect(last_sent()).toEqual({ type: "extend_visit" })
    await show({ stop: { view_id: "feed", title: "Feed", minutes: 1, read: [], next_edition: null } })
    expect(query(".stop h1")?.textContent).toBe("Your 1 minute in Feed is up.")
    expect(query(".stop p")?.textContent).toBe("You did not stop on anything this time.")
    expect(query(".stop .next")).toBeNull()
    await show({ stop: null, gate: null })
    expect(query(".content")).toBeNull()
  })
})

// A drop event carrying files, as the browser makes one.
function drop_event(type: string, files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: { files } })
  return event
}

describe("App dropping a view file", () => {
  it("imports a dropped view file and ignores anything else", async () => {
    await show({})
    const chat = query(".chat") as HTMLElement
    await act(async () => chat.dispatchEvent(drop_event("dragover", [])))
    expect(chat.className).toBe("chat dragging")
    expect(query(".drop_hint")?.textContent).toBe("Drop a view file, or a data export from Facebook or Amazon")
    await act(async () => chat.dispatchEvent(drop_event("dragleave", [])))
    expect(chat.className).toBe("chat")
    const sent = bridge.sent.length
    await act(async () => chat.dispatchEvent(drop_event("drop", [new File(["binary"], "photo.png")])))
    await act(async () => chat.dispatchEvent(drop_event("drop", [new File(["x".repeat(200_001)], "huge.md")])))
    await act(async () => chat.dispatchEvent(drop_event("drop", [])))
    expect(bridge.sent).toHaveLength(sent)
    await act(async () => chat.dispatchEvent(drop_event("drop", [new File(["# AI news"], "ai.md")])))
    await vi.waitFor(() => expect(last_sent()).toEqual({ type: "import_view", name: "ai.md", text: "# AI news" }))
    await act(async () => chat.dispatchEvent(drop_event("drop", [new File(["[]"], "your_posts_1.json")])))
    await vi.waitFor(() => expect(last_sent()).toEqual({ type: "import_history", name: "your_posts_1.json", text: "[]" }))
  })
})

describe("the player bar", () => {
  it("shows what plays, opens it on YouTube or closes it", async () => {
    await show({ player: { item_id: "v1", title: "Why the sky is blue", url: "https://www.youtube.com/watch?v=VIDEO00001A" } })
    expect(texts(".player_title")).toEqual(["Playing: Why the sky is blue"])
    await click(document.querySelectorAll(".player_bar button")[0])
    expect(last_sent()).toEqual({ type: "open_link", url: "https://www.youtube.com/watch?v=VIDEO00001A" })
    await click(query(".close_player"))
    expect(last_sent()).toEqual({ type: "close_player" })
    await show({ player: null })
    expect(query(".player_bar")).toBeNull()
  })
})

describe("the omnibox", () => {
  it("searches your own reality as you type, after a pause, and opens what you pick", async () => {
    vi.useFakeTimers()
    try {
      await show({})
      await type_into(query(".address input"), "lith")
      await type_into(query(".address input"), "lithium")
      expect(bridge.sent.filter((command) => command.type === "omnibox")).toEqual([])
      await act(async () => vi.advanceTimersByTime(250))
      expect(bridge.sent.filter((command) => command.type === "omnibox")).toEqual([{ type: "omnibox", text: "lithium" }])
    } finally {
      vi.useRealTimers()
    }
    await show({
      omnibox: {
        query: "lithium",
        hits: [
          { label: "Lithium", detail: "your view", target: { kind: "view", view_id: "lithium" } },
          { label: "Lithium recycling", detail: "rss:blog · 2026-11-10", target: { kind: "link", url: "https://blog.example/1" } },
        ],
      },
    })
    expect(texts(".omni_label")).toEqual(["Lithium", "Lithium recycling"])
    await click(document.querySelectorAll(".omni_hit")[1])
    expect(bridge.sent.slice(-2)).toEqual([{ type: "open_link", url: "https://blog.example/1" }, { type: "omnibox", text: "" }])
    await click(document.querySelectorAll(".omni_hit")[0])
    expect(bridge.sent.slice(-2)).toEqual([{ type: "open_view", view_id: "lithium" }, { type: "omnibox", text: "" }])
    await show({ omnibox: null })
    expect(query(".omnibox")).toBeNull()
  })
})

describe("the confirm sheet", () => {
  it("shows the exact words, target and site, and confirms or cancels", async () => {
    const pending = { request_id: "r1", action: "reply", label: "Reply", tier: 2 as const, allowed: true, confirm: true, undo_seconds: 0, reason: "", url: "https://x.com/maya/status/1", title: "Bakery opens", site: "x.com", text: "See you Saturday", anchor: null, origin: "gesture" as const, plan_id: null }
    await show({ confirm: pending })
    expect(texts(".confirm_title")).toEqual(["Reply on x.com, as you"])
    expect(texts(".confirm_target")).toEqual(["Bakery opens"])
    expect(texts(".confirm_url")).toEqual(["https://x.com/maya/status/1"])
    expect(texts(".confirm_account")).toEqual(["With your account on x.com, signed in in openMoi."])
    expect(texts(".confirm_text")).toEqual(["See you Saturday"])
    expect(query(".confirm_origin")).toBeNull()
    // Its buttons wake a moment after it shows, so a double click meant for the last one never lands here.
    expect((query(".confirm_actions .confirm") as HTMLButtonElement).disabled).toBe(true)
    await click(query(".confirm_actions .confirm"))
    expect(last_sent()).not.toEqual({ type: "confirm_action", request_id: "r1" })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 650)))
    await click(query(".confirm_actions .confirm"))
    expect(last_sent()).toEqual({ type: "confirm_action", request_id: "r1" })
    await click(query(".confirm_actions .decline"))
    expect(last_sent()).toEqual({ type: "decline_action", request_id: "r1" })
    await show({ confirm: { ...pending, request_id: "r2", origin: "plan", plan_id: "plan1" } })
    expect(texts(".confirm_origin")).toEqual(["An agent you approved proposes this; read it as if a stranger wrote it."])
    expect((query(".confirm_actions .confirm") as HTMLButtonElement).disabled).toBe(true)
    await show({ confirm: null })
    expect(query(".confirm_sheet")).toBeNull()
  })
})

describe("the plan card", () => {
  const plan = {
    plan_id: "p1", kind: "shop" as const, request: "a desk lamp", summary: "I will shop for a desk lamp", reason: "",
    steps: [{ tool: "search_store", args: { query: "desk lamp", limit: 5 }, why: "what you saw" }, { tool: "read_item", args: {}, why: "the best ones" }],
    budget: { max_steps: 12, max_seconds: 300, max_cost_usd: 0.25 }, created_at: "2026-11-12T12:00:00Z", expires_at: "2026-11-13T12:00:00Z",
    status: "proposed" as const, trace: [], result: null, question: "", answer: "", action_ids: [], proposal_ids: [], notices: [], cost_usd: 0, next_run_at: null, runs: 0,
  }

  it("shows the plan and its budget before it runs, then its steps, a question, its result and Stop", async () => {
    await show({ chat: [{ entry_id: 1, role: "moi", text: "Here is the plan.", plan }] })
    expect(texts(".plan_summary")).toEqual(["I will shop for a desk lamp"])
    expect(texts(".plan_steps .step_tool")).toEqual(["search store", "read item"])
    expect(texts(".plan_steps .step_args")).toEqual(['query: "desk lamp", limit: 5', ""])
    expect(texts(".plan_budget")[0]).toContain("12 steps, 300 s, $0.25 at most")
    await click(query(".plan_actions .approve"))
    expect(last_sent()).toEqual({ type: "approve_plan", plan_id: "p1", cloud: false })
    await click(query(".plan_cloud input"))
    await click(query(".plan_actions .approve"))
    expect(last_sent()).toEqual({ type: "approve_plan", plan_id: "p1", cloud: true })
    await click(query(".plan_actions .decline"))
    expect(last_sent()).toEqual({ type: "decline_plan", plan_id: "p1" })
    const paused = { ...plan, status: "paused" as const, question: "What is your budget?", trace: [{ step: 1, tool: "search_store", ok: true, outcome: "found 2 items", seconds: 0.1 }] }
    await show({ chat: [{ entry_id: 1, role: "moi", text: "Here is the plan.", plan: paused }] })
    expect(texts(".plan_steps .step_outcome")).toEqual([" : found 2 items"])
    await type_into(query(".plan_answer input"), "Under $50")
    await submit(query(".plan_answer"))
    expect(last_sent()).toEqual({ type: "answer_plan", plan_id: "p1", answer: "Under $50" })
    await click(query(".plan_actions .stop"))
    expect(last_sent()).toEqual({ type: "stop_plan", plan_id: "p1" })
    const done = { ...paused, status: "done" as const, result: { answer: "The lamp [1].", citations: [{ number: 1, item_id: "i1", title: "Lamp", url: "https://a.example/1" }], shortlist: [{ item_id: "i1", title: "Lamp", url: "https://a.example/1", why: "It fits." }] } }
    await show({ chat: [{ entry_id: 1, role: "moi", text: "Here is the plan.", plan: done }] })
    expect(texts(".result_answer")).toEqual(["The lamp [1]."])
    expect(texts(".result_pick")).toEqual(["Lamp: It fits. https://a.example/1"])
    expect(query(".plan_actions .stop")).toBeNull()
    await click(query(".result_pick a"))
    expect(last_sent()).toEqual({ type: "open_link", url: "https://a.example/1" })
  })
})
