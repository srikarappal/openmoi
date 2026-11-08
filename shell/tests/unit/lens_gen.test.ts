import { describe, expect, it, vi } from "vitest"
import { BrainError, type BrainClient } from "../../src/main/brain"
import { LensGenerator, view_label } from "../../src/main/lens_gen"
import type { SmokeTester } from "../../src/main/smoke"
import { Tracked } from "./tracked"

function make_generator(problems: Array<string | null>, generate = vi.fn(async () => "<html>lens</html>")) {
  const brain = { generate_lens: generate, accept_lens: vi.fn(async () => 3) }
  const smoke = { problem: vi.fn(async () => problems.shift() ?? null) }
  const { labels, track } = new Tracked()
  const hooks = { say: vi.fn(), on_new_lens: vi.fn(async () => {}), track, labels }
  const generator = new LensGenerator(brain as unknown as BrainClient, smoke as unknown as SmokeTester, hooks)
  return { generator, brain, smoke, hooks }
}

function said(hooks: { say: ReturnType<typeof vi.fn> }): string[] {
  return hooks.say.mock.calls.map((call) => String(call[0]))
}

describe("LensGenerator", () => {
  it("accepts a lens that passes the smoke test and reloads it", async () => {
    const { generator, brain, smoke, hooks } = make_generator([null])
    await generator.ensure("feed", "feed", "layout1")
    expect(brain.generate_lens).toHaveBeenCalledWith("feed", "feed", undefined)
    expect(smoke.problem).toHaveBeenCalledWith("<html>lens</html>", "feed")
    expect(brain.accept_lens).toHaveBeenCalledWith("feed", "feed", "<html>lens</html>")
    expect(hooks.on_new_lens).toHaveBeenCalledWith("feed", "feed")
    expect(said(hooks)[1]).toMatch(/^New look for feed is live \(version 3, \d+ s\)\.$/)
    expect(hooks.labels).toEqual(["Designing a new look for feed, usually under a minute"])
  })

  it("a look that went live counts as built even when showing it fails", async () => {
    const { generator, hooks } = make_generator([null])
    hooks.on_new_lens.mockRejectedValueOnce(new Error("view closed"))
    await generator.ensure("feed", "feed", "layout1")
    expect(said(hooks).at(-1)).toBe("The new look is saved but could not be shown yet (view closed); reopen feed to see it.")
    expect(said(hooks).some((text) => text.startsWith("Could not build"))).toBe(false)
  })

  it("retries once with the smoke test problem", async () => {
    const { generator, brain } = make_generator(["0 of 30 items were not rendered", null])
    await generator.ensure("site_shop.example", "listing", "layout1")
    expect(brain.generate_lens).toHaveBeenNthCalledWith(2, "site_shop.example", "listing", "0 of 30 items were not rendered")
    expect(brain.accept_lens).toHaveBeenCalledTimes(1)
  })

  it("keeps the current lens after two failures and only tries again for a new layout", async () => {
    const { generator, brain, hooks } = make_generator(["broken", "still broken"])
    await generator.ensure("feed", "feed", "layout1")
    expect(brain.accept_lens).not.toHaveBeenCalled()
    expect(said(hooks).at(-1)).toBe("That look did not work (still broken). Keeping the current one.")
    await generator.ensure("feed", "feed", "layout1")
    expect(brain.generate_lens).toHaveBeenCalledTimes(2)
    await generator.ensure("feed", "feed", "layout2")
    expect(brain.generate_lens).toHaveBeenCalledTimes(3)
    expect(brain.accept_lens).toHaveBeenCalledTimes(1)
  })

  it("runs one build per view and kind at a time", async () => {
    const { generator, brain } = make_generator([null, null])
    await Promise.all([generator.ensure("feed", "feed", "layout1"), generator.ensure("feed", "feed", "layout1"), generator.ensure("feed", "listing", "layout1")])
    expect(brain.generate_lens).toHaveBeenCalledTimes(2)
  })

  it("reports model errors in plain words", async () => {
    const generate = vi.fn(async () => Promise.reject(new BrainError(502, "llm", "smart slot down")))
    const { generator, hooks } = make_generator([], generate)
    await generator.ensure("feed", "feed", "layout1")
    expect(said(hooks).at(-1)).toBe("Could not build a new look for feed: The model did not answer: smart slot down")
    await generator.ensure("feed", "feed", "layout1")
    expect(generate).toHaveBeenCalledTimes(1)
  })
})

describe("view_label", () => {
  it("shows site views by domain", () => {
    expect(view_label("site_amazon.com")).toBe("amazon.com")
    expect(view_label("feed")).toBe("feed")
  })
})
