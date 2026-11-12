// Recipes in the real app: a view whose Match section looks up what friends' posts name in a store, only when you
// press Look up, and never with the store page's text going to a model.
import { expect, test } from "@playwright/test"
import { FakeWorld, Harness, eventually } from "./harness"

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

test("a mentions view shows what posts name and reads the store for one only when you press Look up", async () => {
  const feed = `# Feed\n\n## Sources\n* RSS: ${world.base_url}/rss/tech.xml\n`
  const buying = `# Buying\n\n## Sources\n* RSS: ${world.base_url}/rss/friends.xml\n* Shop: ${world.base_url}/pages/shop.html?k={query}\n\n## Match\nProducts mentioned in posts, looked up in the shop.\n`
  const harness = await Harness.launch(world, { views: { feed, buying } })
  try {
    await eventually(
      () => harness.lens_text(),
      (text) => text.includes("New laptop chip"),
    )
    await harness.chrome.locator("button.tab.view", { hasText: "Buying" }).click()
    await expect(harness.chrome.locator("button.tab.view.active")).toHaveText("Buying")
    const before = await eventually(
      () => harness.last_lens_text(),
      (text) => text.includes("Architect clamp lamp: not looked up") && text.includes("Velvet throw pillow: not looked up"),
      60_000,
    )
    expect(before).not.toContain("Lovely day at the park")
    expect(await world.hits("/pages/shop.html")).toEqual([])

    const post = `[...document.querySelectorAll("[data-item-id]")].find((node) => node.innerText.includes("Architect clamp lamp"))`
    await harness.click_lens(`${post}.querySelector(".look_up")`, true)
    await expect(harness.chrome.locator(".notice", { hasText: 'Looking up "Architect clamp lamp"' })).toBeVisible()
    const after = await eventually(
      () => harness.last_lens_text(),
      (text) => text.includes("Architect clamp lamp: found") && text.includes("Architect clamp lamp, matte black · $39.00"),
      60_000,
    )
    expect(after).toContain("Velvet throw pillow: not looked up")
    const searches = (await world.hits("/pages/shop.html")).map((hit) => decodeURIComponent(hit.path))
    expect(searches.length).toBeGreaterThan(0)
    expect(searches.every((path) => path.includes("k=Architect+clamp+lamp"))).toBe(true)

    const named = await world.model_calls("mentions")
    expect(named.length).toBeGreaterThan(0)
    expect(named.every((call) => !JSON.stringify(call.payload).includes("CANARY_PAGE_TEXT"))).toBe(true)
    expect(await harness.brain("/actions/log")).toEqual([])
  } finally {
    await harness.close()
  }
})
