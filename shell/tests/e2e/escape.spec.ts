// The lens escape suite: 55 lenses that each try a way out of the sandbox (the network, navigation, windows, workers,
// Node, forged clicks, downloads, dialogs, printing, handlers written into the page, reloading media tokens),
// installed and opened the way any generated lens is. None may reach the fake world's canary, open anything,
// navigate, download, block the app or record an action you did not take.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { sleep } from "../../src/shared/timing"
import { FakeWorld, Harness, eventually } from "./harness"

const ESCAPE_DIR = path.resolve(__dirname, "..", "..", "..", "fixtures", "lens_escape")

interface Debug {
  store: { events: Record<string, number> }
}

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

test("every one of the 55 escape lenses stays contained", async () => {
  test.setTimeout(240_000)
  const lenses = readdirSync(ESCAPE_DIR).filter((file) => file.endsWith(".html")).sort()
  expect(lenses).toHaveLength(55)
  const views: Record<string, string> = {}
  const files: Record<string, string> = {}
  for (const file of lenses) {
    const view_id = `escape_${file.slice(0, 2)}`
    // The token reloading lens needs an item with an image to try its token on.
    const feed = file.includes("token_reloads") ? "photos" : "tech"
    views[view_id] = `# Escape ${file.slice(0, 2)}\n\n## Sources\n* RSS: ${world.base_url}/rss/${feed}.xml\n`
    files[`.moi/lenses/${view_id}/v1.html`] = readFileSync(path.join(ESCAPE_DIR, file), "utf-8").replaceAll("BASE", world.base_url)
    files[`.moi/lenses/${view_id}/current.json`] = JSON.stringify({ version: 1, layout_hash: null })
  }
  const harness = await Harness.launch(world, { views, files })
  try {
    // The first view opens before its feed is read; it is filled before the others take the front.
    await eventually(
      () => harness.in_lenses<number>(`document.querySelectorAll("[data-item-id]").length`),
      (counts) => counts.length === 1 && counts[0] > 0,
    )
    await harness.app.evaluate(({ session }) => {
      const downloads: boolean[] = []
      Object.assign(globalThis, { lens_downloads: downloads })
      session.fromPartition("lens").on("will-download", (event) => downloads.push(event.defaultPrevented))
    })
    for (const view_id of Object.keys(views)) {
      // Fifty view tabs overflow the tab strip, so the click goes to each button directly.
      await harness.chrome.locator("button.tab.view", { hasText: `Escape ${view_id.slice(-2)}` }).dispatchEvent("click")
    }
    const rendered = await eventually(
      () => harness.in_lenses<number>(`document.querySelectorAll("[data-item-id]").length`),
      (counts) => counts.length === 55 && counts.every((count) => count > 0),
      90_000,
    )
    expect(rendered).toHaveLength(55)
    await sleep(3_000)
    expect(await world.hits("/canary/")).toEqual([])
    const titles = await harness.in_lenses<string>("document.title")
    expect(titles.every((title) => title.startsWith("Escape: "))).toBe(true)
    // Dialogs and printing return at once instead of blocking the lens behind a native window.
    expect(titles).toContain("Escape: alert_loop done")
    expect(titles).toContain("Escape: print_loop done")
    const downloads = await harness.app.evaluate(() => (globalThis as unknown as { lens_downloads: boolean[] }).lens_downloads)
    expect(downloads.length).toBeGreaterThan(0)
    expect(downloads.every((prevented) => prevented)).toBe(true)
    // The token lens loaded its image's token a dozen ways; the image's site saw only the one fetch made when the
    // token was handed out.
    expect((await world.hits("/images/pixel.png")).filter((hit) => hit.path === "/images/pixel.png")).toHaveLength(1)
    await expect(harness.chrome.locator(".tab.web")).toHaveCount(0)
    await expect(harness.chrome.locator(".player_bar")).toHaveCount(0)
    const events = (await harness.brain<Debug>("/debug")).store.events
    expect([events.open ?? 0, events.less_like_this ?? 0]).toEqual([0, 0])
    const others = await harness.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((contents) => contents.getURL()).filter((url) => url.includes("/canary/")),
    )
    expect(others).toEqual([])
    // The control: a page in a normal tab does reach the canary, so a lens that got out would have been seen.
    await harness.chrome.locator(".address input").fill(`${world.base_url}/canary/control`)
    await harness.chrome.locator(".address input").press("Enter")
    await eventually(
      () => world.hits("/canary/"),
      (hits) => hits.length > 0,
    )
    expect((await world.hits("/canary/")).map((hit) => hit.path)).toEqual(["/canary/control"])
  } finally {
    await harness.close()
  }
})
