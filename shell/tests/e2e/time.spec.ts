// Time in the real app: why you are here, visits that end, editions that hold back what comes after them.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { FakeWorld, Harness, TOKEN, eventually } from "./harness"

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

// A time of day on this machine's clock, hours from now, as a Time line writes it.
function clock_in(hours: number): string {
  const moment = new Date(Date.now() + hours * 3_600_000)
  return `${moment.getHours()}:${String(moment.getMinutes()).padStart(2, "0")}`
}

test("openMoi asks why you are here, and a visit ends with what you read", async () => {
  const views = {
    feed: `# Feed\n\n## Sources\n* RSS: ${world.base_url}/rss/news.xml\n`,
    break: `# Break\n\n## Sources\n* RSS: ${world.base_url}/rss/tech.xml\n\n## Time\n* A visit lasts 1 minute.\n`,
  }
  const harness = await Harness.launch(world, { views, env: { MOI_MINUTE_MS: "4000" } })
  try {
    await expect(harness.chrome.locator(".gate h1")).toHaveText("Why are you here?")
    await expect(harness.chrome.locator(".choice .choice_note")).toHaveText(["1 minute visit"])
    await harness.chrome.locator(".choice", { hasText: "Break" }).click()
    await eventually(
      () => harness.lens_text(),
      (text) => text.includes("New laptop chip"),
    )
    await expect(harness.chrome.locator(".stop h1")).toHaveText("Your 1 minute in Break is up.", { timeout: 15_000 })
    await expect(harness.chrome.locator(".read li").first()).toBeVisible()
    await harness.chrome.locator(".stop_actions .primary").click()
    await expect(harness.chrome.locator(".gate h1")).toBeVisible()
  } finally {
    await harness.close()
  }
})

test("an edition shows only what was read by it, while its next read runs in the background", async () => {
  const views = {
    feed: `# Feed\n\n## Sources\n* RSS: ${world.base_url}/rss/tech.xml\n\n## Time\n* Editions at ${clock_in(3)}.\n`,
    morning: `# Morning\n\n## Sources\n* Page: ${world.base_url}/pages/endless.html\n\n## Time\n* Editions at ${clock_in(0.5)}.\n`,
  }
  const harness = await Harness.launch(world, { views, env: { MOI_MINUTE_MS: "1000" } })
  try {
    await expect(harness.chrome.locator(".notice", { hasText: "That is all of the" })).toBeVisible({ timeout: 20_000 })
    expect(await harness.lens_text()).not.toContain("New laptop chip")
    const editions = path.join(harness.home, ".moi", "editions.json")
    await eventually(
      async () => (existsSync(editions) ? readFileSync(editions, "utf-8") : ""),
      (text) => text.includes('"morning"'),
      60_000,
    )
    const debug = await (await fetch(`${harness.brain_url}/debug`, { headers: { "x-moi-token": TOKEN } })).json()
    expect(debug.store.items["page:127.0.0.1/pages/endless.html"]).toBeGreaterThanOrEqual(30)
    expect(debug.store.items["rss:tech"]).toBeGreaterThan(0)
    await harness.chrome.locator(".notice", { hasText: "That is all of the" }).getByRole("button", { name: "Open anyway" }).click()
    await eventually(
      () => harness.lens_text(),
      (text) => text.includes("New laptop chip"),
    )
    await harness.chat("/mirror")
    await expect(harness.chrome.locator(".message.moi").last()).toContainText("rss:tech")
    await expect(harness.chrome.locator(".message.moi").last()).toContainText("opened early 1 time")
  } finally {
    await harness.close()
  }
})

test("a summarize rule reads articles in full in the background and their cards gain a summary in place", async () => {
  const feed = `# Feed\n\n## Sources\n* RSS: ${world.base_url}/rss/tech.xml\n\n## Rules\n* Summarize everything.\n`
  const harness = await Harness.launch(world, { views: { feed }, env: { MOI_MINUTE_MS: "1500" } })
  try {
    await eventually(
      () => harness.lens_text(),
      (text) => text.includes("New laptop chip"),
    )
    const summary = await eventually(
      () => harness.in_lenses<string>("Array.from(document.querySelectorAll('.summary'), (node) => node.textContent).join('|')").then((texts) => texts.join("|")),
      (text) => text.includes("Summary of"),
      60_000,
    )
    expect(summary).toContain("Summary of /articles/")
  } finally {
    await harness.close()
  }
})
