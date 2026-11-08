// M2 exit criteria in the real app: rules in plain words by chat and by hand, reasons on items, caught up.
import { expect, test } from "@playwright/test"
import { FakeWorld, Harness, eventually } from "./harness"

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

async function loaded(harness: Harness, needle: string): Promise<void> {
  await eventually(
    () => harness.lens_text(),
    (text) => text.includes(needle),
  )
}

async function first_card(harness: Harness): Promise<string> {
  const [text] = await harness.in_lenses<string>(`document.querySelector("[data-item-id]").innerText`)
  return text
}

test("a chat edit hides shorts and politics, puts maya first and explains why", async () => {
  const harness = await Harness.launch(world)
  try {
    await loaded(harness, "One minute physics trick")
    await loaded(harness, "Post number 0 from maya")
    await harness.chat("No shorts, hide politics, maya first")
    const diff = harness.chrome.locator(".message.moi .diff").first()
    await expect(diff).toContainText("views/feed.md")
    await expect(diff).toContainText("+* No shorts.")
    await expect(diff).toContainText("+* Posts from @maya always first.")
    expect(harness.file("views/feed.md")).not.toContain("No shorts")

    await harness.chrome.locator(".proposal_actions .confirm").click()
    await expect(harness.chrome.locator(".proposal_status.applied")).toHaveCount(1)
    const text = await eventually(
      () => harness.lens_text(),
      (value) => !value.includes("One minute physics trick") && !value.includes("Election results") && !value.includes("Senate debates"),
    )
    expect(text).not.toContain("One minute physics trick")
    expect(text).not.toContain("about the election")
    expect(text).toContain("New laptop chip doubles battery life")
    expect(await first_card(harness)).toContain("Maya R")
    expect(text).toContain("boost: author maya")
    expect(harness.file("views/feed.md")).toContain("* No shorts.\n* Hide politics.\n* Posts from @maya always first.")
    await expect(harness.chrome.locator(".message.moi", { hasText: "I understood:" })).toHaveCount(1)
  } finally {
    await harness.close()
  }
})

test("less like this proposes a dislike and confirming hides the item everywhere", async () => {
  const harness = await Harness.launch(world)
  try {
    await loaded(harness, "Local bakery wins national prize")
    await harness.in_lenses(
      `[...document.querySelectorAll("[data-item-id]")].find((node) => node.innerText.includes("Local bakery")).querySelector(".less").click()`,
    )
    await expect(harness.chrome.locator(".message.you").last()).toHaveText("Less like this: Local bakery wins national prize")
    await expect(harness.chrome.locator(".message.moi .diff").first()).toContainText("memory/dislikes.md")
    await harness.chrome.locator(".proposal_actions .confirm").click()
    const text = await eventually(
      () => harness.lens_text(),
      (value) => !value.includes("Local bakery"),
    )
    expect(text).not.toContain("Local bakery")
    expect(text).toContain("New laptop chip")
    expect(harness.file("memory/dislikes.md")).toContain('* Posts like "Local bakery wins national prize"')
  } finally {
    await harness.close()
  }
})

test("discarding a proposal changes nothing", async () => {
  const harness = await Harness.launch(world)
  try {
    await loaded(harness, "One minute physics trick")
    const before = harness.file("views/feed.md")
    await harness.chat("no shorts")
    await harness.chrome.locator(".proposal_actions button", { hasText: "Discard" }).click()
    await expect(harness.chrome.locator(".proposal_status.discarded")).toHaveCount(1)
    expect(harness.file("views/feed.md")).toBe(before)
    expect(await harness.lens_text()).toContain("One minute physics trick")
  } finally {
    await harness.close()
  }
})

test("hand edits re-render when you come back to the view; the end says caught up", async () => {
  const harness = await Harness.launch(world)
  try {
    await loaded(harness, "Senate debates the election budget")
    harness.write("views/feed.md", harness.file("views/feed.md").replace("## Rules\n", "## Rules\n* Hide politics.\n"))
    await harness.chrome.locator("button.tab.view", { hasText: "Feed" }).click()
    const text = await eventually(
      () => harness.lens_text(),
      (value) => !value.includes("Senate debates"),
    )
    expect(text).not.toContain("Election results")
    await expect(harness.chrome.locator(".message.moi", { hasText: "I understood:" })).toContainText("Hide politics")
    const [footer] = await eventually(
      () => harness.in_lenses<string>(`document.getElementById("footer").innerText`),
      (values) => values[0] === "You're caught up.",
    )
    expect(footer).toBe("You're caught up.")
  } finally {
    await harness.close()
  }
})

test("with a hosted fast slot and the privacy switch off, chat asks for a local model", async () => {
  const harness = await Harness.launch(world, { fast_slot: { base_url: "https://models.example.invalid/v1", model: "big" } })
  try {
    await loaded(harness, "New laptop chip")
    await expect(harness.chrome.locator(".notice", { hasText: "Topic tagging paused" })).toHaveCount(1)
    await harness.chat("no shorts")
    await expect(harness.chrome.locator(".message.moi").last()).toContainText("/model privacy on")
  } finally {
    await harness.close()
  }
})

test("slash commands: /newview makes a tab, /layout touches only the layout, /model and /help answer at once", async () => {
  const harness = await Harness.launch(world)
  try {
    await loaded(harness, "New laptop chip")
    await harness.chrome.locator(".composer input").fill("/me")
    await expect(harness.chrome.locator(".hint .hint_usage")).toHaveText(["/memory <what to remember or forget>"])
    await harness.chat("/help")
    await expect(harness.chrome.locator(".message.moi").last()).toContainText("/newview <name> [what it should be]")

    await harness.chat("/newview tech")
    await expect(harness.chrome.locator("button.tab.view.active")).toHaveText("tech")
    await expect(harness.chrome.locator(".chat_view")).toHaveText("Changes apply to tech")
    expect(harness.file("views/tech.md")).toBe("# tech\n\n## Sources\n\n## Rules\n\n## Layout\n")

    await harness.chat("/model")
    await expect(harness.chrome.locator(".message.moi").last()).toContainText("fast: fake via custom (on this machine)")

    await harness.chrome.locator("button.tab.view", { hasText: "Feed" }).click()
    await harness.chat("/layout no shorts and make it compact")
    const diff = harness.chrome.locator(".message.moi .diff").last()
    await expect(diff).toContainText("+no shorts and make it compact")
    await expect(diff).not.toContainText("+* No shorts.")
    await harness.chrome.locator(".proposal_actions button", { hasText: "Discard" }).click()
    expect(harness.file("views/feed.md")).not.toContain("compact")
  } finally {
    await harness.close()
  }
})
