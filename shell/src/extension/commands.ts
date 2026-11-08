// What the relay may ask your Chrome to do: open a tab, run a page operation in it, report its URL, close it.
import { sleep } from "../shared/timing"
import type { PageOp } from "../shared/types"

export type ChromeApi = Pick<typeof chrome, "tabs" | "tabGroups" | "scripting" | "windows">

const LOAD_TIMEOUT_MS = 20_000
const LOAD_POLL_MS = 150
const GROUP_TITLE = "openMoi"
const PAGE_OPS_FILE = "content.js"

interface OpenArgs {
  url: string
  background?: boolean
}

interface RunArgs {
  handle: string
  op: PageOp
  args?: Record<string, unknown>
}

interface MoiPage {
  moi_page_op?: (op: string, args: unknown) => unknown
}

// These two run inside the page (serialized by chrome.scripting), next to the injected content script.
function has_page_ops(): boolean {
  return typeof (globalThis as MoiPage).moi_page_op === "function"
}

function call_page_op(op: string, args: unknown): unknown {
  return (globalThis as MoiPage).moi_page_op?.(op, args)
}

function tab_id_of(handle: unknown): number {
  const tab_id = Number(handle)
  if (!Number.isInteger(tab_id)) throw new Error(`bad tab handle ${String(handle)}`)
  return tab_id
}

// Where the extension keeps which tabs are openMoi's and which you chose, so a service worker restart (which
// drops everything in memory) neither leaves openMoi's tabs open for good nor loses your Mine choices.
export interface TabMemory {
  load(): Promise<{ opened?: number[]; chosen?: number[] }>
  save(tabs: { opened: number[]; chosen: number[] }): Promise<void>
}

function ignore(): void {}

export class ChromeCommands {
  // Tabs openMoi opened itself; only these may ever be closed by openMoi.
  readonly opened = new Set<number>()
  readonly chosen = new Set<number>()
  private group_id: number | null = null

  constructor(
    private readonly api: ChromeApi,
    private readonly memory?: TabMemory,
  ) {}

  async restore(): Promise<void> {
    const saved = (await this.memory?.load()) ?? {}
    for (const tab_id of saved.opened ?? []) this.opened.add(tab_id)
    for (const tab_id of saved.chosen ?? []) this.chosen.add(tab_id)
  }

  // You pressed Mine on this tab of yours: openMoi may read it until it closes or the Mine page goes.
  choose(tab_id: number): void {
    this.chosen.add(tab_id)
    this.remember()
  }

  private remember(): void {
    this.memory?.save({ opened: [...this.opened], chosen: [...this.chosen] }).catch(ignore)
  }

  run_command(op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "open":
        return this.open(args as unknown as OpenArgs)
      case "run":
        return this.run(args as unknown as RunArgs)
      case "url":
        return this.url(args.handle)
      case "close":
        return this.close(args.handle)
      default:
        return Promise.reject(new Error(`unknown relay op ${op}`))
    }
  }

  // Background reads go to a quiet tab in a collapsed "openMoi" group; originals open in front of you.
  // A page opened in front of you is yours as soon as it shows; a background read waits for the load and closes a tab that never loads.
  async open({ url, background = true }: OpenArgs): Promise<{ handle: string }> {
    const tab = await this.api.tabs.create({ url, active: !background })
    if (tab.id === undefined) throw new Error("Chrome did not open a tab")
    if (!background) {
      if (tab.windowId !== undefined) await this.api.windows.update(tab.windowId, { focused: true })
      return { handle: String(tab.id) }
    }
    this.opened.add(tab.id)
    this.remember()
    await this.group(tab.id)
    try {
      await this.loaded(tab.id)
    } catch (error) {
      await this.close(tab.id)
      throw error
    }
    return { handle: String(tab.id) }
  }

  async run({ handle, op, args = {} }: RunArgs): Promise<unknown> {
    const tab_id = this.allowed(handle)
    await this.inject(tab_id)
    const [frame] = await this.api.scripting.executeScript({ target: { tabId: tab_id }, func: call_page_op, args: [op, args] })
    return frame?.result ?? null
  }

  // The shared page operations, injected once per page load.
  async inject(tab_id: number): Promise<void> {
    const [probe] = await this.api.scripting.executeScript({ target: { tabId: tab_id }, func: has_page_ops })
    if (!probe?.result) await this.api.scripting.executeScript({ target: { tabId: tab_id }, files: [PAGE_OPS_FILE] })
  }

  async url(handle: unknown): Promise<string> {
    return (await this.api.tabs.get(this.allowed(handle))).url ?? ""
  }

  // Only tabs openMoi opened for reading, or tabs you chose with Mine; your other tabs are not openMoi's to read.
  private allowed(handle: unknown): number {
    const tab_id = tab_id_of(handle)
    if (!this.opened.has(tab_id) && !this.chosen.has(tab_id)) throw new Error(`tab ${tab_id} is not one openMoi opened or you chose with Mine`)
    return tab_id
  }

  forget(tab_id: number): void {
    this.opened.delete(tab_id)
    this.chosen.delete(tab_id)
    this.remember()
  }

  // openMoi's own tab closes; one of yours is only let go of, so openMoi can no longer read it.
  async close(handle: unknown): Promise<null> {
    const tab_id = tab_id_of(handle)
    if (this.opened.delete(tab_id)) await this.api.tabs.remove(tab_id)
    else this.chosen.delete(tab_id)
    this.remember()
    return null
  }

  private async loaded(tab_id: number): Promise<void> {
    const deadline = Date.now() + LOAD_TIMEOUT_MS
    while ((await this.api.tabs.get(tab_id)).status !== "complete") {
      if (Date.now() >= deadline) throw new Error("the page did not finish loading")
      await sleep(LOAD_POLL_MS)
    }
  }

  // Grouping only keeps your tab strip tidy, so a failure here never stops a read.
  private async group(tab_id: number): Promise<void> {
    try {
      if (this.group_id !== null) {
        await this.api.tabs.group({ tabIds: [tab_id], groupId: this.group_id })
        return
      }
    } catch {
      this.group_id = null
    }
    try {
      this.group_id = await this.api.tabs.group({ tabIds: [tab_id] })
      await this.api.tabGroups.update(this.group_id, { title: GROUP_TITLE, collapsed: true })
    } catch {
      this.group_id = null
    }
  }
}
