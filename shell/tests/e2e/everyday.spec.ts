// Everyday use in the real app: the chat, the status line, a restart and pairing Chrome again after a reset.
import { expect, test } from "@playwright/test"
import { ChromeWithExtension, FakeWorld, Harness, eventually, unpacked_extension_id } from "./harness"

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

interface ViewItems {
  items: Array<{ item: { item_id: string; title: string | null; text: string | null } }>
}

function relay_state(browser: ChromeWithExtension): Promise<string> {
  return browser.worker.evaluate(() => (globalThis as unknown as { moi_relay: { relay: { state: string } } }).moi_relay.relay.state)
}

async function loaded(harness: Harness, needle: string): Promise<string> {
  return eventually(
    () => harness.lens_text(),
    (text) => text.includes(needle),
  )
}

test("picking a command fills it in and the chat follows the replies to the bottom", async () => {
  const harness = await Harness.launch(world)
  try {
    await loaded(harness, "New laptop chip")
    const replies = await harness.chrome.locator(".message.moi").count()
    await harness.chrome.locator(".composer input").fill("/me")
    await harness.chrome.locator(".hint", { hasText: "/memory" }).click()
    await expect(harness.chrome.locator(".composer input")).toHaveValue("/memory ")
    await expect(harness.chrome.locator(".message.moi")).toHaveCount(replies)
    for (let index = 0; index < 6; index++) await harness.chat("/help")
    const at_bottom = await harness.chrome.locator(".messages").evaluate((list) => list.scrollTop + list.clientHeight >= list.scrollHeight - 4)
    expect(at_bottom).toBe(true)
  } finally {
    await harness.close()
  }
})

test("the status line shows the feed updating, then Idle", async () => {
  const harness = await Harness.launch(world)
  try {
    await expect(harness.chrome.locator(".status .activity", { hasText: "Updating feed" })).toBeVisible({ timeout: 20_000 })
    await expect(harness.chrome.locator(".status.idle")).toHaveText("Idle", { timeout: 45_000 })
  } finally {
    await harness.close()
  }
})

test("after a restart the feed you were reading is still there", async () => {
  const first = await Harness.launch(world)
  const read = await (async () => {
    try {
      await loaded(first, "New laptop chip")
      const shown = await first.brain<ViewItems>("/view/feed", {})
      await first.brain("/events", { events: shown.items.map((entry) => ({ view_id: "feed", item_id: entry.item.item_id, event_kind: "seen" })) })
      return shown.items.map((entry) => entry.item.title ?? entry.item.text ?? "")
    } finally {
      await first.close(true)
    }
  })()
  const again = await Harness.launch(world, { root: first.root })
  try {
    const text = await loaded(again, "New laptop chip")
    for (const title of read.filter(Boolean).slice(0, 5)) expect(text).toContain(title)
  } finally {
    await again.close()
  }
})

test("after openMoi forgets a pairing, the app says to pair again, then Allow pairs Chrome anew", async () => {
  const app = await Harness.launch(world, { files: { ".moi/relay_trusted.json": JSON.stringify({ [unpacked_extension_id()]: "aa".repeat(32) }) } })
  const browser = await ChromeWithExtension.launch(world, app.relay_port, "bb".repeat(32))
  try {
    await eventually(() => relay_state(browser), (value) => value === "unrecognized", 30_000)
    await expect(app.chrome.locator(".relay")).toHaveText("Chrome: pair again", { timeout: 10_000 })
    await expect(app.chrome.locator(".notice", { hasText: "press Pair again" })).toHaveCount(1)
    await expect(app.chrome.locator(".notice button", { hasText: "Allow" })).toHaveCount(0)
    await browser.worker.evaluate(() => (globalThis as unknown as { moi_relay: { pair_again(): Promise<void> } }).moi_relay.pair_again())
    await expect(app.chrome.locator(".notice", { hasText: "press Pair again" })).toHaveCount(0, { timeout: 10_000 })
    await app.chrome.locator(".notice", { hasText: "wants to read pages for openMoi" }).locator("button", { hasText: "Allow" }).click({ timeout: 30_000 })
    await expect(app.chrome.locator(".relay.on")).toHaveText("Chrome connected", { timeout: 30_000 })
    expect(await relay_state(browser)).toBe("connected")
    const stored = await browser.worker.evaluate(async () => (await chrome.storage.local.get("relay_secret")).relay_secret)
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toBe("bb".repeat(32))
  } finally {
    await browser.close()
    await app.close()
  }
})

function posts_in(text: string): number {
  return (text.match(/Endless post \d+/g) ?? []).length
}

test("a page you add as a source keeps reading as you scroll, filtered by your rules, in one reader tab", async () => {
  const feed = `# Feed\n\n## Sources\n* Page: ${world.base_url}/pages/endless.html\n\n## Rules\n* Hide crypto\n`
  const harness = await Harness.launch(world, { views: { feed } })
  try {
    const first = await eventually(
      () => harness.lens_text(),
      (text) => posts_in(text) >= 10,
      60_000,
    )
    const scrolled = await eventually(
      async () => {
        await harness.in_lenses("window.scrollTo(0, document.body.scrollHeight)")
        return harness.lens_text()
      },
      (text) => posts_in(text) >= posts_in(first) + 30,
      120_000,
    )
    expect(scrolled).not.toContain("crypto")
    expect(scrolled).not.toContain("You're caught up.")
    const readers = await harness.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().includes("endless.html")).length)
    expect(readers).toBe(1)
    expect(harness.files_in(".moi/extractors").length).toBe(1)
  } finally {
    await harness.close()
  }
})

test("a rule only a model can judge filters a page source in the real app", async () => {
  const feed = `# Feed\n\n## Sources\n* Page: ${world.base_url}/pages/endless.html\n\n## Rules\n* Only events and birthdays.\n`
  const harness = await Harness.launch(world, { views: { feed } })
  try {
    const text = await eventually(
      () => harness.lens_text(),
      (shown) => posts_in(shown) >= 3,
      60_000,
    )
    const posts = text.match(/Endless post \d+[^\n]*/g) ?? []
    expect(posts.length).toBeGreaterThanOrEqual(3)
    expect(posts.every((post) => post.includes("birthday party"))).toBe(true)
  } finally {
    await harness.close()
  }
})
