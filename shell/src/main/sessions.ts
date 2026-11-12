// The browser sessions: your web session (shared by tabs and source views), the locked down lens session and the
// player's session; the media proxy fetches lens images outside all of them, with no cookies at all.
import { session, type WebPreferences } from "electron"
import { lens_request_allowed } from "../shared/lens_doc"
import { MEDIA_SCHEME, configure_media, forget_media, serve_media } from "./media"

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
export const PLAYER_PARTITION = "player"
const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
let media_agent = ""

// The media proxy fetches with Node's own fetch, which hands back each redirect for checking (Electron's refuses
// to) and has no cookie jar; it introduces itself as the browser does.
function media_fetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: { "user-agent": media_agent, accept: IMAGE_ACCEPT } })
}

// Present the standard Chromium user agent, like other Chromium based browsers; deny permissions by default.
export function configure_sessions(): void {
  const web = session.fromPartition(WEB_PARTITION)
  web.setUserAgent(web.getUserAgent().replace(/\s(Electron|openmoi_shell)\/\S+/g, ""))
  web.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"))
  // A lens holds nothing of yours and never asks for anything: every permission is refused, every download cancelled.
  const lens = session.fromPartition(LENS_PARTITION)
  lens.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  lens.setPermissionCheckHandler(() => false)
  lens.on("will-download", (event) => event.preventDefault())
  lens.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !lens_request(details) }))
  lens.protocol.handle(MEDIA_SCHEME, serve_media)
  media_agent = web.getUserAgent()
  configure_media(media_fetch)
  // The player may go full screen and nothing more; what it would download is cancelled.
  const player = session.fromPartition(PLAYER_PARTITION)
  player.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"))
  player.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen")
  player.on("will-download", (event) => event.preventDefault())
}

export function web_preferences(preload: string, background: boolean): WebPreferences {
  return { partition: WEB_PARTITION, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: !background }
}

// A lens can raise no alert, confirm or prompt: a loop of them would lock the app behind native dialogs.
export function lens_preferences(preload: string): WebPreferences {
  return { partition: LENS_PARTITION, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true }
}
