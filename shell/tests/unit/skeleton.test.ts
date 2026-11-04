import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { MAX_SKELETON_CHARS, skeleton, url_shape } from "../../src/shared/skeleton"

const PAGES = path.resolve(__dirname, "..", "..", "..", "fixtures", "pages")
const CANARY = "CANARY_PAGE_TEXT_9f3a"

function body(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html").body
}

function page(name: string): HTMLElement {
  return new DOMParser().parseFromString(readFileSync(path.join(PAGES, name), "utf-8"), "text/html").body
}

describe("skeleton", () => {
  it.each(["listing.html", "shop.html", "article.html"])("never contains page text from %s", (name) => {
    const text = skeleton(page(name))
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain("private words")
    expect(text).not.toMatch(/lamp|Rust|solar/i)
    expect(text).toContain("{t:")
  })

  it("keeps structure, useful attributes and text lengths", () => {
    const text = skeleton(body(`<article data-testid="tweet" class="a b c d e" style="color:red" onclick="x()"><a href="/maya/status/12345?s=20" title="Open post"><span>hello</span></a><img src="https://cdn.example/p/9871.jpg" alt="a cat"></article>`))
    expect(text).toBe(
      [
        "<body>",
        ' <article data-testid="tweet" class="a b c d">',
        '  <a href="/w/status/9?q" title="{t:9}">',
        "   <span>{t:5}</span>",
        "  </a>",
        '  <img src="https://ext/p/9.jpg" alt="{t:5}">',
        " </article>",
        "</body>",
      ].join("\n"),
    )
  })

  it("drops scripts, styles, svg and other noise", () => {
    const text = skeleton(body(`<script>secret()</script><style>p{}</style><svg><path d="M0"/></svg><noscript>x</noscript><iframe src="https://ads"></iframe><p>kept</p>`))
    expect(text).toBe("<body>\n <p>{t:4}</p>\n</body>")
  })

  it("masks data and aria values that look like words", () => {
    const text = skeleton(body(`<div id="story-how-solar-panels-got-cheap" data-testid="cellInnerDiv" data-asin="B0001" data-rank="12" data-title="Desk lamp deluxe" aria-label="Like post by Maya" aria-expanded="false" role="button"></div><p id="main"></p><p id="901"></p>`))
    expect(text).toContain('id="{t:32}"')
    expect(text).toContain('id="main"')
    expect(text).toContain('id="9"')
    expect(text).toContain('data-testid="cellInnerDiv"')
    expect(text).toContain('data-asin="{t:5}"')
    expect(text).toContain('data-rank="9"')
    expect(text).toContain('data-title="{t:16}"')
    expect(text).toContain('aria-label="{t:17}"')
    expect(text).toContain('aria-expanded="false"')
    expect(text).toContain('role="button"')
  })

  it("cuts long runs of similar siblings to three and a count", () => {
    const rows = Array.from({ length: 10 }, (_, index) => `<li class="row"><a href="/i/${index}">item ${index}</a></li>`).join("")
    const text = skeleton(body(`<ul>${rows}<li class="more"><a href="/more">more</a></li></ul>`))
    expect(text.match(/<li class="row">/g)).toHaveLength(3)
    expect(text).toContain("<!-- 7 more like the above -->")
    expect(text).toContain('<li class="more">')
  })

  it("caps the size", () => {
    const rows = Array.from({ length: 4000 }, (_, index) => `<div class="c${index}"><span>x</span><b>y</b></div>`).join("")
    const text = skeleton(body(rows))
    expect(text.length).toBeLessThanOrEqual(MAX_SKELETON_CHARS + 60)
    expect(text.endsWith(`<!-- skeleton cut at ${MAX_SKELETON_CHARS} characters -->`)).toBe(true)
  })
})

describe("url_shape", () => {
  it.each([
    ["/dp/B0001?tag=x", "/dp/w?q"],
    ["item?id=903", "/item?q"],
    ["/maya/status/1234", "/w/status/9"],
    ["https://news.example.com/2026/11/story", "https://ext/9/9/story"],
    ["https://example.net/lamps", "https://ext/w"],
    ["https://images.example.com/solar_factory.jpg", "https://ext/w.jpg"],
    ["/", "/"],
    ["mailto:someone@example.com", "mailto:"],
    ["javascript:void(0)", "javascript:"],
  ])("%s", (value, expected) => {
    expect(url_shape(value)).toBe(expected)
  })
})
