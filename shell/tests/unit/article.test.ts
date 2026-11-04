import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { article_blocks, read_article, type Block } from "../../src/shared/article"

const PAGES = path.resolve(__dirname, "..", "..", "..", "fixtures", "pages")

function load(name: string): Document {
  return new DOMParser().parseFromString(readFileSync(path.join(PAGES, name), "utf-8"), "text/html")
}

describe("read_article", () => {
  it("reads a long article into title, byline, text and blocks", () => {
    const record = read_article(load("article.html"), "https://daily.example/tech/solar")
    expect(record).not.toBeNull()
    expect(record?.title).toBe("How solar panels got cheap")
    expect(record?.author_name).toBe("By Jordan Rivers")
    expect(record?.kind).toBe("article")
    expect(record?.url).toBe("https://daily.example/tech/solar")
    expect(record?.image_url).toBe("https://images.example.com/solar_factory.jpg")
    expect(record?.text).toContain("learning curve")
    expect(record?.text).not.toContain("Buy a car today")
    const blocks: Block[] = JSON.parse(record?.["extra.blocks"] ?? "[]")
    expect(blocks.map((block) => block.type)).toEqual(expect.arrayContaining(["h", "p", "img", "quote"]))
    expect(blocks.find((block) => block.type === "quote")?.text).toBe("The panel did not change much. The way we make it changed completely.")
  })

  it.each(["listing.html", "shop.html", "x_login.html"])("treats %s as not an article", (name) => {
    expect(read_article(load(name), "https://e.example/")).toBeNull()
  })
})

describe("article_blocks", () => {
  it("walks nested containers, keeps lists and figures and resolves image urls", () => {
    const root = new DOMParser().parseFromString(
      `<div><section><h3>Title</h3><figure><img src="/a.png"><figcaption>Caption</figcaption></figure></section><ul><li>One</li><li> Two </li></ul><p>Text <img src="b.png"></p><p>   </p><img></div>`,
      "text/html",
    ).body
    expect(article_blocks(root, "https://site.example/post/1")).toEqual([
      { type: "h", text: "Title" },
      { type: "img", src: "https://site.example/a.png" },
      { type: "p", text: "Caption" },
      { type: "li", text: "One" },
      { type: "li", text: "Two" },
      { type: "p", text: "Text" },
      { type: "img", src: "https://site.example/post/b.png" },
    ])
  })
})
