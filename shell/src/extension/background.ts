// The extension's service worker: keeps the relay connected, answers openMoi's calls and forwards what you browse.
import type { ExtractorSpec } from "../shared/types"
import { ChromeCommands } from "./commands"
import { RelayClient, type RelayState, type SocketLike } from "./relay_client"

const DEFAULT_RELAY_URL = "ws://127.0.0.1:47321/relay"
const RECONNECT_ALARM = "moi_reconnect"
const RECONNECT_MS = 3_000
const BADGES: Record<RelayState, string> = { connected: "", waiting_for_approval: "?", offline: "off" }

interface Settings {
  relay_url: string
  passive_enabled: boolean
}

interface MoiPage {
  moi_watch?: (source_id: string, url_prefix: string, spec: ExtractorSpec) => void
}

function ignore(): void {}

// Runs inside the page, next to the injected content script.
function start_watch(source_id: string, url_prefix: string, spec: ExtractorSpec): void {
  ;(globalThis as MoiPage).moi_watch?.(source_id, url_prefix, spec)
}

function open_socket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike
}

async function settings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(["relay_url", "passive_enabled"])
  return { relay_url: String(stored.relay_url || DEFAULT_RELAY_URL), passive_enabled: stored.passive_enabled !== false }
}

function on_relay_change(state: RelayState): void {
  chrome.action.setBadgeText({ text: BADGES[state] }).catch(ignore)
  if (state === "offline") setTimeout(() => ensure_connected().catch(ignore), RECONNECT_MS)
}

const commands = new ChromeCommands(chrome)
const relay = new RelayClient(commands, open_socket, on_relay_change)

async function ensure_connected(): Promise<void> {
  relay.connect((await settings()).relay_url)
}

async function reconnect(): Promise<void> {
  relay.disconnect()
  await ensure_connected()
}

// A source page you opened yourself (not one openMoi opened) gets the passive watcher.
async function watch_if_passive(tab_id: number, url: string): Promise<void> {
  const source = relay.passive_source_for(url)
  if (!source || commands.opened.has(tab_id) || !(await settings()).passive_enabled) return
  await commands.inject(tab_id)
  await chrome.scripting.executeScript({ target: { tabId: tab_id }, func: start_watch, args: [source.source_id, source.url_prefix, source.spec] })
}

export function mine_tab(tab: chrome.tabs.Tab): boolean {
  if (tab.id === undefined || !tab.url) return false
  return relay.send_event({ event: "mine", handle: String(tab.id), url: tab.url, title: tab.title ?? "" })
}

async function handle_message(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (message.type === "status") return { state: relay.state, ...(await settings()) }
  if (message.type === "mine") return { sent: mine_tab(await chrome.tabs.get(Number(message.tab_id))) }
  const tab_id = sender.tab?.id
  if (message.type === "passive_records" && tab_id !== undefined && !commands.opened.has(tab_id)) {
    return { sent: relay.send_event({ event: "passive_records", source_id: message.source_id, page_url: message.page_url, records: message.records }) }
  }
  return {}
}

chrome.runtime.onMessage.addListener((message, sender, send_response) => {
  handle_message(message, sender).then(send_response, (error) => send_response({ error: String(error) }))
  return true
})
chrome.tabs.onUpdated.addListener((tab_id, change, tab) => {
  if (change.status === "complete" && tab.url) watch_if_passive(tab_id, tab.url).catch(ignore)
})
chrome.storage.onChanged.addListener((changes) => {
  if (changes.relay_url) reconnect().catch(ignore)
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) ensure_connected().catch(ignore)
})
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 }).catch(ignore)
ensure_connected().catch(ignore)

// A handle for debugging from the service worker console (and for the end to end tests).
Object.assign(globalThis, { moi_relay: { relay, commands, mine_tab } })
