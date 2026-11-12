import { describe, expect, it, vi } from "vitest"
import { BrainError, type BrainClient } from "../../src/main/brain"
import { ChatController, explain } from "../../src/main/chat"
import type { ModelInfo, Overview, Proposal } from "../../src/shared/types"
import { Tracked } from "./tracked"

function proposal(fields: Partial<Proposal> = {}): Proposal {
  return { proposal_id: "p1", view_id: "feed", changes: [{ file: "views/feed.md", diff: "+* No shorts." }], lens_action: null, reply: "Added a rule.", ...fields }
}

const MODEL_INFO: ModelInfo = {
  fast: { provider: "openrouter", model: "nvidia/nemotron-3.5-super-vl:free", base_url: "https://openrouter.ai/api/v1", local: false, key_ready: true },
  smart: { provider: "ollama", model: "llama3", base_url: "http://127.0.0.1:11434/v1", local: true, key_ready: true },
  allow_content_to_hosted: false,
}

const OVERVIEW: Overview = {
  home: "/Users/me/openMoi",
  view_id: "feed",
  view_file: "views/feed.md",
  sections: { Sources: "* X home timeline", Rules: "", Layout: "" },
  memory: { "dislikes.md": "* crypto" },
  model: MODEL_INFO,
  relay: { connected: true },
}

function make_chat(brain: Partial<BrainClient>) {
  const { labels, track } = new Tracked()
  const hooks = {
    chat_view: () => "feed",
    on_applied: vi.fn(async () => {}),
    view_created: vi.fn(async () => {}),
    shopping: vi.fn(async () => {}),
    app_allowed: vi.fn(async () => {}),
    model_changed: vi.fn(),
    open_folder: vi.fn(),
    set_background: vi.fn((on: boolean) => (on ? "on now" : "off now")),
    show_file: vi.fn(),
    open_external: vi.fn(),
    track,
    changed: vi.fn(),
  }
  return { chat: new ChatController(brain as BrainClient, hooks), hooks, labels }
}

function last_reply(chat: ChatController): string {
  return chat.list().at(-1)?.text ?? ""
}

describe("ChatController", () => {
  it("turns a request into a pending proposal for the current view", async () => {
    const edit = vi.fn(async () => proposal())
    const { chat, hooks, labels } = make_chat({ edit })
    const sending = chat.send("no shorts")
    expect(chat.thinking).toBe(true)
    await sending
    expect(chat.thinking).toBe(false)
    expect(edit).toHaveBeenCalledWith("feed", "no shorts", undefined, "any")
    expect(labels).toEqual(["Asking the model about your request"])
    expect(chat.list().map((entry) => [entry.role, entry.text, entry.status])).toEqual([
      ["you", "no shorts", undefined],
      ["moi", "Added a rule.", "pending"],
    ])
    expect(hooks.changed).toHaveBeenCalled()
  })

  it("passes the item and view for less like this", async () => {
    const edit = vi.fn(async () => proposal())
    const { chat } = make_chat({ edit })
    await chat.send("Less like this: Bakery", "item7", "tech")
    expect(edit).toHaveBeenCalledWith("tech", "Less like this: Bakery", "item7", "any")
  })

  it("answers without a proposal when nothing changes", async () => {
    const { chat } = make_chat({ edit: async () => proposal({ changes: [], reply: "" }) })
    await chat.send("hello")
    expect(chat.list()[1]).toMatchObject({ role: "moi", text: "Nothing to change." })
    expect(chat.list()[1].proposal).toBeUndefined()
  })

  it("keeps a rollback proposal even without file changes", async () => {
    const { chat } = make_chat({ edit: async () => proposal({ changes: [], lens_action: "rollback", reply: "" }) })
    await chat.send("previous look")
    expect(chat.list()[1]).toMatchObject({ status: "pending", text: "Here is what I would change." })
  })

  it("explains failures in plain words", async () => {
    const { chat } = make_chat({ edit: async () => Promise.reject(new BrainError(409, "privacy", "blocked")) })
    await chat.send("no shorts")
    expect(chat.list()[1].text).toContain("/model privacy on")
    expect(chat.thinking).toBe(false)
  })

  it("applies once and tells the shell what changed", async () => {
    const apply_edit = vi.fn(async () => proposal())
    const { chat, hooks } = make_chat({ edit: async () => proposal(), apply_edit })
    await chat.send("no shorts")
    await chat.apply("p1")
    await chat.apply("p1")
    expect(apply_edit).toHaveBeenCalledTimes(1)
    expect(chat.list()[1].status).toBe("applied")
    expect(hooks.on_applied).toHaveBeenCalledWith(proposal())
  })

  it("marks a failed apply as discarded and says why", async () => {
    const apply_edit = vi.fn(async () => Promise.reject(new BrainError(400, "input", "views/feed.md changed since this was proposed; ask again.")))
    const { chat, hooks } = make_chat({ edit: async () => proposal(), apply_edit })
    await chat.send("no shorts")
    await chat.apply("p1")
    expect(chat.list()[1].status).toBe("discarded")
    expect(chat.list()[2].text).toContain("changed since")
    expect(hooks.on_applied).not.toHaveBeenCalled()
  })

  it("asks again on top of the current file when a proposal went stale", async () => {
    const edit = vi.fn(async () => proposal({ proposal_id: `p${edit.mock.calls.length}` }))
    const apply_edit = vi.fn(async () => Promise.reject(new BrainError(409, "stale", "views/feed.md changed since this was proposed; ask again.")))
    const { chat } = make_chat({ edit, apply_edit })
    await chat.send("/layout separate sections per source")
    await chat.apply("p1")
    expect(edit.mock.calls).toEqual([
      ["feed", "separate sections per source", undefined, "layout"],
      ["feed", "separate sections per source", undefined, "layout"],
    ])
    expect(chat.list().map((entry) => entry.status ?? entry.text)).toEqual([
      "/layout separate sections per source",
      "discarded",
      "The file changed after this was proposed, so I asked again on top of the current version.",
      "pending",
    ])
    expect(chat.thinking).toBe(false)
  })

  it("applies once when Confirm is clicked twice", async () => {
    let finish: (value: Proposal) => void = () => {}
    const apply_edit = vi.fn(() => new Promise<Proposal>((resolve) => (finish = resolve)))
    const { chat, hooks } = make_chat({ edit: async () => proposal(), apply_edit })
    await chat.send("no shorts")
    const first = chat.apply("p1")
    const second = chat.apply("p1")
    finish(proposal())
    await Promise.all([first, second])
    expect(apply_edit).toHaveBeenCalledTimes(1)
    expect(chat.list()[1].status).toBe("applied")
    expect(hooks.on_applied).toHaveBeenCalledTimes(1)
  })

  it("keeps an applied edit applied when the view fails to update afterwards", async () => {
    const { chat, hooks } = make_chat({ edit: async () => proposal(), apply_edit: async () => proposal() })
    hooks.on_applied.mockRejectedValueOnce(new Error("lens is gone"))
    await chat.send("no shorts")
    await chat.apply("p1")
    expect(chat.list()[1].status).toBe("applied")
    expect(last_reply(chat)).toBe("Saved, but the view could not update: lens is gone")
  })

  it("stays thinking until every request in flight has answered", async () => {
    const finishers: Array<(value: Proposal) => void> = []
    const edit = vi.fn(() => new Promise<Proposal>((resolve) => finishers.push(resolve)))
    const { chat } = make_chat({ edit })
    const first = chat.send("no shorts")
    const second = chat.send("hide politics")
    await Promise.resolve()
    finishers[0](proposal({ proposal_id: "a" }))
    await first
    expect(chat.thinking).toBe(true)
    finishers[1](proposal({ proposal_id: "b" }))
    await second
    expect(chat.thinking).toBe(false)
  })

  it("forgets the request behind a proposal once it scrolls out of the chat", async () => {
    const edit = vi.fn(async () => proposal({ proposal_id: "old" }))
    const apply_edit = vi.fn(async () => Promise.reject(new BrainError(409, "stale", "changed")))
    const { chat } = make_chat({ edit, apply_edit })
    await chat.send("/layout cards")
    for (let index = 0; index < 70; index++) chat.say(`line ${index}`)
    await chat.apply("old")
    expect(apply_edit).not.toHaveBeenCalled()
    expect(edit).toHaveBeenCalledTimes(1)
  })

  it("discards and tells the brain, ignoring brain errors", async () => {
    const discard_edit = vi.fn(async () => Promise.reject(new Error("offline")))
    const { chat } = make_chat({ edit: async () => proposal(), discard_edit })
    await chat.send("no shorts")
    await chat.discard("p1")
    expect(chat.list()[1].status).toBe("discarded")
    expect(discard_edit).toHaveBeenCalledWith("p1")
    await chat.discard("unknown")
    expect(discard_edit).toHaveBeenCalledTimes(1)
  })

  it("keeps the last sixty entries", () => {
    const { chat } = make_chat({})
    for (let index = 0; index < 70; index++) chat.say(`line ${index}`)
    expect(chat.list()).toHaveLength(60)
    expect(chat.list()[0].text).toBe("line 10")
  })
})

describe("chat commands", () => {
  it.each([
    ["/memory I'm vegetarian", "memory", "I'm vegetarian"],
    ["/feed no shorts", "rules", "no shorts"],
    ["/sources add the Hacker News RSS", "sources", "add the Hacker News RSS"],
    ["/layout two column magazine", "layout", "two column magazine"],
    ["hide politics", "any", "hide politics"],
  ])("%s edits with scope %s", async (typed, scope, text) => {
    const edit = vi.fn(async () => proposal())
    const { chat } = make_chat({ edit })
    await chat.send(typed)
    expect(edit).toHaveBeenCalledWith("feed", text, undefined, scope)
  })

  it("makes an empty view at once, or drafts one from a description", async () => {
    const create_view = vi.fn(async () => ({ view_id: "tech", title: "Tech" }))
    const edit = vi.fn(async () => proposal({ view_id: "tech" }))
    const { chat, hooks } = make_chat({ create_view, edit })
    await chat.send("/newview Tech")
    expect(create_view).toHaveBeenCalledWith("tech", "Tech")
    expect(hooks.view_created).toHaveBeenCalledWith("tech")
    expect(last_reply(chat)).toContain("Created views/tech.md")
    await chat.send("/newview science space news and physics videos")
    expect(edit).toHaveBeenCalledWith("science", "space news and physics videos", undefined, "view")
    expect(chat.list().at(-1)?.status).toBe("pending")
  })

  it("shows and changes models without asking a model", async () => {
    const model_info = vi.fn(async () => MODEL_INFO)
    const update_model = vi.fn(async () => ({ ...MODEL_INFO, allow_content_to_hosted: true }))
    const { chat, hooks } = make_chat({ model_info, update_model })
    await chat.send("/model")
    expect(last_reply(chat)).toContain("fast: nvidia/nemotron-3.5-super-vl:free via openrouter (hosted)")
    expect(last_reply(chat)).toContain("smart: llama3 via ollama (on this machine)")
    expect(hooks.model_changed).not.toHaveBeenCalled()
    await chat.send("/model privacy on")
    expect(update_model).toHaveBeenCalledWith({ allow_content_to_hosted: true })
    expect(hooks.model_changed).toHaveBeenCalledTimes(1)
    expect(last_reply(chat)).toMatch(/^Models updated\./)
    expect(last_reply(chat)).toContain("Your content may go to hosted models: on")
  })

  it("shows settings and opens the folder", async () => {
    const overview = vi.fn(async () => OVERVIEW)
    const { chat, hooks } = make_chat({ overview })
    await chat.send("/settings")
    expect(overview).toHaveBeenCalledWith("feed")
    expect(last_reply(chat)).toContain("Settings for views/feed.md")
    expect(last_reply(chat)).toContain("memory/dislikes.md:\n* crypto")
    await chat.send("/settings open")
    expect(hooks.open_folder).toHaveBeenCalledWith("/Users/me/openMoi")
  })

  it("answers help, usage mistakes and unknown commands without the brain", async () => {
    const { chat } = make_chat({})
    await chat.send("/help")
    expect(last_reply(chat)).toContain("/newview <name> [what it should be]")
    await chat.send("/memory")
    expect(last_reply(chat)).toBe("Usage: /memory <what to remember or forget>")
    await chat.send("/frobnicate")
    expect(last_reply(chat)).toBe("Unknown command /frobnicate. Type /help for the list.")
  })
})

describe("explain", () => {
  it.each([
    [new BrainError(502, "llm", "timeout"), "The model did not answer: timeout"],
    [new Error("plain"), "plain"],
    ["text", "text"],
  ])("%s", (error, expected) => {
    expect(explain(error)).toBe(expected)
  })
})

describe("ChatController background", () => {
  it("passes /background to the shell and says what it means", async () => {
    const { chat, hooks } = make_chat({})
    await chat.send("/background on")
    expect(hooks.set_background).toHaveBeenCalledWith(true)
    expect(last_reply(chat)).toBe("on now")
    await chat.send("/background off")
    expect(last_reply(chat)).toBe("off now")
  })
})

describe("ChatController mirror", () => {
  it("shows the mirror for the days asked", async () => {
    const mirror = vi.fn(async () => ({ days: 3, since: "2026-11-07T09:00:00Z", sources: [], views: [] }))
    const { chat } = make_chat({ mirror } as unknown as Partial<BrainClient>)
    await chat.send("/mirror 3")
    expect(mirror).toHaveBeenCalledWith(3)
    expect(last_reply(chat)).toBe("Nothing was read in the last 3 days.")
  })
})

describe("ChatController shopping", () => {
  it("starts shopping in a view, made for it when there was none, and says where", async () => {
    const shop = vi.fn(async () => ({ view_id: "shop", query: "desk lamp", created: true }))
    const { chat, hooks } = make_chat({ shop } as unknown as Partial<BrainClient>)
    await chat.send("/shop desk lamp")
    expect(shop).toHaveBeenCalledWith("desk lamp", "feed")
    expect(hooks.shopping).toHaveBeenCalledWith("shop", true)
    expect(last_reply(chat)).toBe('Looking for "desk lamp" in shop, a new Shop view (its stores are in views/shop.md).')
    shop.mockResolvedValueOnce({ view_id: "gear", query: "tent", created: false })
    await chat.send("/shop tent")
    expect(last_reply(chat)).toBe('Looking for "tent" in gear.')
  })
})

describe("ChatController questions", () => {
  it("answers a question about what you read with its sources as links", async () => {
    const ask = vi.fn(async () => ({ answer: "You read it in Lithium news [1].", citations: [{ number: 1, item_id: "i1", title: "Lithium news", url: "https://blog.example/1" }] }))
    const { chat } = make_chat({ ask } as unknown as Partial<BrainClient>)
    await chat.send("What did I read about lithium?")
    expect(ask).toHaveBeenCalledWith("What did I read about lithium?")
    expect(last_reply(chat)).toBe("You read it in Lithium news [1].\n[1] Lithium news https://blog.example/1")
  })
})

describe("ChatController collections and exports", () => {
  it("lists collections and exports this view or a collection, showing the file", async () => {
    const collections = vi.fn(async () => [{ name: "read_later", title: "Read later", count: 2, views: ["later"] }, { name: "watch_later", title: "Watch later", count: 1, views: [] }])
    const exporting = vi.fn(async () => "/home/exports/feed_1.md")
    const { chat, hooks } = make_chat({ collections, export: exporting } as unknown as Partial<BrainClient>)
    await chat.send("/collections")
    expect(last_reply(chat)).toBe("Your collections:\n* Read later: 2 items, in the later tab\n* Watch later: 1 item, no tab reads it yet\nExport one with /export md <collection>.")
    await chat.send("/export")
    expect(exporting).toHaveBeenLastCalledWith("md", { view_id: "feed" })
    expect(hooks.show_file).toHaveBeenCalledWith("/home/exports/feed_1.md")
    await chat.send("/export json read later")
    expect(exporting).toHaveBeenLastCalledWith("json", { collection: "read later" })
    collections.mockResolvedValueOnce([])
    await chat.send("/collections")
    expect(last_reply(chat)).toBe("Nothing saved yet. Read later and Watch later on a card keep it here.")
  })
})

describe("ChatController search", () => {
  it("searches what you were shown and lists the hits", async () => {
    const hit = { item: { source_id: "rss:news", url: "https://news.example/1", title: "Lithium recycling", text: null, published_at: "2026-11-01T10:00:00Z", fetched_at: "2026-11-01T10:00:00Z" }, score: 1 }
    const search = vi.fn(async () => [hit])
    const { chat } = make_chat({ search } as unknown as Partial<BrainClient>)
    await chat.send("/search lithium")
    expect(search).toHaveBeenCalledWith("lithium")
    expect(last_reply(chat)).toBe('One item matches "lithium", best first:\n* Lithium recycling (rss:news, 2026-11-01) https://news.example/1')
  })
})

describe("ChatController sharing", () => {
  const PROPOSAL = { proposal_id: "p9", view_id: "ai", changes: [{ file: "views/ai.md", diff: "+# AI" }], lens_action: null, reply: "AI news as a new view, ai. Its look is made fresh from its Layout." }

  it("imports a view from a link as a proposal you confirm, then applies it", async () => {
    const import_view = vi.fn(async () => PROPOSAL)
    const apply_edit = vi.fn(async () => PROPOSAL)
    const { chat, hooks, labels } = make_chat({ import_view, apply_edit } as unknown as Partial<BrainClient>)
    await chat.send("/import https://gist.example/ai.md")
    expect(import_view).toHaveBeenCalledWith("", null, "https://gist.example/ai.md")
    expect(labels).toContain("Reading the shared view")
    const entry = chat.list().at(-1)
    expect([entry?.text, entry?.status, entry?.proposal?.proposal_id]).toEqual([`Add ${PROPOSAL.reply}`, "pending", "p9"])
    await chat.apply("p9")
    expect(hooks.on_applied).toHaveBeenCalledWith(PROPOSAL)
  })

  it("imports a dropped file and says why one is refused", async () => {
    const import_view = vi.fn(async () => PROPOSAL)
    const { chat } = make_chat({ import_view } as unknown as Partial<BrainClient>)
    await chat.import_file("ai.md", "# AI")
    expect(import_view).toHaveBeenCalledWith("ai.md", "# AI", null)
    expect(chat.list().map((entry) => entry.text)).toEqual(["Import ai.md", `Add ${PROPOSAL.reply}`])
    import_view.mockRejectedValueOnce(new Error("That is not an openMoi view: it has no Sources or Rules section."))
    await chat.import_file("notes.md", "milk")
    expect(last_reply(chat)).toBe("That is not an openMoi view: it has no Sources or Rules section.")
  })

  it("saves a copy of this view to send and shows it", async () => {
    const share_view = vi.fn(async () => ({ path: "/Users/me/openMoi/shared/feed.md" }))
    const { chat, hooks } = make_chat({ share_view } as unknown as Partial<BrainClient>)
    await chat.send("/share")
    expect(share_view).toHaveBeenCalledWith("feed")
    expect(hooks.show_file).toHaveBeenCalledWith("/Users/me/openMoi/shared/feed.md")
    expect(last_reply(chat)).toBe("Saved a copy of feed to send: /Users/me/openMoi/shared/feed.md. People, following lists and watched pages are left out.")
  })
})

describe("ChatController apps", () => {
  it("says what openMoi may read on this Mac and asks macOS for one app when you say so", async () => {
    const apps = vi.fn(async (): Promise<{ status: Record<string, string>; message: string }> => ({ status: { calendar: "not_asked", mail: "allowed" }, message: "" }))
    const allow_app = vi.fn(async () => ({ status: { calendar: "allowed" }, message: "openMoi can read calendar now, to show today's meetings." }))
    const { chat, labels, hooks } = make_chat({ apps, allow_app } as unknown as Partial<BrainClient>)
    await chat.send("/allow")
    expect(last_reply(chat)).toBe("What openMoi may read on this Mac: calendar: not asked, mail: allowed. Say /allow calendar, mail, notes or files to ask for one.")
    await chat.send("/allow calendar")
    expect(allow_app).toHaveBeenCalledWith("calendar")
    expect(labels).toContain("Asking macOS about calendar")
    expect(last_reply(chat)).toBe("openMoi can read calendar now, to show today's meetings.")
    expect(hooks.app_allowed).toHaveBeenCalledTimes(1)
    allow_app.mockResolvedValueOnce({ status: { calendar: "denied" }, message: "Calendar access is denied." })
    await chat.send("/allow calendar")
    expect(hooks.app_allowed).toHaveBeenCalledTimes(1)
    apps.mockResolvedValueOnce({ status: {}, message: "the Mac helper is not built yet: run helper/build.sh" })
    await chat.send("/allow")
    expect(last_reply(chat)).toBe("Apps on this Mac are out of reach: the Mac helper is not built yet: run helper/build.sh")
  })
})

describe("ChatController people", () => {
  it("offers a link between accounts that look like one person as a change to confirm, or says there is none", async () => {
    const proposal = { proposal_id: "pp", view_id: "feed", changes: [], lens_action: null, reply: "Sam Lee on facebook (@sam.lee), x (@sam) look like one person. Link them in people.md?" }
    const people_suggest = vi.fn(async () => ({ proposal, suggestion: { name: "Sam Lee", accounts: [["facebook", "sam.lee"], ["x", "sam"]], items: 3 }, more: 1 }))
    const { chat } = make_chat({ people_suggest } as unknown as Partial<BrainClient>)
    await chat.send("/people")
    const [entry] = chat.list().filter((candidate) => candidate.proposal)
    expect(entry.text).toBe(`${proposal.reply} (1 more: say /people again after this one.)`)
    expect(entry.status).toBe("pending")
    people_suggest.mockResolvedValueOnce({ proposal: null, suggestion: null, more: 0 } as never)
    await chat.send("/people")
    expect(last_reply(chat)).toBe("No accounts look like one person yet: openMoi suggests a link when one full name posts on two sites.")
  })
})

describe("ChatController history imports", () => {
  it("stores a dropped export as your history and says how to show it", async () => {
    const import_history = vi.fn(async () => ({ source_id: "history:amazon", stored: 42 }))
    const { chat, labels } = make_chat({ import_history } as unknown as Partial<BrainClient>)
    await chat.import_history("Retail.OrderHistory.1.csv", "csv")
    expect(import_history).toHaveBeenCalledWith("Retail.OrderHistory.1.csv", "csv")
    expect(labels).toEqual(["Reading Retail.OrderHistory.1.csv"])
    expect(last_reply(chat)).toBe('Your amazon history now holds 42 items. Add "History: amazon" to a view\'s Sources to see them.')
  })
})

describe("ChatController Google", () => {
  it("opens Google's sign in in your browser and waits for it to come back", async () => {
    vi.useFakeTimers()
    const statuses = [{ connected: false, status: "waiting for you in the browser", client: true }, { connected: true, status: "connected", client: true }]
    const google_status = vi.fn(async () => statuses.shift() ?? { connected: true, status: "connected", client: true })
    const { chat, hooks, labels } = make_chat({ google_connect: vi.fn(async () => ({ auth_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" })), google_status } as unknown as Partial<BrainClient>)
    const sending = chat.send("/google connect")
    await vi.advanceTimersByTimeAsync(2_500)
    await sending
    expect(hooks.open_external).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1")
    expect(labels).toContain("Waiting for Google")
    expect(last_reply(chat)).toBe("Google is connected: YouTube subscriptions now come from your account.")
    vi.useRealTimers()
  })

  it("says when the sign in failed, when nothing came back, and the status on its own", async () => {
    vi.useFakeTimers()
    const refused = make_chat({ google_connect: vi.fn(async () => ({ auth_url: "https://a" })), google_status: vi.fn(async () => ({ connected: false, status: "not connected: access_denied", client: true })) } as unknown as Partial<BrainClient>)
    await refused.chat.send("/google connect")
    expect(last_reply(refused.chat)).toBe("Google did not connect: not connected: access_denied.")
    const silent = make_chat({ google_connect: vi.fn(async () => ({ auth_url: "https://a" })), google_status: vi.fn(async () => ({ connected: false, status: "waiting for you in the browser", client: true })) } as unknown as Partial<BrainClient>)
    const waiting = silent.chat.send("/google connect")
    await vi.advanceTimersByTimeAsync(301_000)
    await waiting
    expect(last_reply(silent.chat)).toBe("Google did not connect: no answer from the browser in five minutes.")
    vi.useRealTimers()
    const states = [{ connected: false, status: "not connected", client: false }, { connected: true, status: "connected", client: true }, { connected: false, status: "not connected", client: true }]
    const status = make_chat({ google_status: vi.fn(async () => states.shift()) } as unknown as Partial<BrainClient>)
    await status.chat.send("/google")
    expect(last_reply(status.chat)).toContain("Google is not set up")
    await status.chat.send("/google")
    expect(last_reply(status.chat)).toBe("Google is connected: YouTube subscriptions come from your account.")
    await status.chat.send("/google")
    expect(last_reply(status.chat)).toBe("Google is not connected. Use /google connect.")
  })
})

describe("ChatController Google after the L1 review", () => {
  it("waits for this sign in, not an older token that is still there", async () => {
    vi.useFakeTimers()
    const statuses = [{ connected: true, status: "waiting for you in the browser", client: true }, { connected: true, status: "connected", client: true }]
    const google_status = vi.fn(async () => statuses.shift() ?? { connected: true, status: "connected", client: true })
    const { chat } = make_chat({ google_connect: vi.fn(async () => ({ auth_url: "https://a" })), google_status } as unknown as Partial<BrainClient>)
    const sending = chat.send("/google connect")
    await vi.advanceTimersByTimeAsync(2_500)
    await sending
    expect(google_status).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe("ChatController agents", () => {
  it("shows a plan to approve, follows its updates and offers what it proposes", async () => {
    const plan = { plan_id: "p1", status: "proposed", reason: "left out propose_action: an agent may not place_order" }
    const plan_agent = vi.fn(async () => plan)
    const { chat } = make_chat({ plan_agent } as unknown as Partial<BrainClient>)
    await chat.send("/agent shop a desk lamp")
    expect(plan_agent).toHaveBeenCalledWith("shop", "a desk lamp")
    const entry = chat.list().at(-1)
    expect(entry?.plan).toEqual(plan)
    expect(entry?.text).toBe("Here is the plan. (left out propose_action: an agent may not place_order.) Approve it and I will run it.")
    chat.update_plan({ ...plan, status: "running" } as never)
    chat.update_plan({ plan_id: "unknown", status: "done" } as never)
    expect(chat.list().at(-1)?.plan?.status).toBe("running")
    chat.offer_proposal({ proposal_id: "e1", view_id: "feed", changes: [{ file: "memory/likes.md", diff: "+* lamps" }], lens_action: null, reply: "" }, "An agent proposes this.")
    expect(chat.list().at(-1)).toMatchObject({ text: "An agent proposes this.", status: "pending", proposal: { proposal_id: "e1" } })
  })
})
