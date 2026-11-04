// M1 exit criteria in the real app: one Feed from X, YouTube and RSS; open original; events recorded.
import { expect, test } from "@playwright/test"
import { FakeWorld, Harness, eventually } from "./harness"

interface Debug {
  store: { items: Record<string, number>; events: Record<string, number> }
  sources: Record<string, string>
}

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

test("feed merges X, YouTube and RSS, opens originals and records events", async () => {
  const harness = await Harness.launch(world)
  try {
    await expect(harness.chrome.locator("button.tab.view.active")).toHaveText("Feed")
    const started = Date.now()
    const text = await eventually(
      () => harness.lens_text(),
      (value) => ["New laptop chip", "Why the sky is blue", "Post number 0 from maya"].every((needle) => value.includes(needle)),
    )
    expect(text).toContain("New laptop chip doubles battery life")
    expect(text).toContain("Why the sky is blue, really")
    expect(text).toContain("Post number 0 from maya")
    console.log(`all three sources visible after ${Date.now() - started} ms`)

    const debug = await eventually(
      () => harness.brain<Debug>("/debug"),
      (value) => (value.store.items.x ?? 0) >= 15,
      20_000,
    )
    expect(debug.store.items.x).toBeGreaterThanOrEqual(15)
    expect(debug.store.items["rss:tech"]).toBe(5)
    expect(debug.store.items["youtube:veritasium"]).toBe(3)

    const seen = await eventually(
      () => harness.brain<Debug>("/debug"),
      (value) => (value.store.events.seen ?? 0) > 0,
      15_000,
    )
    expect(seen.store.events.seen).toBeGreaterThan(0)

    const clicked = await harness.in_lenses<string>(
      `(() => { const card = [...document.querySelectorAll("[data-item-id]")].find((node) => node.innerText.includes("New laptop chip")); card.click(); return card.dataset.itemId })()`,
    )
    expect(clicked[0]).toMatch(/^[0-9a-f]{32}$/)
    await expect(harness.chrome.locator(".tab.web.active")).toHaveCount(1)
    await expect(harness.chrome.locator(".address input")).toHaveValue(new RegExp(`${world.base_url}/articles/tech1`))
    const opened = await eventually(
      () => harness.brain<Debug>("/debug"),
      (value) => value.store.events.open === 1,
    )
    expect(opened.store.events.open).toBe(1)

    await harness.chrome.locator("button.close").click()
    await expect(harness.chrome.locator(".tab.web")).toHaveCount(0)
    await expect(harness.chrome.locator("button.tab.view.active")).toHaveText("Feed")
  } finally {
    await harness.close()
  }
})

test("a login wall stops reading X and asks you, while other sources still load", async () => {
  const harness = await Harness.launch(world, { x_page: "x_login.html" })
  try {
    await expect(harness.chrome.locator(".notice").first()).toContainText("x needs you", { timeout: 45_000 })
    const text = await eventually(
      () => harness.lens_text(),
      (value) => value.includes("New laptop chip"),
    )
    expect(text).not.toContain("Post number")
    await harness.chrome.locator(".notice button", { hasText: "Open" }).click()
    await expect(harness.chrome.locator(".tab.web.active")).toHaveCount(1)
    await expect(harness.chrome.locator(".address input")).toHaveValue(/x_login\.html/)
  } finally {
    await harness.close()
  }
})

test("a second view file becomes a second tab with its own sources", async () => {
  const harness = await Harness.launch(world, {
    views: {
      feed: `# Feed\n## Sources\n* RSS: ${world.base_url}/rss/tech.xml\n`,
      tech: `# Local\n## Sources\n* RSS: ${world.base_url}/rss/news.xml\n`,
    },
  })
  try {
    await expect(harness.chrome.locator("button.tab.view")).toHaveText(["Feed", "Local"])
    await eventually(
      () => harness.lens_text(),
      (value) => value.includes("New laptop chip"),
    )
    await harness.chrome.locator("button.tab.view", { hasText: "Local" }).click()
    await expect(harness.chrome.locator("button.tab.view.active")).toHaveText("Local")
    const texts = await eventually(
      () => harness.in_lenses<string>("document.body.innerText"),
      (values) => values.length === 2 && values[1].includes("Local bakery"),
    )
    expect(texts[1]).toContain("Local bakery wins national prize")
    expect(texts[1]).not.toContain("space telescope")
  } finally {
    await harness.close()
  }
})
