// Preload for lens views: exposes the moi helper, the only thing a lens can call.
import { contextBridge, ipcRenderer } from "electron"
import type { HostToLens, LensToHost, ViewItem } from "../shared/types"

type Listener = (items: ViewItem[], cursor: string | null) => void

const listeners: Record<HostToLens["type"], Listener[]> = { render: [], append: [], update: [] }

// How long the lens took to handle each message, for the test gate's speed check.
ipcRenderer.on("moi:lens", (_event, message: HostToLens) => {
  const started = performance.now()
  try {
    for (const listener of listeners[message.type] ?? []) listener(message.items, message.cursor)
  } finally {
    ipcRenderer.send("moi:lens_timing", { type: message.type, count: Array.isArray(message.items) ? message.items.length : 0, ms: performance.now() - started })
  }
})

function send(message: LensToHost): void {
  ipcRenderer.send("moi:lens_event", message)
}

// Opening an item or asking for less like it takes your click or key press: a lens script calling these on its
// own (say for every item as it renders) is ignored.
function by_you(): boolean {
  return navigator.userActivation?.isActive ?? false
}

contextBridge.exposeInMainWorld("moi", {
  on_render: (listener: Listener) => listeners.render.push(listener),
  on_append: (listener: Listener) => listeners.append.push(listener),
  on_update: (listener: Listener) => listeners.update.push(listener),
  ready: () => send({ type: "ready" }),
  open: (item_id: string) => {
    if (by_you()) send({ type: "open", item_id: String(item_id) })
  },
  more: (cursor: string) => send({ type: "more", cursor: String(cursor) }),
  seen: (item_ids: string[]) => send({ type: "seen", item_ids: Array.from(item_ids, String) }),
  less_like_this: (item_id: string) => {
    if (by_you()) send({ type: "less_like_this", item_id: String(item_id) })
  },
  play: (item_id: string) => {
    if (by_you()) send({ type: "play", item_id: String(item_id) })
  },
  save: (item_id: string, collection = "read_later") => {
    if (by_you()) send({ type: "save", item_id: String(item_id), collection: String(collection) })
  },
  unsave: (item_id: string, collection = "read_later") => {
    if (by_you()) send({ type: "unsave", item_id: String(item_id), collection: String(collection) })
  },
  highlight: (item_id: string, quote = "", note = "") => {
    if (by_you()) send({ type: "highlight", item_id: String(item_id), quote: String(quote), note: String(note) })
  },
})
