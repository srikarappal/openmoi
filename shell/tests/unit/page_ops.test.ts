import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { run_page_op } from "../../src/shared/page_ops"
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
  document.title = page.title
  document.body.innerHTML = page.body.innerHTML
}

beforeEach(() => {
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
