import { describe, expect, it, vi } from "vitest"
import { BrainError, type BrainClient } from "../../src/main/brain"
import { ChatController, explain } from "../../src/main/chat"
import type { Proposal } from "../../src/shared/types"

function proposal(fields: Partial<Proposal> = {}): Proposal {
  return { proposal_id: "p1", view_id: "feed", changes: [{ file: "views/feed.md", diff: "+* No shorts." }], lens_action: null, reply: "Added a rule.", ...fields }
}

function make_chat(brain: Partial<BrainClient>) {
  const hooks = { chat_view: () => "feed", on_applied: vi.fn(async () => {}), changed: vi.fn() }
  return { chat: new ChatController(brain as BrainClient, hooks), hooks }
}

describe("ChatController", () => {
  it("turns a request into a pending proposal for the current view", async () => {
    const edit = vi.fn(async () => proposal())
    const { chat, hooks } = make_chat({ edit })
    const sending = chat.send("no shorts")
    expect(chat.thinking).toBe(true)
    await sending
    expect(chat.thinking).toBe(false)
    expect(edit).toHaveBeenCalledWith("feed", "no shorts", undefined)
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
    expect(edit).toHaveBeenCalledWith("tech", "Less like this: Bakery", "item7")
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
    expect(chat.list()[1].text).toContain("needs a local model")
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

describe("explain", () => {
  it.each([
    [new BrainError(502, "llm", "timeout"), "The model did not answer: timeout"],
    [new Error("plain"), "plain"],
    ["text", "text"],
  ])("%s", (error, expected) => {
    expect(explain(error)).toBe(expected)
  })
})
