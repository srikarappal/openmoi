// The host player surface: a video a lens asks to play shows in YouTube's official embed, in a view the host owns above
// the lens and in a session of its own without your cookies. The lens only names the item; it never gets the player,
// and anything the embed tries to open goes where originals open.
import { WebContentsView } from "electron"
import { youtube_video_id } from "../shared/address"
import type { Item, PlayerInfo } from "../shared/types"
import { ignore_navigation_error, type ViewHost } from "./host"

export const PLAYER_PARTITION = "player"
const DEFAULT_EMBED_BASE = "https://www.youtube-nocookie.com"

export interface PlayerHooks {
  open_original(url: string): void
  changed(): void
}

export function embed_url(video_id: string, base: string): string {
  return `${base}/embed/${encodeURIComponent(video_id)}?autoplay=1&rel=0&modestbranding=1`
}

export class Player {
  private view: WebContentsView | null = null
  playing: PlayerInfo | null = null

  constructor(
    private readonly host: ViewHost,
    private readonly hooks: PlayerHooks,
    private readonly embed_base = process.env.MOI_EMBED_BASE || DEFAULT_EMBED_BASE,
  ) {}

  // Plays a YouTube item above the lens; false for anything that is not a YouTube video.
  play(item: Item): boolean {
    const video_id = youtube_video_id(item.url)
    if (!video_id) return false
    this.close()
    const view = new WebContentsView({ webPreferences: { partition: PLAYER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const contents = view.webContents
    const origin = new URL(this.embed_base).origin
    contents.on("will-navigate", (event, url) => {
      if (new URL(url).origin === origin) return
      event.preventDefault()
      this.hooks.open_original(url)
    })
    contents.setWindowOpenHandler(({ url }) => {
      this.hooks.open_original(url)
      return { action: "deny" }
    })
    contents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault()
        this.close()
      }
    })
    this.host.attach(view)
    view.setVisible(true)
    this.view = view
    this.playing = { item_id: item.item_id, title: item.title || item.text || "Video", url: item.url }
    contents.loadURL(embed_url(video_id, this.embed_base)).catch(ignore_navigation_error)
    this.hooks.changed()
    return true
  }

  // Brings the player back above whatever was just put in front of it.
  front(): WebContentsView | null {
    return this.view
  }

  close(): void {
    if (!this.view) return
    this.host.detach(this.view)
    this.view.webContents.close()
    this.view = null
    this.playing = null
    this.hooks.changed()
  }
}
