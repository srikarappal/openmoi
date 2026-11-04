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
