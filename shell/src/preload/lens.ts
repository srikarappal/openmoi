// Preload for lens views: exposes the moi helper, the only thing a lens can call.
import { contextBridge, ipcRenderer } from "electron"
import type { HostToLens, LensToHost, ViewItem } from "../shared/types"

type Listener = (items: ViewItem[], cursor: string | null) => void

const listeners: Record<HostToLens["type"], Listener[]> = { render: [], append: [] }

ipcRenderer.on("moi:lens", (_event, message: HostToLens) => {
  for (const listener of listeners[message.type] ?? []) listener(message.items, message.cursor)
})

function send(message: LensToHost): void {
  ipcRenderer.send("moi:lens_event", message)
}

contextBridge.exposeInMainWorld("moi", {
  on_render: (listener: Listener) => listeners.render.push(listener),
  on_append: (listener: Listener) => listeners.append.push(listener),
  ready: () => send({ type: "ready" }),
  open: (item_id: string) => send({ type: "open", item_id: String(item_id) }),
  more: (cursor: string) => send({ type: "more", cursor: String(cursor) }),
  seen: (item_ids: string[]) => send({ type: "seen", item_ids: Array.from(item_ids, String) }),
  less_like_this: (item_id: string) => send({ type: "less_like_this", item_id: String(item_id) }),
})
