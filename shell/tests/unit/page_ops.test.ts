import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { json_object_at, run_page_op } from "../../src/shared/page_ops"
import type { ExtractorSpec } from "../../src/shared/types"

const PAGES = path.resolve(__dirname, "..", "..", "..", "fixtures", "pages")
const LISTING_SPEC: ExtractorSpec = {
  domain: "localhost",
  path_pattern: "/",
  page_type: "listing",
  version: 1,
  item_root: "tr.athing",
  native_id: { select: ":scope", take: "attr:id" },
  fields: { title: { select: ".titleline > a", take: "text" }, url: { select: ".titleline > a", take: "attr:href", transform: "absolute_url" } },
  pagination: { kind: "none", step_px: 900 },
}

function load(name: string): void {
  const page = new DOMParser().parseFromString(readFileSync(path.join(PAGES, name), "utf-8"), "text/html")
  document.head.innerHTML = page.head.innerHTML
  document.title = page.title
  document.body.innerHTML = page.body.innerHTML
}

beforeEach(() => {
  document.head.innerHTML = ""
  document.title = ""
  document.body.innerHTML = ""
})

describe("run_page_op", () => {
  it("extracts with a spec and reports page info", () => {
    load("listing.html")
    const records = run_page_op("extract", { spec: LISTING_SPEC }) as Array<Record<string, string>>
    expect(records).toHaveLength(5)
    expect(records[2]).toEqual({ title: "Ask HN: How do you read the news?", url: `${location.origin}/item?id=903`, native_id: "903" })
    expect(run_page_op("info", {})).toEqual({ url: location.href, title: "Hacker Newz" })
  })

  it("spots challenges, builds skeletons and reads articles", () => {
    load("x_login.html")
    expect(run_page_op("challenge", {})).toBe(true)
    load("listing.html")
    expect(run_page_op("challenge", {})).toBe(false)
    expect(run_page_op("skeleton", {})).not.toContain("Rust")
    expect(run_page_op("readability", {})).toBeNull()
  })

  it("scrolls and rejects unknown operations", () => {
    expect(run_page_op("scroll", { step_px: 300 })).toBe(true)
    expect(() => run_page_op("delete" as never, {})).toThrow("unknown page op delete")
  })
})

describe("the text page operation", () => {
  it("reads the main area when the page has one, else the body, with the title", () => {
    document.title = "Visa slots"
    document.body.innerHTML = "<nav>Menu Home About</nav><main><h1>Appointments</h1><p>No slots</p></main><footer>Contact</footer>"
    expect(run_page_op("text", {})).toEqual({ title: "Visa slots", text: "AppointmentsNo slots" })
    document.body.innerHTML = "<div>Just a body</div>"
    expect(run_page_op("text", {})).toEqual({ title: "Visa slots", text: "Just a body" })
    document.body.innerHTML = `<article>${"x".repeat(25_000)}</article>`
    expect((run_page_op("text", {}) as { text: string }).text).toHaveLength(20_000)
  })

  it("prefers what the browser shows over hidden markup text where it can", () => {
    document.body.innerHTML = '<div role="main">Shown</div>'
    const main = document.querySelector("[role=main]") as HTMLElement
    Object.defineProperty(main, "innerText", { configurable: true, value: "Shown as rendered" })
    expect((run_page_op("text", {}) as { text: string }).text).toBe("Shown as rendered")
  })
})

describe("the transcript page operation", () => {
  it("finds the English captions, title and description in a video page's player data", () => {
    load("watch.html")
    expect(run_page_op("transcript", {})).toEqual({
      title: "The new battery, explained",
      description: 'A look at the new battery {with braces} and "quotes".',
      caption_url: new URL("/api/timedtext?v=demo&lang=en", location.href).href,
    })
  })

  it("falls back to the first captions, then to the page title with none", () => {
    document.title = "A video"
    document.body.innerHTML = '<script>var ytInitialPlayerResponse = {"captions": {"playerCaptionsTracklistRenderer": {"captionTracks": [{"baseUrl": "https://www.youtube.com/api/timedtext?v=x&lang=de"}]}}};</script>'
    expect(run_page_op("transcript", {})).toEqual({ title: "A video", description: "", caption_url: "https://www.youtube.com/api/timedtext?v=x&lang=de" })
    document.body.innerHTML = '<script>var ytInitialPlayerResponse = {"videoDetails": {"title": "No captions"}};</script><script>var other = 1;</script>'
    expect(run_page_op("transcript", {})).toEqual({ title: "No captions", description: "", caption_url: null })
    document.body.innerHTML = '<script>var ytInitialPlayerResponse = {"never": "closes"</script>'
    expect(run_page_op("transcript", {})).toEqual({ title: "A video", description: "", caption_url: null })
  })

  it("matches braces outside strings only", () => {
    expect(json_object_at('x = {"a": "}{", "b": {"c": "\\"}"}} tail', 4)).toBe('{"a": "}{", "b": {"c": "\\"}"}}')
    expect(json_object_at("{ open", 0)).toBeNull()
  })
})

describe("the structured page operation", () => {
  it("says what kind of page it is, the items its data names and the feeds it offers", () => {
    load("structured.html")
    const page = run_page_op("structured", {}) as { page_type: string; records: Array<{ url: string }>; feeds: unknown[] }
    expect(page.page_type).toBe("listing")
    expect(page.records.map((record) => new URL(record.url).pathname)).toEqual(["/p/1", "/p/2", "/p/3", "/guide", "/posts/11", "/posts/12", "/posts/13"])
    expect(page.feeds).toHaveLength(1)
  })
})
