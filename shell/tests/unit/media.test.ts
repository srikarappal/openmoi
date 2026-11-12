import { describe, expect, it, vi } from "vitest"
import { forget_media, is_media_source, media_url, serve_media } from "../../src/main/media"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

function answer(body: BodyInit | null, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers })
}

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers })
}

describe("media tokens", () => {
  it("gives each lens its own unguessable token per address and keeps data images as they are", () => {
    const first = media_url(1, "https://cdn.example/a.jpg")
    expect(first).toMatch(/^moi-media:\/\/m\/[0-9a-f]{32}$/)
    expect(media_url(1, "https://cdn.example/a.jpg")).toBe(first)
    expect(media_url(2, "https://cdn.example/a.jpg")).not.toBe(first)
    expect(media_url(1, "https://cdn.example/b.jpg")).not.toBe(first)
    expect(media_url(1, "data:image/gif;base64,R0lGOD")).toBe("data:image/gif;base64,R0lGOD")
    for (const url of ["data:text/html,<script>", "javascript:alert(1)", "file:///etc/passwd", "http://evil.example/a.jpg", "moi-media://m/abc", "not a url"]) {
      expect(media_url(1, url)).toBeNull()
    }
    expect(is_media_source("http://127.0.0.1:8899/images/pixel.png")).toBe(true)
  })

  it("answers only the tokens a lens still holds", async () => {
    const token = media_url(3, "https://cdn.example/c.jpg") ?? ""
    const fetch_media = vi.fn(async () => answer(PNG, { "content-type": "image/png" }))
    expect((await serve_media(request(token), fetch_media)).status).toBe(200)
    forget_media(3)
    expect((await serve_media(request(token), fetch_media)).status).toBe(404)
    expect((await serve_media(request("moi-media://m/0000"), fetch_media)).status).toBe(404)
    expect(fetch_media).toHaveBeenCalledTimes(1)
  })
})

describe("serving media", () => {
  it("fetches the original without cookies and passes its bytes and the headers a player needs", async () => {
    const token = media_url(4, "https://cdn.example/v.mp4") ?? ""
    const fetch_media = vi.fn(async () => answer(PNG, { "content-type": "video/mp4", "content-range": "bytes 0-7/100", "accept-ranges": "bytes", "set-cookie": "id=1", "content-length": "8" }, 206))
    const response = await serve_media(request(token, { range: "bytes=0-7" }), fetch_media)
    expect(fetch_media).toHaveBeenCalledWith("https://cdn.example/v.mp4", { credentials: "omit", redirect: "follow", headers: { range: "bytes=0-7" } })
    expect(response.status).toBe(206)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
    expect(response.headers.get("content-range")).toBe("bytes 0-7/100")
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it.each([
    ["a page that is not media", answer("<html>", { "content-type": "text/html" }), 415],
    ["no content type", answer(PNG, {}), 415],
    ["a failed fetch", answer("gone", { "content-type": "image/png" }, 404), 502],
    ["something too large by its own word", answer(PNG, { "content-type": "image/png", "content-length": "26000000" }), 413],
  ])("refuses %s", async (_label, original, status) => {
    const token = media_url(5, `https://cdn.example/${status}.png`) ?? ""
    expect((await serve_media(request(token), async () => original)).status).toBe(status)
  })

  it("refuses an address that cannot be reached and cuts a body that runs past the cap", async () => {
    const token = media_url(6, "https://cdn.example/big.png") ?? ""
    expect((await serve_media(request(token), async () => Promise.reject(new Error("offline")))).status).toBe(502)
    const response = await serve_media(request(token), async () => answer(new Uint8Array(64), { "content-type": "image/png" }), 32)
    await expect(response.arrayBuffer()).rejects.toThrow()
  })
})
