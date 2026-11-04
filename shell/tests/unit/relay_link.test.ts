import { describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import type { PageDriver } from "../../src/main/drivers"
import { RelayLink } from "../../src/main/relay_link"
import type { RelayPoll } from "../../src/shared/types"

const FALLBACK = { kind: "openmoi" } as PageDriver

function poll_result(fields: Partial<RelayPoll["status"]> = {}, events: RelayPoll["events"] = []): RelayPoll {
  return { status: { connected: false, waiting_for_approval: null, extension_id: null, passive_batches: 0, ...fields }, events }
}

function make_link(polls: RelayPoll[]) {
  const brain = {
    relay_poll: vi.fn(async () => polls.shift() ?? poll_result()),
    relay_trust: vi.fn(async () => poll_result({ connected: true }).status),
    relay_call: vi.fn(async (op: string, args: Record<string, unknown>) => ({ handle: "512", op, args })),
  }
  const hooks = { changed: vi.fn(), approval_needed: vi.fn(), mine: vi.fn() }
  const link = new RelayLink(brain as unknown as BrainClient, FALLBACK, hooks)
  return { link, brain, hooks }
}

describe("RelayLink", () => {
  it("reads through openMoi until Chrome connects, then through Chrome", async () => {
    const { link, hooks } = make_link([poll_result(), poll_result({ connected: true, extension_id: "abc" })])
    await link.poll()
    expect(link.driver()).toBe(FALLBACK)
    expect(hooks.changed).not.toHaveBeenCalled()
    await link.poll()
    expect(link.driver().kind).toBe("chrome")
    expect(hooks.changed).toHaveBeenCalledWith({ connected: true, waiting_for_approval: null }, { connected: false, waiting_for_approval: null })
  })

  it("asks for approval once per extension", async () => {
    const waiting = poll_result({ waiting_for_approval: "abcdefgh" })
    const { link, hooks } = make_link([waiting, waiting, poll_result({ waiting_for_approval: "ijklmnop" })])
    await link.poll()
    await link.poll()
    await link.poll()
    expect(hooks.approval_needed.mock.calls).toEqual([["abcdefgh"], ["ijklmnop"]])
  })

  it("hands Mine requests from Chrome to the shell", async () => {
    const request = { event: "mine" as const, handle: "512", url: "https://news.example.com/", title: "News" }
    const { link, hooks } = make_link([poll_result({ connected: true }, [request])])
    await link.poll()
    expect(hooks.mine).toHaveBeenCalledWith(request)
  })

  it("approves through the brain and polls right away", async () => {
    const { link, brain } = make_link([poll_result({ connected: true })])
    await link.trust("abcdefgh")
    expect(brain.relay_trust).toHaveBeenCalledWith("abcdefgh")
    expect(link.status.connected).toBe(true)
  })

  it("skips a poll while one is still running", async () => {
    const { link, brain } = make_link([])
    await Promise.all([link.poll(), link.poll()])
    expect(brain.relay_poll).toHaveBeenCalledTimes(1)
  })

  it("sends page operations to Chrome through the brain", async () => {
    const { link, brain } = make_link([])
    expect(await link.chrome.open("https://x.com/home", true)).toBe("512")
    await link.chrome.run("512", "extract", { spec: 1 })
    await link.chrome.close("512")
    expect(brain.relay_call.mock.calls).toEqual([
      ["open", { url: "https://x.com/home", background: true }],
      ["run", { handle: "512", op: "extract", args: { spec: 1 } }],
      ["close", { handle: "512" }],
    ])
  })
})
