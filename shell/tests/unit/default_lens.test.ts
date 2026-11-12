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
    moi.render([view_item("p1", { kind: "product", title: "Lamp", extra: { price_text: "$24.99", rating_text: "4.6 out of 5 stars" } })], null)
    expect(dom.window.document.querySelector(".details")?.textContent).toBe("$24.99 · 4.6 out of 5 stars")
  })

  it("uses a grid for listings and a reader for one article", () => {
    const listing = run_lens(DEFAULT_LENS)
    listing.moi.render([view_item("p1", { kind: "product" }), view_item("p2", { kind: "link" })], null)
    expect(listing.dom.window.document.getElementById("items")?.className).toBe("grid")

    const article = run_lens(DEFAULT_LENS)
    const blocks = JSON.stringify([{ type: "h", text: "Heading" }, { type: "p", text: "Body text" }, { type: "img", src: "https://i/a.jpg" }, { type: "quote", text: "Said" }])
    article.moi.render([view_item("art", { kind: "article", title: "The article", extra: { blocks } })], null)
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

  it("shows a summary in place of the text, says it is on the way until it arrives", () => {
    const { dom, moi } = run_lens(DEFAULT_LENS)
    moi.render([{ ...view_item("v1", { title: "Long read", text: "All the words." }), summary_only: true }, view_item("v2", { title: "Plain", text: "Plain words." })], null)
    const document = dom.window.document
    const card = document.querySelector("[data-item-id='v1']")
    expect(card?.querySelector(".text")).toBeNull()
    expect(card?.querySelector(".summary.pending")?.textContent).toBe("Summary on its way")
    expect(document.querySelector("[data-item-id='v2'] .text")?.textContent).toBe("Plain words.")
    expect(document.querySelector("[data-item-id='v2'] .summary")).toBeNull()
    moi.update([{ item: view_item("v1", { title: "Long read", extra: { summary: "The short of it." } }).item, reasons: [] }])
    expect(Array.from(card?.querySelectorAll(".summary") ?? [], (node) => node.textContent)).toEqual(["The short of it."])
    expect(card?.querySelector(".summary.pending")).toBeNull()
  })
})
