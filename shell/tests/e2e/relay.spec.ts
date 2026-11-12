// The Chrome relay in the real app: a real Chromium with the openMoi extension, signed in where openMoi is not.
import { expect, test } from "@playwright/test"
import { sleep } from "../../src/shared/timing"
import { ChromeWithExtension, FakeWorld, Harness, eventually, unpacked_extension_id } from "./harness"

interface Debug {
  store: { items: Record<string, number> }
  relay: { connected: boolean; passive_batches: number }
}

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

async function launch_both(): Promise<{ app: Harness; chrome: ChromeWithExtension }> {
  const app = await Harness.launch(world, { x_page: "x_home_signed_in.html" })
  const chrome = await ChromeWithExtension.launch(world, app.relay_port)
  return { app, chrome }
}

async function approve(app: Harness): Promise<void> {
  await app.chrome.locator(".notice", { hasText: "wants to read pages for openMoi" }).locator("button", { hasText: "Allow" }).click({ timeout: 30_000 })
  await expect(app.chrome.locator(".relay.on")).toHaveText("Chrome connected")
}

async function close_both(app: Harness, chrome: ChromeWithExtension): Promise<void> {
  await chrome.close()
  await app.close()
}

test("until you allow Chrome nothing is read there; after, X comes through your Chrome sign in by itself", async () => {
  const { app, chrome } = await launch_both()
  try {
    const needs_chrome = app.chrome.locator(".notice", { hasText: "open Chrome with the openMoi extension" })
    await expect(needs_chrome).toHaveCount(1, { timeout: 30_000 })
    await expect(app.chrome.locator(".relay")).toHaveText("Chrome waiting")
    expect((await app.brain<Debug>("/debug")).relay.connected).toBe(false)
    expect(await app.lens_text()).not.toContain("Post number")

    await approve(app)
    await expect(app.chrome.locator(".message.moi", { hasText: "Chrome is connected" })).toHaveCount(1)
    const text = await eventually(
      () => app.lens_text(),
      (value) => value.includes("Post number 0 from maya"),
    )
    expect(text).toContain("Post number 0 from maya")
    await expect(needs_chrome).toHaveCount(0)
    expect((await app.brain<Debug>("/debug")).store.items.x).toBeGreaterThanOrEqual(5)
    // One reader tab stays open in Chrome while openMoi reads, so scrolling on continues where it stopped.
    expect(chrome.urls().filter((url) => url.includes("x_home_signed_in"))).toHaveLength(1)
  } finally {
    await close_both(app, chrome)
  }
})

test("after a restart openMoi waits for the Chrome you paired, so X never asks for a sign in", async () => {
  const secret = "5e".repeat(32)
  const app = await Harness.launch(world, { x_page: "x_home_signed_in.html", files: { ".moi/relay_trusted.json": JSON.stringify({ [unpacked_extension_id()]: secret }) } })
  await sleep(3_000)
  const chrome = await ChromeWithExtension.launch(world, app.relay_port, secret)
  try {
    const seen = new Set<string>()
    await eventually(
      async () => {
        for (const text of await app.chrome.locator(".notice").allInnerTexts()) seen.add(text)
        return app.lens_text()
      },
      (value) => value.includes("Post number 0 from maya"),
    )
    await expect(app.chrome.locator(".relay.on")).toHaveText("Chrome connected")
    expect([...seen].filter((text) => text.includes("Chrome"))).toEqual([])
  } finally {
    await close_both(app, chrome)
  }
})

test("opening an item opens it in your Chrome, not in openMoi", async () => {
  const { app, chrome } = await launch_both()
  try {
    await approve(app)
    await eventually(
      () => app.lens_text(),
      (value) => value.includes("New laptop chip"),
    )
    await app.click_lens(`[...document.querySelectorAll("[data-item-id]")].find((node) => node.innerText.includes("New laptop chip"))`)
    const urls = await eventually(
      async () => chrome.urls(),
      (values) => values.some((url) => url.includes("/articles/tech1")),
    )
    expect(urls.some((url) => url.includes("/articles/tech1"))).toBe(true)
    await expect(app.chrome.locator(".tab.web")).toHaveCount(0)
  } finally {
    await close_both(app, chrome)
  }
})

test("Mine this page in Chrome shows your version in openMoi and leaves your tab alone", async () => {
  const { app, chrome } = await launch_both()
  try {
    await approve(app)
    const page = await chrome.context.newPage()
    await page.goto(world.page("listing.html"))
    expect(await chrome.mine(page.url())).toBe(true)
    await expect(app.chrome.locator(".tab.chrome.active")).toContainText("Mine: Hacker Newz", { timeout: 30_000 })
    const text = await eventually(
      () => app.last_lens_text(),
      (value) => value.includes("Rust 2.0 released"),
    )
    expect(text).toContain("Why SQLite is everywhere")
    await expect(app.chrome.locator(".chat_view")).toHaveText("Changes apply to 127.0.0.1")
    await app.click_lens(`[...document.querySelectorAll("[data-item-id]")].find((node) => node.innerText.includes("Ask HN"))`)
    const urls = await eventually(
      async () => chrome.urls(),
      (values) => values.some((url) => url.endsWith("/pages/item?id=903")),
    )
    expect(urls).toContain(world.page("listing.html"))
    await app.chrome.locator(".tab.chrome .close").click()
    await expect(app.chrome.locator(".tab.chrome")).toHaveCount(0)
    expect(chrome.urls()).toContain(world.page("listing.html"))
  } finally {
    await close_both(app, chrome)
  }
})

test("X pages you browse in Chrome yourself fill your Feed without any automation", async () => {
  const { app, chrome } = await launch_both()
  try {
    await approve(app)
    const before = (await app.brain<Debug>("/debug")).relay.passive_batches
    const page = await chrome.context.newPage()
    await page.goto(world.page("x_home_signed_in.html"))
    const debug = await eventually(
      () => app.brain<Debug>("/debug"),
      (value) => value.relay.passive_batches > before,
      20_000,
    )
    expect(debug.relay.passive_batches).toBeGreaterThan(before)
    expect(debug.store.items.x).toBeGreaterThanOrEqual(5)
  } finally {
    await close_both(app, chrome)
  }
})
