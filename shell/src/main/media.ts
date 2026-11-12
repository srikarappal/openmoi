// The media proxy: a lens never sees where an image lives. Each image or video of the items a lens is sent becomes
// moi-media://m/<token>, a token only that lens was given; the host fetches the original itself, without cookies, and
// answers only with images, video and audio. An image address can no longer carry your items anywhere, since a lens
// can load nothing but the tokens it was handed.
import { randomBytes } from "node:crypto"

export const MEDIA_SCHEME = "moi-media"
export const MAX_MEDIA_BYTES = 25_000_000
const MEDIA_TYPE = /^(?:image|video|audio)\//i
// The test world serves its images from this machine over http; everything else must be https.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const PASSED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "last-modified", "etag"]

export type MediaFetch = (url: string, init: RequestInit) => Promise<Response>

const by_token = new Map<string, { url: string; contents_id: number }>()
const by_lens = new Map<number, Map<string, string>>()

export function is_media_source(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))
  } catch {
    return false
  }
}

// The address a lens gets for an item's media: a data URL as it is, a web address as a token for that lens, anything
// else nothing.
export function media_url(contents_id: number, url: string): string | null {
  if (url.startsWith("data:image/")) return url
  if (!is_media_source(url)) return null
  const tokens = by_lens.get(contents_id) ?? new Map<string, string>()
  by_lens.set(contents_id, tokens)
  let token = tokens.get(url)
  if (!token) {
    token = randomBytes(16).toString("hex")
    tokens.set(url, token)
    by_token.set(token, { url, contents_id })
  }
  return `${MEDIA_SCHEME}://m/${token}`
}

export function forget_media(contents_id: number): void {
  for (const token of by_lens.get(contents_id)?.values() ?? []) by_token.delete(token)
  by_lens.delete(contents_id)
}

// Stops a body that runs past the cap, whatever its headers said.
class ByteCap implements Transformer<Uint8Array, Uint8Array> {
  private seen = 0

  constructor(private readonly limit: number) {}

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    this.seen += chunk.byteLength
    if (this.seen > this.limit) controller.error(new Error("media too large"))
    else controller.enqueue(chunk)
  }
}

function ignore(): void {}

function refuse(status: number): Response {
  return new Response(null, { status })
}

// Answers a lens's moi-media request: the original, fetched without cookies (a range passed through, for video), if it
// is media and not too large.
export async function serve_media(request: Request, fetch_media: MediaFetch, limit = MAX_MEDIA_BYTES): Promise<Response> {
  const media = by_token.get(new URL(request.url).pathname.slice(1))
  if (!media) return refuse(404)
  const range = request.headers.get("range")
  let response: Response
  try {
    response = await fetch_media(media.url, { credentials: "omit", redirect: "follow", headers: range ? { range } : {} })
  } catch {
    return refuse(502)
  }
  const type = response.headers.get("content-type") ?? ""
  const length = Number(response.headers.get("content-length") ?? "0")
  if (!response.ok || !MEDIA_TYPE.test(type) || length > limit || !response.body) {
    await response.body?.cancel().catch(ignore)
    return refuse(!response.ok ? 502 : length > limit ? 413 : 415)
  }
  const headers = new Headers()
  for (const name of PASSED_HEADERS) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(response.body.pipeThrough(new TransformStream(new ByteCap(limit))), { status: response.status, headers })
}
