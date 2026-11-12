// Preload for lens views: exposes the moi helper, the only thing a lens can call.
import { contextBridge, ipcRenderer } from "electron"
import type { HostToLens, LensToHost, ViewItem } from "../shared/types"

type Listener = (items: ViewItem[], cursor: string | null) => void

const listeners: Record<HostToLens["type"], Listener[]> = { render: [], append: [], update: [] }

// A render is timed until its items are in the page and laid out, however the lens spreads its work over frames.
const SETTLE_LIMIT_MS = 2_000

function report_timing(type: string, count: number, started: number): void {
  ipcRenderer.send("moi:lens_timing", { type, count, ms: performance.now() - started })
}

function report_when_shown(type: string, count: number, started: number): void {
  if (document.querySelectorAll("[data-item-id]").length >= count || performance.now() - started > SETTLE_LIMIT_MS) {
    document.body?.getBoundingClientRect()
    report_timing(type, count, started)
  } else {
    requestAnimationFrame(() => report_when_shown(type, count, started))
  }
}

// How long the lens took to handle each message, for the test gate's speed check.
ipcRenderer.on("moi:lens", (_event, message: HostToLens) => {
  const started = performance.now()
  const count = Array.isArray(message.items) ? message.items.length : 0
  try {
    for (const listener of listeners[message.type] ?? []) listener(message.items, message.cursor)
  } finally {
    if (message.type === "render" && count > 0) report_when_shown(message.type, count, started)
    else report_timing(message.type, count, started)
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
  // Asks openMoi to act on the site for you (like, follow, reply, add to cart); the gate decides, on your click only.
  act: (item_id: string, action: string, text = "") => {
    if (by_you()) send({ type: "act", item_id: String(item_id), action: String(action), text: String(text) })
  },
  // Looks up a name a post mentions in the view's store: one search page, on your click only.
  lookup: (item_id: string, entity: string) => {
    if (by_you()) send({ type: "lookup", item_id: String(item_id), entity: String(entity) })
  },
  highlight: (item_id: string, quote = "", note = "") => {
    if (by_you()) send({ type: "highlight", item_id: String(item_id), quote: String(quote), note: String(note) })
  },
})
