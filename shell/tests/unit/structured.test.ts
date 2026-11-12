import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { json_records } from "../../src/shared/json_items"
import { read_structured, structured_records } from "../../src/shared/structured"

const PAGE = readFileSync(path.resolve(__dirname, "..", "..", "..", "fixtures", "pages", "structured.html"), "utf-8")
const URL_NOW = "https://shop.example/lamps"

function page(): Document {
  return new DOMParser().parseFromString(PAGE, "text/html")
}

describe("rung 2 structured data", () => {
  it("reads JSON-LD, OpenGraph, microdata, hydration state and advertised feeds", () => {
    const structured = read_structured(page(), URL_NOW)
    expect(structured.json_ld).toHaveLength(1)
    expect(structured.open_graph).toEqual({ type: "website", title: "Lamps" })
    expect(structured.microdata).toEqual([
      { "@type": "Article", headline: "Lamp buying guide", name: "Lamp buying guide", url: "/guide", datePublished: "2026-11-01T09:00:00Z", author: { "@type": "Person", name: "Ana" } },
      { "@type": "Product", name: "Desk lamp", url: "/p/1" },
    ])
    expect(structured.hydration).toHaveLength(1)
    expect(structured.feeds).toEqual([{ title: "New lamps", url: "https://shop.example/feeds/lamps.xml" }])
  })

  it("turns the items the data names into records, each link once", () => {
    const records = structured_records(read_structured(page(), URL_NOW), URL_NOW)
    expect(records.map((record) => record.url)).toEqual(["https://shop.example/p/1", "https://shop.example/p/2", "https://shop.example/p/3", "https://shop.example/guide"])
    expect(records[3]).toEqual({ native_id: "https://shop.example/guide", url: "https://shop.example/guide", title: "Lamp buying guide", author_name: "Ana", published_at: "2026-11-01T09:00:00Z" })
    expect(records[0]).toEqual({
      native_id: "https://shop.example/p/1",
      url: "https://shop.example/p/1",
      title: "Desk lamp",
      text: "A warm lamp",
      image_url: "https://img.example/1.jpg",
      "extra.price_text": "USD 24.99",
      "extra.rating_text": "4.6 out of 5",
      kind: "product",
    })
    expect(records[1]["extra.price_text"]).toBe("USD 89")
    expect(records[2]).toEqual({ native_id: "https://shop.example/p/3", url: "https://shop.example/p/3", title: "Reading lamp" })
  })

  it("finds a video and survives data with odd shapes", () => {
    const structured = { json_ld: [{ "@type": ["VideoObject"], name: "Demo", "@id": "https://v.example/1", author: [{ name: "Cam" }], uploadDate: "2026-11-03" }, 7, "x"], open_graph: {}, microdata: [], hydration: [], feeds: [] }
    expect(structured_records(structured, URL_NOW)).toEqual([{ native_id: "https://v.example/1", url: "https://v.example/1", title: "Demo", author_name: "Cam", published_at: "2026-11-03", kind: "video" }])
    expect(structured_records({ ...structured, json_ld: [{ "@type": "Product", name: "Bad link", url: "http://[" }] }, URL_NOW)).toEqual([])
  })
})

describe("item lists in any JSON", () => {
  it("finds the posts in Next.js hydration state", () => {
    const [hydration] = read_structured(page(), URL_NOW).hydration
    const records = json_records(hydration, URL_NOW)
    expect(records).toEqual([
      { native_id: "11", url: "https://shop.example/posts/11", title: "Post one", author_name: "Ana", author_handle: "ana", published_at: "2026-11-02T10:00:00Z" },
      { native_id: "12", url: "https://shop.example/posts/12", title: "Post two", text: "Short", author_name: "Ben" },
      { native_id: "13", url: "https://shop.example/posts/13", title: "Post three", image_url: "https://img.example/13.jpg" },
    ])
  })

  it("prefers the largest list, needs three items with links and drops unsafe links", () => {
    const small = [{ title: "a", url: "/a" }, { title: "b", url: "/b" }]
    expect(json_records({ small }, URL_NOW)).toEqual([])
    const nested = { feed: { items: [1, 2, 3].map((id) => ({ id, name: `Item ${id}`, link: `/i/${id}`, published_at: 1700000000 + id })) }, other: [{ title: "x", url: "javascript:alert(1)" }, { title: "y", url: "/y" }, { title: "z", url: "/z" }] }
    expect(json_records(nested, URL_NOW).map((record) => record.title)).toEqual(["Item 1", "Item 2", "Item 3"])
    expect(json_records(nested, URL_NOW)[0].published_at).toBe("1700000001")
    const unsafe = [1, 2, 3].map((id) => ({ title: `t${id}`, url: id === 1 ? "javascript:alert(1)" : "http://[bad" }))
    expect(json_records(unsafe, URL_NOW)).toEqual([])
    expect(json_records("not json", URL_NOW)).toEqual([])
  })
})
