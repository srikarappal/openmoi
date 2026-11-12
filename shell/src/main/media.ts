// The media proxy: a lens never sees where an image lives. Each image of the items a lens is sent becomes
// moi-media://m/<token>, a random token for that lens. The host fetches every one of them at once, a single time per
// address, without cookies, and keeps the bytes; a lens loading a token, again or never, changes nothing an image's
// site can see, so images can carry nothing out. Only public https images come back: an address that is or resolves
// to a private or loopback network, also partway through redirects, is never fetched.
import { randomBytes } from "node:crypto"
import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"

export const MEDIA_SCHEME = "moi-media"
export const MAX_MEDIA_BYTES = 25_000_000
const MAX_CACHE_BYTES = 200_000_000
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 15_000
// A failed image is not asked for again for this long, however often a lens loads its token.
const RETRY_FAILED_MS = 10 * 60_000
const MEDIA_TYPE = /^image\//i
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/i

const PRIVATE = new BlockList()
const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
]
const PRIVATE_V6: Array<[string, number]> = [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]]
for (const [network, prefix] of PRIVATE_V4) PRIVATE.addSubnet(network, prefix, "ipv4")
for (const [network, prefix] of PRIVATE_V6) PRIVATE.addSubnet(network, prefix, "ipv6")

export type MediaFetch = (url: string, init: RequestInit) => Promise<Response>
export type Resolve = (host: string) => Promise<string[]>

interface Cached {
  body: ArrayBuffer
  type: string
}

interface Loading {
  result: Promise<Cached | null>
  failed_at: number | null
  size: number
}

const by_token = new Map<string, string>()
const by_lens = new Map<number, Map<string, string>>()
// By address, oldest first, so the oldest go when the cache is full.
const cache = new Map<string, Loading>()
let cached_bytes = 0
let fetch_media: MediaFetch = () => Promise.reject(new Error("the media proxy is not set up"))
let resolve_host: Resolve = resolve_with_dns

async function resolve_with_dns(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((found) => found.address)
}

function ignore(): void {}

// Where the proxy fetches and how it resolves names; set once with the sessions, and by tests.
export function configure_media(fetcher: MediaFetch, resolver: Resolve = resolve_with_dns): void {
  fetch_media = fetcher
  resolve_host = resolver
  cache.clear()
  cached_bytes = 0
}

export function is_private_address(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return PRIVATE.check(mapped[1], "ipv4")
  const family = isIP(address)
  return family === 0 || PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6")
}

// The test world serves its images from this machine over http; only its tests turn this on.
function test_world(url: URL): boolean {
  return process.env.MOI_MEDIA_LOOPBACK === "1" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
}

// An address the proxy may try: https to a name or a public address (where the name leads is checked when fetching).
export function is_media_source(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (test_world(parsed)) return true
    const host = parsed.hostname.replace(/^\[|\]$/g, "")
    if (parsed.protocol !== "https:" || LOCAL_NAMES.test(host)) return false
    return isIP(host) ? !is_private_address(host) : host.includes(".")
  } catch {
    return false
  }
}

async function leads_somewhere_public(url: URL): Promise<boolean> {
  if (test_world(url)) return true
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (isIP(host)) return !is_private_address(host)
  const addresses = await resolve_host(host).catch((): string[] => [])
  return addresses.length > 0 && addresses.every((address) => !is_private_address(address))
}

// The response at an address, following redirects one hop at a time so every hop is checked; null when a hop goes
// somewhere private or there are too many.
export async function fetch_public(url: string): Promise<Response | null> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!is_media_source(current) || !(await leads_somewhere_public(new URL(current)))) return null
    const response = await fetch_media(current, { credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get("location")
    await response.body?.cancel().catch(ignore)
    if (!location) return null
    current = new URL(location, current).href
  }
  return null
}

async function read_capped(response: Response, limit: number): Promise<ArrayBuffer | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(ignore)
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(new ArrayBuffer(total))
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer as ArrayBuffer
}

async function load(url: string, limit: number): Promise<Cached | null> {
  try {
    const response = await fetch_public(url)
    const type = response?.headers.get("content-type") ?? ""
    if (!response?.ok || !MEDIA_TYPE.test(type) || Number(response.headers.get("content-length") ?? "0") > limit) {
      await response?.body?.cancel().catch(ignore)
      return null
    }
    const body = await read_capped(response, limit)
    return body ? { body, type } : null
  } catch {
    return null
  }
}

// Counts a fetched image against the cache and lets the oldest images go once it is full.
function keep(url: string, loading: Loading, cached: Cached | null): void {
  if (cache.get(url) !== loading) return
  if (!cached) {
    loading.failed_at = Date.now()
    return
  }
  loading.size = cached.body.byteLength
  cached_bytes += loading.size
  for (const [old_url, old] of cache) {
    if (cached_bytes <= MAX_CACHE_BYTES) break
    if (old_url === url) continue
    cache.delete(old_url)
    cached_bytes -= old.size
  }
}

// The image at an address, fetched once and kept; a failure is kept for a while too.
export function media_for(url: string, limit = MAX_MEDIA_BYTES): Promise<Cached | null> {
  const known = cache.get(url)
  if (known && (known.failed_at === null || Date.now() - known.failed_at < RETRY_FAILED_MS)) {
    cache.delete(url)
    cache.set(url, known)
    return known.result
  }
  if (known) cache.delete(url)
  const loading: Loading = { result: load(url, limit), failed_at: null, size: 0 }
  cache.set(url, loading)
  loading.result.then((cached) => keep(url, loading, cached), ignore)
  return loading.result
}

// The address a lens gets for an item's image: a data image as it is, a web address as a token for that lens (and
// its image fetched now, whether the lens ever loads it or not), anything else nothing.
export function media_url(contents_id: number, url: string): string | null {
  if (url.startsWith("data:image/")) return url
  if (!is_media_source(url)) return null
  const tokens = by_lens.get(contents_id) ?? new Map<string, string>()
  by_lens.set(contents_id, tokens)
  let token = tokens.get(url)
  if (!token) {
    token = randomBytes(16).toString("hex")
    tokens.set(url, token)
    by_token.set(token, url)
    media_for(url).catch(ignore)
  }
  return `${MEDIA_SCHEME}://m/${token}`
}

// A lens that rendered anew, or closed, gives up the tokens it had; the images stay cached by address.
export function forget_media(contents_id: number): void {
  for (const token of by_lens.get(contents_id)?.values() ?? []) by_token.delete(token)
  by_lens.delete(contents_id)
}

function refuse(status: number): Response {
  return new Response(null, { status })
}

// Answers a lens's moi-media request from what was fetched for its token; a token with anything added is no token.
export async function serve_media(request: Request): Promise<Response> {
  const asked = new URL(request.url)
  const url = asked.search || asked.hash ? undefined : by_token.get(asked.pathname.slice(1))
  if (!url) return refuse(404)
  const cached = await media_for(url)
  if (!cached) return refuse(502)
  return new Response(cached.body, { status: 200, headers: { "content-type": cached.type, "content-length": String(cached.body.byteLength) } })
}
