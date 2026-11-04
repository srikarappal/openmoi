import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { apply_transform, extract_records, is_good_extraction, read_field } from "../../src/shared/extract"
import type { ExtractorSpec } from "../../src/shared/types"

const REPO_DIR = path.resolve(__dirname, "..", "..", "..")
const X_SPEC: ExtractorSpec = JSON.parse(readFileSync(path.join(REPO_DIR, "extractors", "x_home_timeline.json"), "utf-8"))

function post(handle: string, post_id: number, extras = ""): string {
  return `<article data-testid="tweet">
    <div data-testid="User-Name"><a href="/${handle}"><span>${handle.toUpperCase()}</span></a></div>
    <a href="/${handle}/status/${post_id}/analytics">stats</a>
    <a href="/${handle}/status/${post_id}"><time datetime="2026-11-04T10:00:00.000Z">2h</time></a>
    <div data-testid="tweetText">  hello
      from ${handle} </div>${extras}
  </article>`
}

function page(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html")
}

describe("extract_records with the shipped X spec", () => {
  it("reads posts, absolute urls, handles, media and ids", () => {
    const doc = page(
      post("maya", 101, `<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/a.jpg"></div>`) +
        post("bob", 102, `<div data-testid="videoPlayer"></div>`),
    )
    const records = extract_records(doc, X_SPEC, "https://x.com/home")
    expect(records).toEqual([
      {
        url: "https://x.com/maya/status/101",
        author_name: "MAYA",
        author_handle: "maya",
        text: "hello from maya",
        published_at: "2026-11-04T10:00:00.000Z",
        image_url: "https://pbs.twimg.com/media/a.jpg",
        native_id: "101",
      },
      {
        url: "https://x.com/bob/status/102",
        author_name: "BOB",
        author_handle: "bob",
        text: "hello from bob",
        published_at: "2026-11-04T10:00:00.000Z",
        media_kind: "video",
        native_id: "102",
      },
    ])
  })

  it("drops items missing a required field", () => {
    const doc = page(`<article data-testid="tweet"><div data-testid="tweetText">no link</div></article>${post("maya", 7)}`)
    expect(extract_records(doc, X_SPEC, "https://x.com/home").map((record) => record.native_id)).toEqual(["7"])
  })

  it("returns nothing for a page without items", () => {
    expect(extract_records(page("<p>empty</p>"), X_SPEC, "https://x.com/home")).toEqual([])
  })
})

describe("read_field", () => {
  const root = page(`<li id="row1" data-rank="3"><a href="/a">First</a><a href="/b">Second</a><span> </span></li>`).querySelector("li") as Element

  it("supports :scope, nth, attributes and constants", () => {
    expect(read_field(root, { select: ":scope", take: "attr:id" }, "https://e.com/")).toBe("row1")
    expect(read_field(root, { select: "a", take: "text", nth: 1 }, "https://e.com/")).toBe("Second")
    expect(read_field(root, { select: "a", take: "attr:href", transform: "absolute_url" }, "https://e.com/list")).toBe("https://e.com/a")
    expect(read_field(root, { select: "a", take: "const:link" }, "https://e.com/")).toBe("link")
  })

  it("returns null for missing targets, attributes, blank text and unknown takes", () => {
    expect(read_field(root, { select: "img", take: "attr:src" }, "https://e.com/")).toBeNull()
    expect(read_field(root, { select: "a", take: "attr:title" }, "https://e.com/")).toBeNull()
    expect(read_field(root, { select: "span", take: "text" }, "https://e.com/")).toBeNull()
    expect(read_field(root, { select: "a", take: "html" }, "https://e.com/")).toBeNull()
    expect(read_field(root, { select: "a", take: "text", nth: 5 }, "https://e.com/")).toBeNull()
  })
})

describe("apply_transform", () => {
  it.each([
    ["/x/status/9", "regex:/status/(\\d+)", "9"],
    ["abc123", "regex:\\d+", "123"],
    ["abc", "regex:\\d+", null],
    ["abc", "regex:(", null],
    ["/maya", "strip_prefix:/", "maya"],
    ["maya", "strip_prefix:/", "maya"],
    ["2026-11-04 10:00Z", "iso_datetime", "2026-11-04T10:00:00.000Z"],
    ["soon", "iso_datetime", null],
    ["http://[bad", "absolute_url", null],
    ["kept", "unknown_transform", "kept"],
  ])("%s with %s", (value, transform, expected) => {
    expect(apply_transform(value, transform, "https://e.com/")).toBe(expected)
  })
})

describe("is_good_extraction", () => {
  it("needs three records with a url and words", () => {
    const good = { url: "https://e.com/1", title: "t" }
    expect(is_good_extraction([good, good, { url: "https://e.com/2", text: "words" }])).toBe(true)
    expect(is_good_extraction([good, good, { url: "https://e.com/3" }])).toBe(false)
    expect(is_good_extraction([])).toBe(false)
  })
})
