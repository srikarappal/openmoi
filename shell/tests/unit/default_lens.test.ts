import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { synthetic_item as view_item, synthetic_view_items } from "../../src/shared/fixtures"
import type { LensKind } from "../../src/shared/types"
import { run_lens } from "./lens_contract"

const DEFAULT_LENS = readFileSync(path.resolve(__dirname, "..", "..", "..", "lenses", "default", "default.html"), "utf-8")

function card_ids(document: Document): string[] {
  return Array.from(document.querySelectorAll("[data-item-id]"), (node) => (node as HTMLElement).dataset.itemId as string)
}

describe("default lens", () => {
  it("announces ready, renders every item and shows the footer state", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    expect(moi.sent).toEqual([{ type: "ready" }])
    moi.render(synthetic_view_items("feed"), "more")
    const document = dom.window.document
    expect(card_ids(document)).toHaveLength(30)
    expect(document.getElementById("footer")?.textContent).toBe("Loading more")
    moi.append([], null)
    expect(document.getElementById("footer")?.textContent).toBe("You're caught up.")
  })

  it("appends only new items and render replaces everything", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("a"), view_item("b")], null)
    moi.append([view_item("b"), view_item("c")], null)
    expect(card_ids(dom.window.document)).toEqual(["a", "b", "c"])
    moi.render([view_item("z")], null)
    expect(card_ids(dom.window.document)).toEqual(["z"])
  })

  it("offers Play here only on YouTube videos, and playing does not open the original", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("v", { kind: "video", url: "https://www.youtube.com/watch?v=VIDEO00001A" }), view_item("a", { url: "https://evil.example/watch?v=VIDEO00001A" })], null)
    const document = dom.window.document
    expect(document.querySelectorAll(".play")).toHaveLength(1)
    ;(document.querySelector("[data-item-id='v'] .play") as HTMLElement).click()
    expect(moi.sent.slice(1)).toEqual([{ type: "play", item_id: "v" }])
  })

  it("opens on click and sends less like this without opening", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("a")], null)
    const card = dom.window.document.querySelector("[data-item-id='a']") as HTMLElement
    ;(card.querySelector(".less") as HTMLElement).click()
    card.click()
    expect(moi.sent.slice(1)).toEqual([{ type: "less_like_this", item_id: "a" }, { type: "open", item_id: "a" }])
  })

  it("shows reasons except the source and renders text safely", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("a", { text: "<img src=x onerror=alert(1)>" }, ["boost: author maya", "recent", "from x"])], null)
    const document = dom.window.document
    expect(Array.from(document.querySelectorAll<HTMLElement>(".chip"), (chip) => chip.textContent)).toEqual(["boost: author maya", "recent"])
    expect(document.querySelector(".text")?.textContent).toBe("<img src=x onerror=alert(1)>")
    expect(document.querySelector(".text img")).toBeNull()
  })

  it("shows product details from extra fields", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("p1", { kind: "product", title: "Lamp", extra: { price_text: "$24.99", rating_text: "4.6 out of 5 stars", price_note: "Lowest you saw: $19.99 on Nov 2" } })], null)
    expect(dom.window.document.querySelector(".details")?.textContent).toBe("$24.99 · 4.6 out of 5 stars")
    expect(dom.window.document.querySelector(".price_note")?.textContent).toBe("Lowest you saw: $19.99 on Nov 2")
  })

  it("uses a grid for listings and a reader for one article", () => {
    const listing = run_lens(DEFAULT_LENS)
    listing.moi.render([view_item("p1", { kind: "product" }), view_item("p2", { kind: "link" })], null)
    expect(listing.dom.window.document.getElementById("items")?.className).toBe("grid")

    const article = run_lens(DEFAULT_LENS)
    const blocks = JSON.stringify([{ type: "h", text: "Heading" }, { type: "p", text: "Body text" }, { type: "img", src: "https://i/a.jpg" }, { type: "quote", text: "Said" }])
    article.moi.render([view_item("art", { kind: "article", source_id: "site:news.example.com", title: "The article", extra: { blocks } })], null)
    const document = article.dom.window.document
    expect(document.querySelector("article.reader h1")?.textContent).toBe("The article")
    expect(document.querySelector("article.reader h2")?.textContent).toBe("Heading")
    expect(document.querySelector("article.reader blockquote")?.textContent).toBe("Said")
    expect(document.querySelector("article.reader img")?.getAttribute("src")).toBe("https://i/a.jpg")
  })

  it.each<LensKind>(["feed", "listing", "article"])("renders every smoke test item for %s, as generated lenses must", (kind) => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    const items = synthetic_view_items(kind)
    moi.render(items, null)
    expect(card_ids(dom.window.document).sort()).toEqual(items.map((entry) => entry.item.item_id).sort())
  })

  it("says nothing new for an empty first render", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([], null)
    expect(dom.window.document.getElementById("footer")?.textContent).toBe("Nothing new yet.")
  })
})

describe("default lens summaries", () => {
  it("shows a summary and what is worth watching on the card, as text", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("v1", { kind: "video", title: "Laptop review", extra: { summary: "<b>Fourteen</b> hours of battery.", worth_watching: "5:30 to 9:45: the test" } }), view_item("v2", { title: "Plain" })], null)
    const document = dom.window.document
    expect(document.querySelector(".summary")?.textContent).toBe("<b>Fourteen</b> hours of battery.")
    expect(document.querySelector(".summary b")).toBeNull()
    expect(document.querySelector(".watching")?.textContent).toBe("Worth watching: 5:30 to 9:45: the test")
    expect(document.querySelectorAll(".summary")).toHaveLength(1)
  })
})

describe("default lens updates", () => {
  it("adds a summary to a card in place, keeping its reasons, and ignores items it does not show", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([{ ...view_item("v1", { title: "Laptop review" }), reasons: ["recent", "boost: author maya"] }], null)
    const document = dom.window.document
    const card = document.querySelector("[data-item-id='v1']")
    moi.update([{ item: view_item("v1", { title: "Laptop review", extra: { summary: "Fourteen hours.", worth_watching: "5:30 to 9:45" } }).item, reasons: [] }, view_item("nope", {})])
    expect(document.querySelector("[data-item-id='v1']")).toBe(card)
    expect(card?.querySelector(".summary")?.textContent).toBe("Fourteen hours.")
    expect(Array.from(card?.querySelectorAll(".chip") ?? [], (chip) => chip.textContent)).toEqual(["recent", "boost: author maya"])
    moi.update([{ item: view_item("v1", { title: "Laptop review", extra: { summary: "Fifteen hours." } }).item, reasons: [] }])
    expect(card?.querySelectorAll(".summary")).toHaveLength(1)
    expect(card?.querySelector(".summary")?.textContent).toBe("Fifteen hours.")
    expect(card?.querySelector(".watching")).toBeNull()
  })
})

describe("default lens groups and summary only cards", () => {
  it("heads each run of one group once, across appends, and starts over on render", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    const grouped = (item_id: string, group: string | null) => ({ ...view_item(item_id), group })
    moi.render([grouped("a1", "rss:tech"), grouped("a2", "rss:tech"), grouped("b1", "rss:news")], "more")
    moi.append([grouped("b2", "rss:news"), grouped("c1", "maya"), grouped("d1", null)], null)
    const document = dom.window.document
    const order = Array.from(document.querySelectorAll("#items > *"), (node) => (node.classList.contains("group") ? `# ${node.textContent}` : (node as HTMLElement).dataset.itemId))
    expect(order).toEqual(["# rss tech", "a1", "a2", "# rss news", "b1", "b2", "# maya", "c1", "d1"])
    moi.render([grouped("b1", "rss:news")], null)
    expect(Array.from(document.querySelectorAll(".group"), (node) => node.textContent)).toEqual(["rss news"])
    moi.render([view_item("z")], null)
    expect(document.querySelectorAll(".group")).toHaveLength(0)
  })

  it("shows a summary in place of the text once it arrives, keeping the text until then", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render(
      [
        { ...view_item("v1", { title: "Long read", text: "All the words." }), summary_only: true },
        view_item("v2", { title: "Plain", text: "Plain words." }),
        { ...view_item("v3", { title: "Done", text: "Its words.", extra: { summary: "Already short." } }), summary_only: true },
      ],
      null,
    )
    const document = dom.window.document
    const card = document.querySelector("[data-item-id='v1']")
    expect(card?.querySelector(".text")?.textContent).toBe("All the words.")
    expect(card?.querySelector(".summary.pending")?.textContent).toBe("Summary on its way")
    expect(document.querySelector("[data-item-id='v3'] .text")).toBeNull()
    expect(document.querySelector("[data-item-id='v3'] .summary")?.textContent).toBe("Already short.")
    expect(document.querySelector("[data-item-id='v2'] .text")?.textContent).toBe("Plain words.")
    expect(document.querySelector("[data-item-id='v2'] .summary")).toBeNull()
    moi.update([{ item: view_item("v1", { title: "Long read", extra: { summary: "The short of it." } }).item, reasons: [] }])
    expect(Array.from(card?.querySelectorAll(".summary") ?? [], (node) => node.textContent)).toEqual(["The short of it."])
    expect(card?.querySelector(".summary.pending")).toBeNull()
    expect(card?.querySelector(".text")).toBeNull()
    moi.update([{ item: view_item("v2", { title: "Plain", extra: { summary: "Plain summary." } }).item, reasons: [] }])
    expect(document.querySelector("[data-item-id='v2'] .text")?.textContent).toBe("Plain words.")
  })
})

describe("default lens collections and reading", () => {
  it("saves to Read later or Watch later, shows Saved and takes it out on a second click", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("a"), { ...view_item("v", { kind: "video", url: "https://www.youtube.com/watch?v=VIDEO00001A" }), collections: ["watch_later"] }], null)
    const document = dom.window.document
    const save = document.querySelector("[data-item-id='a'] .save") as HTMLElement
    const watch = document.querySelector("[data-item-id='v'] .save") as HTMLElement
    expect([save.textContent, watch.textContent]).toEqual(["Read later", "Saved"])
    save.click()
    watch.click()
    expect(moi.sent.slice(1)).toEqual([
      { type: "save", item_id: "a", collection: "read_later" },
      { type: "unsave", item_id: "v", collection: "watch_later" },
    ])
    moi.update([{ item: view_item("a").item, reasons: [], collections: ["read_later"] }])
    expect(save.textContent).toBe("Saved")
    expect(save.getAttribute("aria-pressed")).toBe("true")
    moi.update([{ item: view_item("a", { extra: { summary: "Short." } }).item, reasons: [] }])
    expect(save.textContent).toBe("Saved")
  })

  it("reads an offline copy right in its card, keeps a selected passage and a note, and closes again", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("a", { title: "Long read" }), view_item("b")], null)
    const document = dom.window.document
    expect(document.querySelector("[data-item-id='a'] .read_here")).toBeNull()
    const blocks = JSON.stringify([{ type: "p", text: "First paragraph of the copy." }, { type: "h", text: "A heading" }])
    moi.update([{ item: view_item("a", { title: "Long read", extra: { blocks } }).item, reasons: [] }])
    const card = document.querySelector("[data-item-id='a']") as HTMLElement
    ;(card.querySelector(".read_here") as HTMLElement).click()
    const inline = card.querySelector(".inline_reader") as HTMLElement
    expect(Array.from(inline.querySelectorAll("p, h2"), (node) => node.textContent)).toEqual(["First paragraph of the copy.", "A heading"])
    ;(inline.querySelector(".highlight") as HTMLElement).click()
    expect(inline.querySelector(".tool_status")?.textContent).toBe("Select some text first.")
    const range = document.createRange()
    range.selectNodeContents(inline.querySelector("p") as Node)
    dom.window.getSelection()?.removeAllRanges()
    dom.window.getSelection()?.addRange(range)
    ;(inline.querySelector(".highlight") as HTMLElement).click()
    ;(inline.querySelector(".note") as HTMLTextAreaElement).value = "  worth a second read "
    ;(inline.querySelector(".keep_note") as HTMLElement).click()
    expect(moi.sent.slice(1)).toEqual([
      { type: "highlight", item_id: "a", quote: "First paragraph of the copy.", note: "" },
      { type: "highlight", item_id: "a", quote: "", note: "worth a second read" },
    ])
    expect((inline.querySelector(".note") as HTMLTextAreaElement).value).toBe("")
    ;(card.querySelector(".read_here") as HTMLElement).click()
    expect(card.querySelector(".inline_reader")).toBeNull()
  })
})

describe("default lens actions", () => {
  it("offers the actions an item allows, Like turning into Liked, and a reply box that sends your words", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("p", { available_actions: ["like", "unlike", "follow", "reply"], extra: { "acted:like": "yes" } }), view_item("q")], null)
    const document = dom.window.document
    const card = document.querySelector("[data-item-id='p']") as HTMLElement
    expect(Array.from(card.querySelectorAll(".acts > .act"), (button) => button.textContent)).toEqual(["Liked", "Follow"])
    expect(document.querySelector("[data-item-id='q'] .acts")).toBeNull()
    ;(card.querySelector(".act[data-action='unlike']") as HTMLElement).click()
    ;(card.querySelector(".act[data-action='follow']") as HTMLElement).click()
    ;(card.querySelector(".reply_tools .act") as HTMLElement).click()
    const box = card.querySelector(".reply_box") as HTMLTextAreaElement
    expect(box.hidden).toBe(false)
    ;(card.querySelector(".send_reply") as HTMLElement).click()
    box.value = "  See you Saturday "
    ;(card.querySelector(".send_reply") as HTMLElement).click()
    expect(moi.sent.slice(1)).toEqual([
      { type: "act", item_id: "p", action: "unlike", text: "" },
      { type: "act", item_id: "p", action: "follow", text: "" },
      { type: "act", item_id: "p", action: "reply", text: "See you Saturday" },
    ])
    moi.update([{ item: view_item("p", { available_actions: ["like", "unlike", "follow", "reply"], extra: { "acted:like": "no", "acted:follow": "yes" } }).item, reasons: [] }])
    expect(Array.from(card.querySelectorAll(".acts > .act"), (button) => button.textContent)).toEqual(["Like", "Following"])
  })
})

describe("default lens recipes", () => {
  it("shows what a recipe puts with a card, each opening its own original, and Look up only where it can", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    const related = [
      { item_id: "r1", source_id: "shop:amazon.com/s?k=a", title: "Hydro Flask 32 oz <b>bottle</b>", url: "https://www.amazon.com/x/dp/B1", price_text: "$44.95", label: "mentions: Hydro Flask bottle" },
    ]
    const mentions = [
      { entity: "Hydro Flask bottle", status: "found" as const, can_look_up: false },
      { entity: "Instant Pot Duo", status: "unresolved" as const, can_look_up: true },
      { entity: "Mystery thing", status: "unresolved" as const, can_look_up: false },
    ]
    moi.render([{ ...view_item("p"), related, mentions }, view_item("q")], null)
    const document = dom.window.document
    const card = document.querySelector("[data-item-id='p']") as HTMLElement
    expect(card.querySelector(".related_item")?.textContent).toBe("mentions: Hydro Flask bottle: Hydro Flask 32 oz <b>bottle</b> · $44.95")
    expect(card.querySelector(".related_item b")).toBeNull()
    expect(Array.from(card.querySelectorAll(".mention"), (node) => node.textContent)).toEqual(["Hydro Flask bottle: found", "Instant Pot Duo: not looked up", "Mystery thing: not looked up"])
    expect(Array.from(card.querySelectorAll(".look_up"), (node) => node.textContent)).toEqual(["Look up Instant Pot Duo"])
    expect(document.querySelector("[data-item-id='q'] .related, [data-item-id='q'] .mentions")).toBeNull()
    ;(card.querySelector(".related_item") as HTMLElement).click()
    ;(card.querySelector(".look_up") as HTMLElement).click()
    expect(moi.sent.slice(1)).toEqual([
      { type: "open", item_id: "r1" },
      { type: "lookup", item_id: "p", entity: "Instant Pot Duo" },
    ])
    const lookup = { item_id: "r2", source_id: "shop:amazon.com/s?k=b", title: "Instant Pot Duo 6 qt", url: "https://www.amazon.com/y/dp/B2", price_text: "$79.00", label: "mentions: Instant Pot Duo" }
    moi.update([{ ...view_item("p"), related: [...related, lookup], mentions: [mentions[0], { entity: "Instant Pot Duo", status: "found", can_look_up: false }] }])
    expect(Array.from(card.querySelectorAll(".mention"), (node) => node.textContent)).toEqual(["Hydro Flask bottle: found", "Instant Pot Duo: found"])
    expect(card.querySelectorAll(".look_up")).toHaveLength(0)
    expect(card.querySelectorAll(".related_item")).toHaveLength(2)
    moi.update([{ item: view_item("p").item, reasons: [] }])
    expect(card.querySelectorAll(".related_item")).toHaveLength(2)
  })
})

describe("default lens reader mode", () => {
  it("reads only a Mine page as a whole article; a saved article with its copy stays a card, alone or appended", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    const blocks = JSON.stringify([{ type: "p", text: "Copy." }])
    moi.render([view_item("saved", { kind: "article", source_id: "rss:blog", title: "Saved read", extra: { blocks } })], "more")
    const document = dom.window.document
    expect(document.querySelector(".reader")).toBeNull()
    expect(document.querySelectorAll(".card .save")).toHaveLength(1)
    moi.append([view_item("more", { kind: "article", source_id: "rss:blog", title: "Another", extra: { blocks } })], null)
    expect(document.querySelector(".reader")).toBeNull()
    moi.render([view_item("mine", { kind: "article", source_id: "site:news.example.com", title: "A page", extra: { blocks } })], null)
    expect(document.querySelector(".reader h1")?.textContent).toBe("A page")
  })

  it("keeps at most 1000 characters of a passage or a note", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([view_item("a", { kind: "article", source_id: "site:news.example.com", title: "Long", extra: { blocks: JSON.stringify([{ type: "p", text: "x".repeat(6000) }]) } })], null)
    const document = dom.window.document
    const range = document.createRange()
    range.selectNodeContents(document.querySelector(".reader p") as Node)
    dom.window.getSelection()?.addRange(range)
    ;(document.querySelector(".reading_tools .highlight") as HTMLElement).click()
    ;(document.querySelector(".reading_tools .note") as HTMLTextAreaElement).value = "n".repeat(3000)
    ;(document.querySelector(".reading_tools .keep_note") as HTMLElement).click()
    const sent = moi.sent.slice(1) as Array<{ quote: string; note: string }>
    expect([sent[0].quote.length, sent[1].note.length]).toEqual([1000, 1000])
  })
})
