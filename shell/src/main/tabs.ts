// Ordinary web tabs in your session. Links that open new windows become new tabs.
import { WebContentsView } from "electron"
import { normalize_address } from "../shared/address"
import type { TabInfo } from "../shared/types"
import { ignore_navigation_error, type ViewHost } from "./host"
import { web_preferences } from "./sessions"

export interface Tab {
  tab_id: number
  view: WebContentsView
  mine: boolean
}

export class TabManager {
  private readonly tabs = new Map<number, Tab>()
  private next_id = 1

  constructor(
    private readonly host: ViewHost,
    private readonly on_change: () => void,
    private readonly on_new_tab: (tab: Tab) => void,
  ) {}

  open(address: string): Tab {
    const view = new WebContentsView({ webPreferences: web_preferences(this.host.page_preload, false) })
    const tab: Tab = { tab_id: this.next_id++, view, mine: false }
    this.tabs.set(tab.tab_id, tab)
    this.host.attach(view)
    view.webContents.setWindowOpenHandler(({ url }) => {
      this.on_new_tab(this.open(url))
      return { action: "deny" }
    })
    view.webContents.on("page-title-updated", this.on_change)
    view.webContents.on("did-navigate", this.on_change)
    view.webContents.on("did-navigate-in-page", this.on_change)
    this.navigate(tab, address)
    return tab
  }

  navigate(tab: Tab, address: string): void {
    tab.mine = false
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
