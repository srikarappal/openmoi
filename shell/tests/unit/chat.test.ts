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
    model_changed: vi.fn(),
    open_folder: vi.fn(),
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
    const apply_edit = async () => Promise.reject(new BrainError(400, "input", "views/feed.md changed since this was proposed; ask again."))
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
