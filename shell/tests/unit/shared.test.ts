import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { normalize_address, site_domain, youtube_video_id } from "../../src/shared/address"
import { looks_like_challenge } from "../../src/shared/challenge"
import { LENS_CSP, lens_csp, lens_data_url, lens_request_allowed, parse_lens_message, with_media, wrap_lens } from "../../src/shared/lens_doc"
import { PendingRequests } from "../../src/shared/pending"
import { Throttle, sleep, wait_for } from "../../src/shared/timing"

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html")
}

describe("looks_like_challenge", () => {
  it.each([
    ["https://x.com/i/flow/login?redirect=home", "X", "<p>x</p>", true],
    ["https://www.facebook.com/checkpoint/1", "Facebook", "<p>x</p>", true],
    ["https://example.com/login", "Example", "<p>x</p>", true],
    ["https://example.com/home", "Just a moment... verify you are human", "<p>x</p>", true],
    ["https://example.com/home", "Home", "<iframe src='https://captcha.example/x'></iframe>", true],
    ["https://example.com/home", "Home", "<form><input type='password'></form>", true],
    ["https://example.com/home", "Home", "<article>posts</article>", false],
    ["https://example.com/blog/logins-explained", "Logins explained", "<p>x</p>", false],
    ["not a url", "Home", "<p>x</p>", false],
  ])("%s %s", (url, title, html, expected) => {
    expect(looks_like_challenge(url, title, doc(html))).toBe(expected)
  })
})

describe("Throttle", () => {
  it("allows one automatic run per interval and always allows forced runs", () => {
    let now = 0
    const throttle = new Throttle(1000, () => now)
    expect(throttle.allow("x", false)).toBe(true)
    now = 500
    expect(throttle.allow("x", false)).toBe(false)
    expect(throttle.allow("other", false)).toBe(true)
    expect(throttle.allow("x", true)).toBe(true)
    now = 1400
    expect(throttle.allow("x", false)).toBe(false)
    now = 1600
    expect(throttle.allow("x", false)).toBe(true)
  })
})

describe("wait_for", () => {
  it("retries until the probe succeeds", async () => {
    let calls = 0
    const probe = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error("not yet")
      return "ok"
    })
    await expect(wait_for(probe, 1000, 1)).resolves.toBe("ok")
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it("rethrows the last error after the timeout", async () => {
    await expect(wait_for(async () => Promise.reject(new Error("never")), 20, 5)).rejects.toThrow("never")
  })

  it("sleep waits", async () => {
    const started = Date.now()
    await sleep(15)
    expect(Date.now() - started).toBeGreaterThanOrEqual(10)
  })
})

describe("PendingRequests", () => {
  it("resolves, rejects and times out by id", async () => {
    const pending = new PendingRequests()
    const first = pending.create<number>(1000, "first")
    const second = pending.create<number>(1000, "second")
    const third = pending.create<number>(5, "third")
    expect(first.request_id).not.toBe(second.request_id)
    expect(pending.settle(first.request_id, 42)).toBe(true)
    expect(pending.settle(second.request_id, null, "boom")).toBe(true)
    await expect(first.promise).resolves.toBe(42)
    await expect(second.promise).rejects.toThrow("boom")
    await expect(third.promise).rejects.toThrow("third timed out")
    expect(pending.settle(first.request_id, 1)).toBe(false)
    expect(pending.size).toBe(0)
  })
})

describe("lens documents", () => {
  it("puts the CSP first in an existing head", () => {
    const wrapped = wrap_lens("<html><head><script>x()</script></head><body></body></html>")
    expect(wrapped.indexOf("Content-Security-Policy")).toBeLessThan(wrapped.indexOf("<script>"))
    expect(wrapped).toContain(LENS_CSP)
    expect(LENS_CSP).toContain("img-src moi-media: data:")
    expect(LENS_CSP).not.toContain("https:")
  })

  it("wraps a fragment into a full document", () => {
    expect(wrap_lens("<p>hi</p>")).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"[^>]*><script>[^<]*<\/script><p>hi<\/p>$/)
  })

  it("lets only the lens's own scripts run, each by its hash, so a handler written into the page never does", () => {
    const html = '<script>moi.ready()</script><script src="x.js"></script><div onclick="steal()"></div><SCRIPT type="module">go()</SCRIPT>'
    const policy = lens_csp(html)
    const hash = (script: string) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`
    expect(policy.startsWith(LENS_CSP)).toBe(true)
    expect(policy).toContain(hash("moi.ready()"))
    expect(policy).toContain(hash("go()"))
    expect(policy).not.toContain("unsafe-inline'; script")
    expect(policy.split("script-src ")[1].split(" ")).toHaveLength(3)
    expect(wrap_lens(html)).toContain(`content="${policy}"`)
  })

  it("puts the CSP before a script placed ahead of head and is not fooled by a header tag", () => {
    for (const html of ["<!DOCTYPE html><script>early()</script><html><head></head></html>", "<header><script>x()</script></header>"]) {
      const wrapped = wrap_lens(html)
      expect(wrapped.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${lens_csp(html.replace(/^<!DOCTYPE html>/, ""))}"><script>`)).toBe(true)
      expect(wrapped.match(/<!doctype/gi)).toHaveLength(1)
    }
  })

  it("puts the shared tokens after the CSP and before the lens's own styles, and a style end in them cannot close it early", () => {
    const wrapped = wrap_lens("<html><head><style>body { color: var(--text) }</style></head></html>", ":root { --text: #111 }</style><script>x()</script>")
    expect(wrapped.indexOf("Content-Security-Policy")).toBeLessThan(wrapped.indexOf('<style id="moi_tokens">'))
    expect(wrapped.indexOf("--text: #111")).toBeLessThan(wrapped.indexOf("body { color"))
    expect(wrapped).not.toContain("</style><script>")
    expect(lens_data_url("<p>x</p>", ":root { --bg: #fff }")).not.toBe(lens_data_url("<p>x</p>"))
  })

  it("hands a lens its items' images through the media proxy only, leaving out what the proxy will not take", () => {
    const blocks = [{ type: "img", src: "https://i/b.jpg" }, { type: "img", src: "file:///etc/passwd" }, { type: "p", text: "x" }]
    const article = { item: { item_id: "a", url: "https://a.example/1", image_url: "https://i/a.jpg", extra: { blocks: JSON.stringify(blocks), site: "a" } }, reasons: [] }
    const broken = { item: { item_id: "b", image_url: "javascript:alert(1)", extra: { blocks: "not json" } }, reasons: [] }
    const plain = { item: { item_id: "c", image_url: null, extra: {} }, reasons: ["recent"] }
    const to_media = (url: string) => (url.startsWith("https://") ? `moi-media://m/${url.slice(-5)}` : null)
    const [first, second, third] = with_media([article, broken, plain] as never, to_media)
    expect(first.item.image_url).toBe("moi-media://m/a.jpg")
    expect(first.item.url).toBe("https://a.example/1")
    expect(JSON.parse(first.item.extra.blocks)).toEqual([{ type: "img", src: "moi-media://m/b.jpg" }, { type: "p", text: "x" }])
    expect(first.item.extra.site).toBe("a")
    expect(second.item.image_url).toBeNull()
    expect(second.item.extra.blocks).toBe("not json")
    expect(third).toEqual(plain)
    expect(article.item.image_url).toBe("https://i/a.jpg")
  })

  it("encodes as a base64 data url", () => {
    const url = lens_data_url("<p>é</p>")
    expect(url.startsWith("data:text/html;charset=utf-8;base64,")).toBe(true)
    expect(Buffer.from(url.split(",")[1], "base64").toString("utf-8")).toContain("<p>é</p>")
  })

  it.each([
    ["data:text/html;base64,AA", true],
    ["moi-media://m/0123abcd", true],
    ["https://pbs.twimg.com/a.jpg", false],
    ["https://pbs.twimg.com/a.jpg?d=your_items", false],
    ["http://127.0.0.1:9/a.png", false],
    ["https://evil.example/collect", false],
    ["file:///etc/passwd", false],
  ])("lens request %s", (url, allowed) => {
    expect(lens_request_allowed(url)).toBe(allowed)
  })
})

describe("parse_lens_message", () => {
  it.each([
    [{ type: "ready" }, { type: "ready" }],
    [{ type: "open", item_id: "abc" }, { type: "open", item_id: "abc" }],
    [{ type: "less_like_this", item_id: "abc", extra: 1 }, { type: "less_like_this", item_id: "abc" }],
    [{ type: "more", cursor: "more" }, { type: "more", cursor: "more" }],
    [{ type: "seen", item_ids: ["a", "b"] }, { type: "seen", item_ids: ["a", "b"] }],
    [{ type: "play", item_id: "v" }, { type: "play", item_id: "v" }],
    [{ type: "save", item_id: "a", collection: "read_later", x: 1 }, { type: "save", item_id: "a", collection: "read_later" }],
    [{ type: "unsave", item_id: "a", collection: "watch_later" }, { type: "unsave", item_id: "a", collection: "watch_later" }],
    [{ type: "highlight", item_id: "a", quote: "a line", note: "" }, { type: "highlight", item_id: "a", quote: "a line", note: "" }],
    [{ type: "act", item_id: "a", action: "like" }, { type: "act", item_id: "a", action: "like", text: "" }],
    [{ type: "act", item_id: "a", action: "reply", text: "hi" }, { type: "act", item_id: "a", action: "reply", text: "hi" }],
  ])("accepts %j", (raw, expected) => {
    expect(parse_lens_message(raw)).toEqual(expected)
  })

  it.each([
    null,
    "ready",
    { type: "navigate", url: "https://evil" },
    { type: "open" },
    { type: "open", item_id: 5 },
    { type: "open", item_id: "x".repeat(500) },
    { type: "more" },
    { type: "seen", item_ids: "a" },
    { type: "seen", item_ids: [1] },
    { type: "seen", item_ids: Array.from({ length: 500 }, (_, index) => `id${index}`) },
    { type: "save", item_id: "a" },
    { type: "save", item_id: "a", collection: "Read Later" },
    { type: "save", item_id: "a", collection: "../../etc" },
    { type: "highlight", item_id: "a", quote: "", note: "" },
    { type: "highlight", item_id: "a", quote: "x".repeat(6000), note: "" },
    { type: "highlight", item_id: "a", quote: 5, note: "" },
    { type: "act", item_id: "a", action: "Place Order" },
    { type: "act", item_id: "a", action: "like", text: "x".repeat(6000) },
    { type: "act", item_id: "a" },
  ])("rejects %j", (raw) => {
    expect(parse_lens_message(raw)).toBeNull()
  })
})

describe("addresses", () => {
  it.each([
    ["https://x.com/home", "https://x.com/home"],
    ["  news.ycombinator.com ", "https://news.ycombinator.com"],
    ["amazon.com/s?k=lamp", "https://amazon.com/s?k=lamp"],
    ["localhost:8000/path", "http://localhost:8000/path"],
    ["127.0.0.1:9000", "http://127.0.0.1:9000"],
    ["best lamp for reading", "https://duckduckgo.com/?q=best%20lamp%20for%20reading"],
    ["about:blank", "about:blank"],
  ])("%s", (typed, expected) => {
    expect(normalize_address(typed)).toBe(expected)
  })

  it("site_domain", () => {
    expect(site_domain("https://www.amazon.com/s?k=lamp")).toBe("amazon.com")
    expect(site_domain("nonsense")).toBe("")
  })
})

describe("youtube_video_id", () => {
  it.each([
    ["https://www.youtube.com/watch?v=VIDEO00001A", "VIDEO00001A"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=x", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/SHORT00001B", "SHORT00001B"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=short", null],
    ["https://www.youtube.com/@veritasium", null],
    ["https://evil.example/watch?v=dQw4w9WgXcQ", null],
    ["https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", null],
    ["not a url", null],
  ])("%s", (url, id) => {
    expect(youtube_video_id(url)).toBe(id)
  })
})
