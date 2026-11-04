// The two browser sessions: your web session (shared by tabs and source views) and the locked down lens session.
import { session, type WebPreferences } from "electron"
import { lens_request_allowed } from "../shared/lens_doc"

export const WEB_PARTITION = "persist:web"
export const LENS_PARTITION = "lens"

// Present the standard Chromium user agent, like other Chromium based browsers; deny permissions by default.
export function configure_sessions(): void {
  const web = session.fromPartition(WEB_PARTITION)
  web.setUserAgent(web.getUserAgent().replace(/\s(Electron|openmoi_shell)\/\S+/g, ""))
  web.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"))
  const lens = session.fromPartition(LENS_PARTITION)
  lens.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !lens_request_allowed(details.url, details.resourceType) }))
  lens.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}

export function web_preferences(preload: string, background: boolean): WebPreferences {
  return { partition: WEB_PARTITION, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: !background }
}

export function lens_preferences(preload: string): WebPreferences {
  return { partition: LENS_PARTITION, preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
}
