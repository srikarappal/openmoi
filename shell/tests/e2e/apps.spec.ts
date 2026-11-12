// Apps on this Mac in the real app: Calendar and Mail items in a view through the Mac helper, macOS asked only when
// you say /allow, and nothing ever clicked or written in another app.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { FakeWorld, Harness, eventually } from "./harness"

const FAKE_HELPER = path.resolve(__dirname, "..", "..", "..", "fixtures", "fake_mac_helper.py")

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

function at(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z")
}

function apps_world(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "moi-apps-"))
  const file = path.join(folder, "apps.json")
  const events = [
    { id: "e2", title: "Lithium recycling review", start: at(3), end: at(3.5), all_day: false, location: "Room 4", calendar: "Work", notes: "", attendees: [{ name: "Maya Kim", email: "maya@example.com" }] },
    { id: "e1", title: "Standup", start: at(1), end: at(1.25), all_day: false, location: "", calendar: "Work", notes: "", attendees: [] },
  ]
  const mail = [
    { id: "<n1@news>", subject: "The Battery Weekly #12", sender: "Battery Weekly <hello@batteryweekly.example>", date: at(-5).replace("Z", ".000Z"), unsubscribe: true, body: "View this in your browser: https://batteryweekly.example/12 Lithium prices fell." },
    { id: "<p1@friend>", subject: "Dinner?", sender: "Sam <sam@example.com>", date: at(-4).replace("Z", ".000Z"), unsubscribe: false, body: "Are you free Friday?" },
  ]
  writeFileSync(file, JSON.stringify({ status: { calendar: "not_asked", mail: "allowed" }, grant: { calendar: "allowed" }, calendar: events, mail }))
  return file
}

test("Calendar and Mail fill a view through the Mac helper, Calendar only once you allow it, and nothing is clicked", async () => {
  const apps = apps_world()
  const feed = `# Feed\n\n## Sources\n* RSS: ${world.base_url}/rss/tech.xml\n`
  // Two days, so meetings an hour or three away still show when the test runs late in the evening.
  const today = "# Today\n\n## Sources\n* Calendar: next 2 days\n* Mail: newsletters\n"
  const harness = await Harness.launch(world, { views: { feed, today }, env: { MOI_MAC_HELPER: FAKE_HELPER, MOI_FAKE_APPS: apps } })
  try {
    await eventually(
      () => harness.lens_text(),
      (text) => text.includes("New laptop chip"),
    )
    await harness.chrome.locator("button.tab.view", { hasText: "Today" }).click()
    await expect(harness.chrome.locator("button.tab.view.active")).toHaveText("Today")
    const before = await eventually(
      () => harness.last_lens_text(),
      (text) => text.includes("The Battery Weekly #12"),
      60_000,
    )
    expect(before).not.toContain("Standup")
    expect(before).not.toContain("Dinner?")
    const warned = await harness.brain<{ warnings: string[] }>("/view/today", {})
    expect(warned.warnings.some((warning) => warning.startsWith("app:calendar: needs your permission: say /allow calendar. openMoi would read it to show today's meetings"))).toBe(true)

    await harness.chat("/allow calendar")
    await expect(harness.chrome.locator(".message.moi").last()).toContainText("openMoi can read calendar now")
    const after = await eventually(
      () => harness.last_lens_text(),
      (text) => text.includes("Standup") && text.includes("Lithium recycling review") && text.includes("Room 4"),
      60_000,
    )
    expect(after.indexOf("Standup")).toBeLessThan(after.indexOf("Lithium recycling review"))

    const tabs = await harness.chrome.locator(".tab.web").count()
    await harness.click_lens(`[...document.querySelectorAll("[data-item-id]")].find((node) => node.innerText.includes("Standup")).querySelector(".title")`, true)
    await expect(harness.chrome.locator(".notice", { hasText: "This is in Calendar on your Mac" })).toBeVisible()
    expect(await harness.chrome.locator(".tab.web").count()).toBe(tabs)

    const asked = readFileSync(`${apps}.log`, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { command: string; args: Record<string, unknown> })
    expect(new Set(asked.map((call) => call.command))).toEqual(new Set(["calendar", "mail", "request"]))
    expect(asked.filter((call) => call.command === "request").map((call) => call.args)).toEqual([{ capability: "calendar" }])
  } finally {
    await harness.close()
  }
})
