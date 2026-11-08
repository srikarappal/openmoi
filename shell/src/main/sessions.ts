// The two browser sessions: your web session (shared by tabs and source views) and the locked down lens session.
import { session, type WebPreferences } from "electron"
import { image_key, lens_request_allowed } from "../shared/lens_doc"

// Per lens web contents: the item images it may load and what it tried to load besides (the smoke test fails on that).
const lens_images = new Map<number, Set<string>>()
const lens_blocked = new Map<number, string[]>()

export function allow_lens_images(contents_id: number, urls: string[]): void {
  const allowed = lens_images.get(contents_id) ?? new Set<string>()
  for (const url of urls) {
    const key = image_key(url)
    if (key) allowed.add(key)
  }
  lens_images.set(contents_id, allowed)
}

export function blocked_lens_requests(contents_id: number): string[] {
  return lens_blocked.get(contents_id) ?? []
}

export function forget_lens(contents_id: number): void {
  lens_images.delete(contents_id)
  lens_blocked.delete(contents_id)
}

// An item image that redirects (a CDN moving it) may load where it lands; nothing else gains a way out.
function follow_redirect(details: { url: string; redirectURL: string; webContentsId?: number }): void {
  const allowed = lens_images.get(details.webContentsId ?? -1)
  const from = image_key(details.url)
  const to = image_key(details.redirectURL)
  if (allowed && from && to && allowed.has(from)) allowed.add(to)
}

function lens_request(details: { url: string; resourceType: string; webContentsId?: number }): boolean {
  const contents_id = details.webContentsId ?? -1
  const allowed = lens_request_allowed(details.url, details.resourceType, lens_images.get(contents_id))
  if (!allowed) lens_blocked.set(contents_id, [...blocked_lens_requests(contents_id), details.url].slice(-20))
  return allowed
}

export const WEB_PARTITION = "persist:web"
export const LENS_PARTITION = "lens"

// Present the standard Chromium user agent, like other Chromium based browsers; deny permissions by default.
export function configure_sessions(): void {
  const web = session.fromPartition(WEB_PARTITION)
  web.setUserAgent(web.getUserAgent().replace(/\s(Electron|openmoi_shell)\/\S+/g, ""))
  web.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"))
  const lens = session.fromPartition(LENS_PARTITION)
  lens.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !lens_request(details) }))
  lens.webRequest.onBeforeRedirect((details) => follow_redirect(details))
  lens.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}

export function web_preferences(preload: string, background: boolean): WebPreferences {
  return { partition: WEB_PARTITION, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: !background }
}

export function lens_preferences(preload: string): WebPreferences {
  return { partition: LENS_PARTITION, preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
}
