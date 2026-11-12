// The browser sessions: your web session (shared by tabs and source views), the locked down lens session and the
// cookieless session the media proxy fetches lens images in.
import { session, type WebPreferences } from "electron"
import { lens_request_allowed } from "../shared/lens_doc"
import { MEDIA_SCHEME, forget_media, serve_media } from "./media"

// Per lens web contents, what it tried to load besides its document, data URLs and its media tokens (the test gate
// fails a lens on that).
const lens_blocked = new Map<number, string[]>()

export function blocked_lens_requests(contents_id: number): string[] {
  return lens_blocked.get(contents_id) ?? []
}

export function forget_lens(contents_id: number): void {
  lens_blocked.delete(contents_id)
  forget_media(contents_id)
}

function lens_request(details: { url: string; webContentsId?: number }): boolean {
  const contents_id = details.webContentsId ?? -1
  const allowed = lens_request_allowed(details.url)
  if (!allowed) lens_blocked.set(contents_id, [...blocked_lens_requests(contents_id), details.url].slice(-20))
  return allowed
}

export const WEB_PARTITION = "persist:web"
export const LENS_PARTITION = "lens"
export const MEDIA_PARTITION = "media"

function media_fetch(url: string, init: RequestInit): Promise<Response> {
  return session.fromPartition(MEDIA_PARTITION).fetch(url, init)
}

// Present the standard Chromium user agent, like other Chromium based browsers; deny permissions by default.
export function configure_sessions(): void {
  const web = session.fromPartition(WEB_PARTITION)
  web.setUserAgent(web.getUserAgent().replace(/\s(Electron|openmoi_shell)\/\S+/g, ""))
  web.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"))
  const lens = session.fromPartition(LENS_PARTITION)
  lens.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !lens_request(details) }))
  lens.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  lens.protocol.handle(MEDIA_SCHEME, (request) => serve_media(request, media_fetch))
  const media = session.fromPartition(MEDIA_PARTITION)
  media.setUserAgent(web.getUserAgent())
  media.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}

export function web_preferences(preload: string, background: boolean): WebPreferences {
  return { partition: WEB_PARTITION, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: !background }
}

export function lens_preferences(preload: string): WebPreferences {
  return { partition: LENS_PARTITION, preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
}
