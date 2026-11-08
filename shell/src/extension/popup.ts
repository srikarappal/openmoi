// The toolbar popup: relay status, "Mine this page" and the passive reading switch.
const STATUS_TEXT: Record<string, string> = {
  connected: "Connected to openMoi",
  waiting_for_approval: "Allow this extension in the openMoi app",
  offline: "openMoi is not running",
  unrecognized: "The openMoi on this computer does not know this browser. If you reset openMoi, pair again.",
}

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

async function show_status(): Promise<void> {
  const status = await chrome.runtime.sendMessage({ type: "status" })
  element("status").textContent = STATUS_TEXT[status.state] ?? status.state
  element<HTMLButtonElement>("mine").disabled = status.state !== "connected"
  element<HTMLInputElement>("passive").checked = status.passive_enabled
  element("pair").hidden = status.state !== "unrecognized"
}

async function pair_again(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "pair_again" })
  element("note").textContent = "Now allow this browser in the openMoi app."
  await show_status()
}

async function mine_this_page(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const reply = tab?.id === undefined ? { sent: false } : await chrome.runtime.sendMessage({ type: "mine", tab_id: tab.id })
  element("note").textContent = reply.sent ? "Opening your version in openMoi." : "openMoi is not connected."
}

async function set_passive(): Promise<void> {
  await chrome.storage.local.set({ passive_enabled: element<HTMLInputElement>("passive").checked })
}

element("mine").addEventListener("click", () => mine_this_page())
element("passive").addEventListener("change", () => set_passive())
element("pair").addEventListener("click", () => pair_again())
show_status()
