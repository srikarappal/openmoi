import { describe, expect, it } from "vitest"
import { classify_page } from "../../src/shared/classify"
import { read_structured } from "../../src/shared/structured"

function classify(html: string, url = "https://site.example/page", readerable = false): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  return classify_page(doc, url, read_structured(doc, url), readerable)
}

const LD = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`
const POSTS = Array.from({ length: 6 }, (_, index) => `<article>Post ${index}</article>`).join("")
const COMMENTS = Array.from({ length: 6 }, (_, index) => `<div class="comment">Reply ${index}</div>`).join("")

describe("page classifier", () => {
  it.each([
    ["video by its address", "<p>x</p>", "https://www.youtube.com/watch?v=1", "video"],
    ["video by OpenGraph", '<meta property="og:type" content="video.other">', undefined, "video"],
    ["video by JSON-LD", LD({ "@type": "VideoObject", name: "v" }), undefined, "video"],
    ["product by OpenGraph", '<meta property="og:type" content="product">', undefined, "product"],
    ["product by JSON-LD", LD({ "@type": "Product", name: "Lamp" }), undefined, "product"],
    ["a list of products is not one product", LD([{ "@type": "ItemList" }, { "@type": "Product" }]), "https://shop.example/c/lamps", "listing"],
    ["search by path", "<p>x</p>", "https://shop.example/search/lamps", "search"],
    ["search by query", "<p>x</p>", "https://shop.example/s?k=lamp", "search"],
    ["profile by OpenGraph", '<meta property="og:type" content="profile">', undefined, "profile"],
    ["profile by JSON-LD", LD({ "@type": "ProfilePage" }), undefined, "profile"],
    ["thread by its replies", COMMENTS, undefined, "thread"],
    ["thread by JSON-LD", LD({ "@type": "DiscussionForumPosting" }), undefined, "thread"],
    ["article by OpenGraph", '<meta property="og:type" content="article">', undefined, "article"],
    ["article by JSON-LD", LD({ "@type": "NewsArticle" }), undefined, "article"],
    ["feed by its role", '<div role="feed"></div>', undefined, "feed"],
    ["feed by its posts", POSTS, undefined, "feed"],
    ["anything else is a listing", "<ul><li>a</li></ul>", undefined, "listing"],
    ["search by its page type", LD({ "@type": "SearchResultsPage" }), undefined, "search"],
    ["a list with an article teaser is a listing", LD([{ "@type": "ItemList" }, { "@type": "NewsArticle" }]), undefined, "listing"],
    ["a collection page is a listing", LD({ "@type": "CollectionPage" }), undefined, "listing"],
  ])("%s", (_name, html, url, expected) => {
    expect(classify(html, url)).toBe(expected)
  })

  it("trusts reader mode for an article", () => {
    expect(classify("<p>long text</p>", undefined, true)).toBe("article")
  })
})
