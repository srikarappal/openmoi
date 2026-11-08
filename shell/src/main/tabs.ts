// Ordinary web tabs in your session. Links that open new windows become new tabs.
import { WebContentsView } from "electron"
import { is_web_url, normalize_address } from "../shared/address"
import type { TabInfo } from "../shared/types"
import { ignore_navigation_error, type ViewHost } from "./host"
import { web_preferences } from "./sessions"

export interface Tab {
  tab_id: number
  view: WebContentsView
  mine: boolean
}

export interface TabHooks {
  changed(): void
  opened(tab: Tab): void
  navigated(tab: Tab): void
}

export class TabManager {
  private readonly tabs = new Map<number, Tab>()
  private next_id = 1

  constructor(
    private readonly host: ViewHost,
    private readonly hooks: TabHooks,
  ) {}

  open(address: string): Tab {
    const view = new WebContentsView({ webPreferences: web_preferences(this.host.page_preload, false) })
    const tab: Tab = { tab_id: this.next_id++, view, mine: false }
    this.tabs.set(tab.tab_id, tab)
    this.host.attach(view)
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (is_web_url(url)) this.hooks.opened(this.open(url))
      return { action: "deny" }
    })
    view.webContents.on("page-title-updated", () => this.hooks.changed())
    view.webContents.on("did-navigate-in-page", () => this.hooks.changed())
    view.webContents.on("did-navigate", () => this.hooks.navigated(tab))
    this.navigate(tab, address)
    return tab
  }

  navigate(tab: Tab, address: string): void {
    tab.view.webContents.loadURL(normalize_address(address)).catch(ignore_navigation_error)
  }

  get(tab_id: number): Tab | undefined {
    return this.tabs.get(tab_id)
  }

  close(tab_id: number): void {
    const tab = this.tabs.get(tab_id)
    if (!tab) return
    this.tabs.delete(tab_id)
    this.host.detach(tab.view)
    tab.view.webContents.close()
  }

  all(): Tab[] {
    return [...this.tabs.values()]
  }

  infos(): TabInfo[] {
    return this.all().map((tab) => ({
      tab_id: tab.tab_id,
      title: tab.view.webContents.getTitle(),
      url: tab.view.webContents.getURL(),
      mine: tab.mine,
    }))
  }
}
