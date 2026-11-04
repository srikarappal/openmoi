// What the managers need from the window: a place to put views and the preload paths.
import type { WebContentsView } from "electron"

export interface ViewHost {
  readonly page_preload: string
  readonly lens_preload: string
  attach(view: WebContentsView): void
  attach_behind(view: WebContentsView): void
  detach(view: WebContentsView): void
}

// Swallows the ERR_ABORTED rejections Electron raises when a load is superseded by a redirect or new load.
export function ignore_navigation_error(): void {}
