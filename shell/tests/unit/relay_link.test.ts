import { describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import type { PageDriver } from "../../src/main/drivers"
import { RelayLink } from "../../src/main/relay_link"
import type { RelayPoll } from "../../src/shared/types"

const FALLBACK = { kind: "openmoi" } as PageDriver

function poll_result(fields: Partial<RelayPoll["status"]> = {}, events: RelayPoll["events"] = []): RelayPoll {
  return { status: { connected: false, waiting_for_approval: null, paired: false, unrecognized: null, extension_id: null, passive_batches: 0, ...fields }, events }
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
    expect(hooks.changed).toHaveBeenCalledWith({ connected: true, waiting_for_approval: null, paired: false, unrecognized: null }, { connected: false, waiting_for_approval: null, paired: false, unrecognized: null })
  })

  it("reads through openMoi at once when Chrome was never paired", async () => {
    const { link } = make_link([poll_result()])
    await link.poll()
    const started = Date.now()
    expect(await link.reading_driver(5_000)).toBe(FALLBACK)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it("waits for a paired Chrome to come back before reading", async () => {
    const { link } = make_link([poll_result({ paired: true }), poll_result({ paired: true, connected: true })])
    await link.poll()
    const reading = link.reading_driver(5_000)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await link.poll()
    expect((await reading).kind).toBe("chrome")
  })

  it("falls back once a paired Chrome stays away too long", async () => {
    const { link } = make_link([poll_result({ paired: true })])
    await link.poll()
    expect(await link.reading_driver(250)).toBe(FALLBACK)
  })

  it("waits for the first poll before choosing", async () => {
    const { link } = make_link([poll_result({ paired: true, connected: true })])
    const reading = link.reading_driver(5_000)
    await link.poll()
    expect((await reading).kind).toBe("chrome")
  })

  it("asks for approval once per extension", async () => {
    const waiting = poll_result({ waiting_for_approval: "abcdefgh" })
    const { link, hooks } = make_link([waiting, waiting, poll_result({ waiting_for_approval: "ijklmnop" })])
    await link.poll()
    await link.poll()
    await link.poll()
    expect(hooks.approval_needed.mock.calls).toEqual([["abcdefgh"], ["ijklmnop"]])
  })

  it("asks again for the same extension once its earlier request cleared", async () => {
    const waiting = poll_result({ waiting_for_approval: "abcdefghijklmnopabcdefghijklmnop" })
    const { link, hooks } = make_link([waiting, poll_result({ connected: true }), waiting])
    await link.poll()
    await link.poll()
    await link.poll()
    expect(hooks.approval_needed).toHaveBeenCalledTimes(2)
  })

  it("does not wait for a Chrome that needs Pair again and says when that changes", async () => {
    const { link, hooks } = make_link([poll_result({ paired: true, unrecognized: "abc" })])
    await link.poll()
    const started = Date.now()
    expect(await link.reading_driver(5_000)).toBe(FALLBACK)
    expect(Date.now() - started).toBeLessThan(500)
    expect(hooks.changed).toHaveBeenCalledTimes(1)
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
