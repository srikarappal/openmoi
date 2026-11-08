// M3 exit criteria in the real app: generated lenses that pass a smoke test plus Mine for listings and articles.
import { expect, test } from "@playwright/test"
import { FakeWorld, Harness, eventually } from "./harness"

const CANARY = "CANARY_PAGE_TEXT_9f3a"
const OLD_SHOP_SPEC = JSON.stringify({
  domain: "127.0.0.1",
  path_pattern: "/pages/shop.html*",
  page_type: "listing",
  version: 1,
  item_root: "div.old_result",
  fields: { title: { select: "a", take: "text" }, url: { select: "a", take: "attr:href" } },
})

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

async function mine_on(harness: Harness): Promise<void> {
  await harness.chrome.locator("button.mine").click()
  await expect(harness.chrome.locator("button.mine.on")).toHaveCount(1)
}

test("Mine turns a listing into your version, remembers the spec and never sends page text", async () => {
  const harness = await Harness.launch(world)
  try {
    await harness.open_page(world.page("listing.html"), "Hacker Newz")
    await mine_on(harness)
    const text = await eventually(
      () => harness.last_lens_text(),
      (value) => value.includes("Rust 2.0 released"),
    )
    for (const title of ["Rust 2.0 released with a new borrow checker", "Why SQLite is everywhere", "Ask HN: How do you read the news?"]) expect(text).toContain(title)
    const calls = await world.model_calls("extractor")
    const sent = calls.at(-1)?.payload.messages[1].content ?? ""
    expect(sent).toContain("tr")
    expect(sent).not.toContain(CANARY)
    expect(sent).not.toContain("Rust")
    expect(harness.files_in(".moi/extractors").some((name) => name.includes("listing.html"))).toBe(true)

    await harness.chrome.locator("button.mine").click()
    await expect(harness.chrome.locator("button.mine.on")).toHaveCount(0)
    await mine_on(harness)
    await eventually(
      () => harness.last_lens_text(),
      (value) => value.includes("Why SQLite"),
    )
    expect(await world.model_calls("extractor")).toHaveLength(calls.length)

    await harness.in_lenses(`[...document.querySelectorAll("[data-item-id]")].find((node) => node.innerText.includes("Ask HN"))?.click()`)
    await expect(harness.chrome.locator("button.mine.on")).toHaveCount(0)
    await expect(harness.chrome.locator(".address input")).toHaveValue(`${world.base_url}/pages/item?id=903`)
  } finally {
    await harness.close()
  }
})

test("Mine reads an article as a reader without asking a model", async () => {
  const harness = await Harness.launch(world)
  try {
    const before = (await world.model_calls("extractor")).length
    await harness.open_page(world.page("article.html"), "How solar panels got cheap")
    await mine_on(harness)
    const reader = await eventually(
      () => harness.in_lenses<string | null>(`document.querySelector("article.reader h1")?.innerText ?? null`),
      (values) => values.includes("How solar panels got cheap"),
    )
    expect(reader).toContain("How solar panels got cheap")
    const text = await harness.last_lens_text()
    expect(text).toContain("The panel did not change much.")
    expect(text).not.toContain("Buy a car today")
    expect(await world.model_calls("extractor")).toHaveLength(before)
  } finally {
    await harness.close()
  }
})

test("a saved spec that stopped matching is regenerated and saved as the next version", async () => {
  const harness = await Harness.launch(world, { files: { ".moi/extractors/seed.v1.json": OLD_SHOP_SPEC } })
  try {
    await harness.open_page(world.page("shop.html"), "Shop: desk lamp")
    await mine_on(harness)
    const text = await eventually(
      () => harness.last_lens_text(),
      (value) => value.includes("Dimmable LED desk lamp"),
    )
    expect(text).toContain("$24.99")
    expect(text).toContain("Banker's lamp with green glass shade")
    const request = JSON.parse((await world.model_calls("extractor")).at(-1)?.payload.messages[1].content ?? "{}")
    expect(request.last_error).toBe("the saved spec v1 found 0 items with a title and url")
    expect(harness.files_in(".moi/extractors").filter((name) => name.endsWith(".v2.json"))).toHaveLength(1)
  } finally {
    await harness.close()
  }
})

test("a page Mine cannot read leaves the original and says why", async () => {
  const harness = await Harness.launch(world)
  try {
    await harness.open_page(world.page("x_login.html"), "Log in to X")
    await harness.chrome.locator("button.mine").click()
    await expect(harness.chrome.locator(".notice", { hasText: "Could not make a Mine view of this page" })).toHaveCount(1, { timeout: 30_000 })
    await expect(harness.chrome.locator("button.mine.on")).toHaveCount(0)
  } finally {
    await harness.close()
  }
})

test("asking for a layout builds a smoke tested lens in under a minute that still shows what you saw; rollback restores the old look", async () => {
  const harness = await Harness.launch(world)
  try {
    await eventually(
      () => harness.lens_text(),
      (value) => value.includes("New laptop chip"),
    )
    const shown = await harness.brain<{ items: Array<{ item: { item_id: string } }> }>("/view/feed", {})
    await harness.brain("/events", { events: shown.items.map((entry) => ({ view_id: "feed", item_id: entry.item.item_id, event_kind: "seen" })) })
    await harness.chat("make it a two column magazine")
    await expect(harness.chrome.locator(".message.moi .diff").first()).toContainText("+make it a two column magazine")
    const started = Date.now()
    await harness.chrome.locator(".proposal_actions .confirm").click()
    await expect(harness.chrome.locator(".message.moi", { hasText: "New look for feed is live" })).toHaveCount(1, { timeout: 60_000 })
    const text = await eventually(
      () => harness.lens_text(),
      (value) => value.includes("Look: make it a two column magazine") && value.includes("New laptop chip"),
    )
    expect(text).toContain("Look: make it a two column magazine")
    expect(Date.now() - started).toBeLessThan(60_000)
    console.log(`generated lens live after ${Date.now() - started} ms`)
    expect(harness.files_in(".moi/lenses/feed")).toEqual(["current.json", "v1.html"])

    await harness.chat("bring back the previous look")
    await harness.chrome.locator(".proposal_actions .confirm").last().click()
    const restored = await eventually(
      () => harness.lens_text(),
      (value) => !value.includes("Look:") && value.includes("New laptop chip"),
    )
    expect(restored).not.toContain("Look:")
  } finally {
    await harness.close()
  }
})

test("a lens that fails the smoke test is retried once with the error, then the current look stays", async () => {
  const harness = await Harness.launch(world)
  try {
    await eventually(
      () => harness.lens_text(),
      (value) => value.includes("New laptop chip"),
    )
    const before = (await world.model_calls("lens")).length
    harness.write("views/feed.md", harness.file("views/feed.md").replace("## Layout\n", "## Layout\nBROKEN layout\n"))
    await harness.chrome.locator("button.tab.view", { hasText: "Feed" }).click()
    await expect(harness.chrome.locator(".message.moi", { hasText: "That look did not work" })).toHaveCount(1, { timeout: 30_000 })
    const calls = (await world.model_calls("lens")).slice(before)
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1].payload.messages[1].content).last_error).toBe("30 of 30 items were not rendered with data-item-id")
    expect(await harness.lens_text()).toContain("New laptop chip")
    expect(await harness.lens_text()).not.toContain("Look:")

    harness.write("views/feed.md", harness.file("views/feed.md").replace("BROKEN layout", "FIXABLE cards"))
    await harness.chrome.locator("button.tab.view", { hasText: "Feed" }).click()
    const text = await eventually(
      () => harness.lens_text(),
      (value) => value.includes("Look: FIXABLE cards"),
    )
    expect(text).toContain("Look: FIXABLE cards")
  } finally {
    await harness.close()
  }
})

test("chat on a Mine page edits that site's view and rebuilds its lens", async () => {
  const harness = await Harness.launch(world)
  try {
    await harness.open_page(world.page("shop.html"), "Shop: desk lamp")
    await mine_on(harness)
    await eventually(
      () => harness.last_lens_text(),
      (value) => value.includes("Dimmable LED desk lamp"),
    )
    await expect(harness.chrome.locator(".chat_view")).toHaveText("Changes apply to 127.0.0.1")
    await harness.chat("make it a compact table")
    await expect(harness.chrome.locator(".message.moi .diff").first()).toContainText("views/site_127.0.0.1.md")
    await harness.chrome.locator(".proposal_actions .confirm").click()
    const text = await eventually(
      () => harness.last_lens_text(),
      (value) => value.includes("Look: make it a compact table") && value.includes("Dimmable LED desk lamp"),
    )
    expect(text).toContain("Look: make it a compact table")
    expect(harness.file("views/site_127.0.0.1.md")).toBe("# 127.0.0.1\n\n## Layout\nmake it a compact table\n")
    await expect(harness.chrome.locator("button.tab.view")).toHaveText(["Feed"])
  } finally {
    await harness.close()
  }
})
