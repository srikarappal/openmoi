import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configure_media, fetch_public, forget_media, is_media_source, is_private_address, media_for, media_url, serve_media } from "../../src/main/media"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const PUBLIC = ["93.184.216.34"]

function answer(body: BodyInit | null, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers })
}

function png(): Response {
  return answer(PNG, { "content-type": "image/png" })
}

// A resolver that knows a few names: everything else resolves to a public address.
async function resolve(host: string): Promise<string[]> {
  const known: Record<string, string[]> = { "router.example": ["192.168.1.1"], "rebind.example": ["93.184.216.34", "10.0.0.5"], "gone.example": [] }
  return known[host] ?? PUBLIC
}

async function settled(): Promise<void> {
  for (let round = 0; round < 10; round++) await Promise.resolve()
}

let fetcher = vi.fn(async (_url: string, _init: RequestInit) => png())

beforeEach(() => {
  fetcher = vi.fn(async (_url: string, _init: RequestInit) => png())
  configure_media(fetcher, resolve)
})

afterEach(() => {
  delete process.env.MOI_MEDIA_LOOPBACK
})

describe("which addresses the proxy may fetch", () => {
  it.each([
    ["https://cdn.example/a.jpg", true],
    ["https://93.184.216.34/a.jpg", true],
    ["http://cdn.example/a.jpg", false],
    ["https://192.168.1.1/x", false],
    ["https://10.1.2.3/x", false],
    ["https://169.254.169.254/latest", false],
    ["https://127.0.0.1/x", false],
    ["https://[::1]/x", false],
    ["https://[fe80::1]/x", false],
    ["https://[::ffff:10.0.0.1]/x", false],
    ["https://localhost/x", false],
    ["https://printer.local/x", false],
    ["https://nas/x", false],
    ["http://127.0.0.1:8899/images/pixel.png", false],
    ["file:///etc/passwd", false],
    ["javascript:alert(1)", false],
    ["not a url", false],
  ])("%s", (url, allowed) => {
    expect(is_media_source(url)).toBe(allowed)
  })

  it("lets the test world's own loopback server through only when its tests say so", () => {
    process.env.MOI_MEDIA_LOOPBACK = "1"
    expect(is_media_source("http://127.0.0.1:8899/images/pixel.png")).toBe(true)
    expect(is_media_source("http://192.168.1.1/x")).toBe(false)
  })

  it("knows private addresses of both families", () => {
    expect(["10.0.0.1", "172.20.1.1", "100.64.0.1", "::1", "fc00::1", "::ffff:192.168.0.1", "garbage"].every(is_private_address)).toBe(true)
    expect(["93.184.216.34", "2606:4700::1111"].some(is_private_address)).toBe(false)
  })
})

describe("fetching through redirects", () => {
  it("follows public redirects hop by hop and stops at one that leads somewhere private", async () => {
    fetcher.mockImplementation(async (url: string) => {
      if (url.endsWith("/hop")) return answer(null, { location: "/final.png" }, 302)
      if (url.endsWith("/to_router")) return answer(null, { location: "https://router.example/admin" }, 301)
      if (url.endsWith("/to_ip")) return answer(null, { location: "http://192.0.2.1/admin" }, 302)
      if (url.endsWith("/loop")) return answer(null, { location: "https://cdn.example/loop" }, 302)
      if (url.endsWith("/nowhere")) return answer(null, {}, 302)
      return png()
    })
    expect((await fetch_public("https://cdn.example/hop"))?.status).toBe(200)
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["https://cdn.example/hop", "https://cdn.example/final.png"])
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "manual" })
    for (const path of ["to_router", "to_ip", "loop", "nowhere"]) expect(await fetch_public(`https://cdn.example/${path}`)).toBeNull()
    expect(fetcher.mock.calls.some((call) => call[0].includes("router.example") || call[0].includes("192.0.2.1"))).toBe(false)
    for (const host of ["router.example", "rebind.example", "gone.example"]) expect(await fetch_public(`https://${host}/a.png`)).toBeNull()
  })
})

describe("media tokens", () => {
  it("gives each lens its own unguessable token per address and keeps data images as they are", () => {
    const first = media_url(1, "https://cdn.example/a.jpg")
    expect(first).toMatch(/^moi-media:\/\/m\/[0-9a-f]{32}$/)
    expect(media_url(1, "https://cdn.example/a.jpg")).toBe(first)
    expect(media_url(2, "https://cdn.example/a.jpg")).not.toBe(first)
    expect(media_url(1, "data:image/gif;base64,R0lGOD")).toBe("data:image/gif;base64,R0lGOD")
    for (const url of ["data:text/html,<script>", "javascript:alert(1)", "file:///etc/passwd", "http://evil.example/a.jpg", "https://192.168.1.1/a.jpg"]) {
      expect(media_url(1, url)).toBeNull()
    }
  })

  it("fetches each image once when it is handed out, so what a lens loads or reloads reaches no one", async () => {
    const token = media_url(3, "https://cdn.example/c.jpg") ?? ""
    await settled()
    expect(fetcher).toHaveBeenCalledTimes(1)
    for (let round = 0; round < 5; round++) expect((await serve_media(new Request(token))).status).toBe(200)
    const again = media_url(4, "https://cdn.example/c.jpg") ?? ""
    expect(new Uint8Array(await (await serve_media(new Request(again))).arrayBuffer())).toEqual(PNG)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await serve_media(new Request(`${token}?bit=1`))).status).toBe(404)
    expect((await serve_media(new Request(`${token}#x`))).status).toBe(404)
    forget_media(3)
    expect((await serve_media(new Request(token))).status).toBe(404)
    expect((await serve_media(new Request("moi-media://m/0000"))).status).toBe(404)
  })

  it("answers with the image's type and bytes only", async () => {
    const token = media_url(5, "https://cdn.example/d.png") ?? ""
    const response = await serve_media(new Request(token))
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })
})

describe("what the proxy refuses", () => {
  it.each([
    ["a page that is not an image", answer("<html>", { "content-type": "text/html" })],
    ["a video", answer(PNG, { "content-type": "video/mp4" })],
    ["no content type", answer(PNG, {})],
    ["a failed fetch", answer("gone", { "content-type": "image/png" }, 404)],
    ["something too large by its own word", answer(PNG, { "content-type": "image/png", "content-length": "26000000" })],
  ])("%s, and does not ask again for a while", async (_label, original) => {
    fetcher.mockResolvedValue(original)
    const url = `https://cdn.example/${Math.random()}.png`
    const token = media_url(6, url) ?? ""
    expect((await serve_media(new Request(token))).status).toBe(502)
    await settled()
    expect((await serve_media(new Request(token))).status).toBe(502)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("refuses an address that cannot be reached and a body that runs past the cap", async () => {
    fetcher.mockRejectedValueOnce(new Error("offline"))
    expect(await media_for("https://cdn.example/offline.png")).toBeNull()
    fetcher.mockResolvedValueOnce(answer(new Uint8Array(64), { "content-type": "image/png" }))
    expect(await media_for("https://cdn.example/big.png", 32)).toBeNull()
  })
})
