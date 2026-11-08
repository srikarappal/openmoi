import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Listener = (...args: unknown[]) => unknown

// Just enough of the chrome.* APIs the extension's scripts use, recording what they did.
class FakeChrome {
  data: Record<string, unknown> = {}
  session_data: Record<string, unknown> = {}
  readonly badges: string[] = []
  readonly alarms: Array<[string, unknown]> = []
  readonly scripts: Array<{ tabId: number; func?: string; files?: string[]; args?: unknown[] }> = []
  readonly sent_messages: unknown[] = []
  readonly listeners: Record<string, Listener[]> = {}
  tabs_by_id: Record<number, { id: number; url: string; title?: string; status?: string }> = {}
  message_reply: unknown = {}

  private on(name: string): { addListener(listener: Listener): void } {
    return { addListener: (listener: Listener) => (this.listeners[name] = [...(this.listeners[name] ?? []), listener]) }
  }

  fire(name: string, ...args: unknown[]): unknown[] {
    return (this.listeners[name] ?? []).map((listener) => listener(...args))
  }

  readonly storage = {
    local: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in this.data).map((key) => [key, this.data[key]])),
      set: async (items: Record<string, unknown>) => {
        Object.assign(this.data, items)
        this.fire("storage", Object.fromEntries(Object.keys(items).map((key) => [key, { newValue: items[key] }])))
      },
      remove: async (key: string) => {
        delete this.data[key]
      },
    },
    onChanged: this.on("storage"),
    session: {
      get: async (key: string) => (key in this.session_data ? { [key]: this.session_data[key] } : {}),
      set: async (items: Record<string, unknown>) => {
        Object.assign(this.session_data, items)
      },
    },
  }
  readonly action = { setBadgeText: async ({ text }: { text: string }) => this.badges.push(text) }
  readonly runtime = {
    onMessage: this.on("message"),
    sendMessage: async (message: unknown) => {
      this.sent_messages.push(message)
      return this.message_reply
    },
  }
  readonly tabs = {
    onUpdated: this.on("tab_updated"),
    onRemoved: this.on("tab_removed"),
    get: async (id: number) => this.tabs_by_id[id],
    query: async () => Object.values(this.tabs_by_id).slice(0, 1),
    create: async () => ({ id: 1, windowId: 1 }),
    group: async () => 1,
    remove: async (_id: number) => {},
  }
  readonly tabGroups = { update: async () => {} }
  readonly windows = { update: async () => {} }
  readonly scripting = {
    executeScript: async ({ target, func, files, args }: { target: { tabId: number }; func?: { name: string }; files?: string[]; args?: unknown[] }) => {
      this.scripts.push({ tabId: target.tabId, func: func?.name, files, args })
      return [{ result: false }]
    },
  }
  readonly alarms_api = { create: async (name: string, info: unknown) => this.alarms.push([name, info]), onAlarm: this.on("alarm") }
}

class FakeWebSocket {
  static opened: FakeWebSocket[] = []
  readyState = 1
  readonly sent: Array<Record<string, unknown>> = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.opened.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const SECRET = "ab".repeat(32)
const CHALLENGE = "c0".repeat(16)
let fake: FakeChrome

function install(data: Record<string, unknown> = {}): void {
  fake = new FakeChrome()
  fake.data = { ...data }
  FakeWebSocket.opened = []
  Object.assign(globalThis, { chrome: { ...fake, alarms: fake.alarms_api }, WebSocket: FakeWebSocket })
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function load_background(data: Record<string, unknown> = {}): Promise<FakeWebSocket> {
  install(data)
  vi.resetModules()
  await import("../../src/extension/background")
  await settle()
  return FakeWebSocket.opened[0]
}

// Plays the paired openMoi hub up to a verified welcome.
async function welcome(socket: FakeWebSocket, passive: unknown[] = []): Promise<void> {
  const hellos = hello_count(socket)
  socket.deliver({ type: "challenge", nonce: CHALLENGE })
  await vi.waitFor(() => expect(hello_count(socket)).toBe(hellos + 1))
  const nonce = String(socket.sent.filter((message) => message.type === "hello").at(-1)?.nonce)
  const proof = createHmac("sha256", Buffer.from(SECRET, "hex")).update(`openmoi:${nonce}`).digest("hex")
  socket.deliver({ type: "welcome", proof, passive, ...(fake.data.relay_secret ? {} : { secret: SECRET }) })
  await vi.waitFor(() => expect(fake.badges.at(-1)).toBe(""))
}

function hello_count(socket: FakeWebSocket): number {
  return socket.sent.filter((message) => message.type === "hello").length
}

async function message(body: Record<string, unknown>, sender: Record<string, unknown> = {}): Promise<unknown> {
  let reply: unknown
  fake.fire("message", body, sender, (answer: unknown) => (reply = answer))
  await settle()
  return reply
}

const X_SOURCE = { source_id: "x", url_prefix: "https://x.com/home", spec: { item_root: "article", fields: {} } }

describe("extension background", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("connects to the stored relay address, keeps a wake alarm and pairs when allowed", async () => {
    const socket = await load_background({ relay_url: "ws://127.0.0.1:5555/relay" })
    expect(socket.url).toBe("ws://127.0.0.1:5555/relay")
    expect(fake.alarms).toEqual([["moi_reconnect", { periodInMinutes: 0.5 }]])
    socket.deliver({ type: "challenge", nonce: CHALLENGE })
    socket.deliver({ type: "approval_needed", extension_id: "me" })
    await vi.waitFor(() => expect(fake.badges.at(-1)).toBe("?"))
    expect(await message({ type: "status" })).toEqual({ state: "waiting_for_approval", relay_url: "ws://127.0.0.1:5555/relay", passive_enabled: true })
    await welcome(socket)
    expect(fake.data.relay_secret).toBe(SECRET)
    expect(fake.badges.at(-1)).toBe("")
  })

  it("uses the default address, reconnects after a drop and on the alarm and when the address changes", async () => {
    const socket = await load_background()
    vi.useFakeTimers()
    expect(socket.url).toBe("ws://127.0.0.1:47321/relay")
    socket.close()
    expect(fake.badges.at(-1)).toBe("off")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(FakeWebSocket.opened).toHaveLength(2)
    fake.fire("alarm", { name: "moi_reconnect" })
    fake.fire("alarm", { name: "other" })
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.opened).toHaveLength(2)
    await fake.storage.local.set({ relay_url: "ws://127.0.0.1:6666/relay" })
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.opened.at(-1)?.url).toBe("ws://127.0.0.1:6666/relay")
    expect(FakeWebSocket.opened[1].readyState).toBe(3)
  })

  it("closes its reading tabs a minute after openMoi went away, not before", async () => {
    const socket = await load_background({ relay_secret: SECRET })
    await welcome(socket)
    const relay = (globalThis as unknown as { moi_relay: { commands: { opened: Set<number> } } }).moi_relay
    relay.commands.opened.add(41)
    const removed: number[] = []
    fake.tabs.remove = async (id: number) => {
      removed.push(id)
    }
    vi.useFakeTimers()
    socket.close()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(removed).toEqual([])
    await vi.advanceTimersByTimeAsync(58_000)
    fake.fire("alarm", { name: "moi_reconnect" })
    await vi.advanceTimersByTimeAsync(10)
    expect(removed).toEqual([41])
  })

  it("lets openMoi read a tab of yours only after you press Mine on it", async () => {
    const socket = await load_background({ relay_secret: SECRET })
    await welcome(socket)
    fake.tabs_by_id[7] = { id: 7, url: "https://shop.example.com/", title: "Shop" }
    expect(await message({ type: "mine", tab_id: 7 })).toEqual({ sent: true })
    expect(socket.sent.at(-1)).toEqual({ type: "event", event: "mine", handle: "7", url: "https://shop.example.com/", title: "Shop" })
    const relay = (globalThis as unknown as { moi_relay: { commands: { chosen: Set<number> } } }).moi_relay
    expect(relay.commands.chosen.has(7)).toBe(true)
    fake.fire("tab_removed", 7)
    expect(relay.commands.chosen.has(7)).toBe(false)
  })

  it("forwards records from source pages you browse yourself, never from its own tabs", async () => {
    const socket = await load_background({ relay_secret: SECRET })
    await welcome(socket, [X_SOURCE])
    const records = [{ native_id: "1", url: "https://x.com/a/status/1", text: "hi" }]
    expect(await message({ type: "passive_records", source_id: "x", page_url: "https://x.com/home", records }, { tab: { id: 4 } })).toEqual({ sent: true })
    const relay = (globalThis as unknown as { moi_relay: { commands: { opened: Set<number> } } }).moi_relay
    relay.commands.opened.add(5)
    expect(await message({ type: "passive_records", source_id: "x", page_url: "https://x.com/home", records }, { tab: { id: 5 } })).toEqual({})
    expect(await message({ type: "something else" })).toEqual({})
    expect(socket.sent.filter((sent) => sent.event === "passive_records")).toHaveLength(1)
  })

  it("starts the watcher on a source page you open, unless passive reading is off", async () => {
    const socket = await load_background({ relay_secret: SECRET })
    await welcome(socket, [X_SOURCE])
    fake.fire("tab_updated", 9, { status: "complete" }, { id: 9, url: "https://x.com/home" })
    fake.fire("tab_updated", 10, { status: "loading" }, { id: 10, url: "https://x.com/home" })
    fake.fire("tab_updated", 11, { status: "complete" }, { id: 11, url: "https://mail.example.com/" })
    await settle()
    expect(fake.scripts.map((script) => [script.tabId, script.func ?? script.files?.[0]])).toEqual([
      [9, "has_page_ops"],
      [9, "content.js"],
      [9, "start_watch"],
    ])
    await fake.storage.local.set({ passive_enabled: false })
    fake.fire("tab_updated", 12, { status: "complete" }, { id: 12, url: "https://x.com/home" })
    await settle()
    expect(fake.scripts.some((script) => script.tabId === 12)).toBe(false)
  })

  it("pairs again when you ask: forgets the secret and reconnects", async () => {
    const socket = await load_background({ relay_secret: SECRET })
    socket.deliver({ type: "challenge", nonce: CHALLENGE })
    socket.deliver({ type: "approval_needed", extension_id: "me" })
    await vi.waitFor(() => expect(fake.badges.at(-1)).toBe("!"))
    expect(await message({ type: "pair_again" })).toEqual({ state: "offline" })
    expect(fake.data.relay_secret).toBeUndefined()
    expect(FakeWebSocket.opened).toHaveLength(2)
  })
})

const POPUP = `<div id="status"></div><button id="mine"></button><button id="pair" hidden></button><div id="note"></div><input id="passive" type="checkbox">`

async function load_popup(status: Record<string, unknown>, tab = { id: 3, url: "https://a.example" }): Promise<void> {
  install()
  fake.message_reply = status
  fake.tabs_by_id = { 3: tab }
  document.body.innerHTML = POPUP
  vi.resetModules()
  await import("../../src/extension/popup")
  await settle()
}

function element(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

describe("extension popup", () => {
  it("shows the state, enables Mine only when connected and hides Pair again", async () => {
    await load_popup({ state: "connected", passive_enabled: true })
    expect(element("status").textContent).toBe("Connected to openMoi")
    expect((element("mine") as HTMLButtonElement).disabled).toBe(false)
    expect(element("pair").hidden).toBe(true)
    expect((element("passive") as HTMLInputElement).checked).toBe(true)
    fake.message_reply = { sent: true }
    element("mine").click()
    await settle()
    expect(fake.sent_messages.at(-1)).toEqual({ type: "mine", tab_id: 3 })
    expect(element("note").textContent).toBe("Opening your version in openMoi.")
  })

  it("offers Pair again when openMoi does not know this browser", async () => {
    await load_popup({ state: "unrecognized", passive_enabled: false })
    expect(element("status").textContent).toContain("does not know this browser")
    expect(element("pair").hidden).toBe(false)
    expect((element("mine") as HTMLButtonElement).disabled).toBe(true)
    fake.message_reply = { state: "waiting_for_approval", passive_enabled: false }
    element("pair").click()
    await settle()
    expect(fake.sent_messages).toContainEqual({ type: "pair_again" })
    expect(element("note").textContent).toBe("Now allow this browser in the openMoi app.")
  })

  it("saves the passive switch and says when openMoi is not there", async () => {
    await load_popup({ state: "offline", passive_enabled: true })
    expect(element("status").textContent).toBe("openMoi is not running")
    expect((element("mine") as HTMLButtonElement).disabled).toBe(true)
    await load_popup({ state: "connected", passive_enabled: true })
    const passive = element("passive") as HTMLInputElement
    passive.checked = false
    passive.dispatchEvent(new Event("change"))
    await settle()
    expect(fake.data.passive_enabled).toBe(false)
    fake.message_reply = { sent: false }
    element("mine").click()
    await settle()
    expect(element("note").textContent).toBe("openMoi is not connected.")
  })
})

describe("extension content script", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("exposes the page operations and sends each new item of a source page once", async () => {
    install()
    document.body.innerHTML = `<article><a href="/a/status/1">First post</a></article>`
    vi.resetModules()
    await import("../../src/extension/content")
    const page = globalThis as unknown as { moi_page_op: (op: string, args: unknown) => unknown; moi_watch: (source_id: string, url_prefix: string, spec: unknown) => void }
    expect(page.moi_page_op("info", {})).toEqual({ url: location.href, title: document.title })
    const spec = { item_root: "article", fields: { url: { select: "a", take: "attr:href", transform: "absolute_url" }, title: { select: "a", take: "text" } }, pagination: { kind: "none" } }
    page.moi_watch("x", location.origin, spec)
    page.moi_watch("x", location.origin, spec)
    expect(fake.sent_messages).toHaveLength(1)
    expect(fake.sent_messages[0]).toMatchObject({ type: "passive_records", source_id: "x", records: [{ title: "First post" }] })
    document.body.insertAdjacentHTML("beforeend", `<article><a href="/a/status/2">Second post</a></article>`)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fake.sent_messages).toHaveLength(2)
    expect((fake.sent_messages[1] as { records: Array<{ title: string }> }).records.map((record) => record.title)).toEqual(["Second post"])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fake.sent_messages).toHaveLength(2)
  })
})
