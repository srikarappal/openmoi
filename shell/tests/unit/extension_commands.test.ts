import { describe, expect, it, vi } from "vitest"
import { ChromeCommands, type ChromeApi } from "../../src/extension/commands"

interface FakeTab {
  url: string
  status: string
  active: boolean
  windowId: number
}

// Just enough of Chrome's tabs, groups, windows and scripting APIs, recording what openMoi asked for.
class FakeChrome {
  readonly tab_state = new Map<number, FakeTab>()
  readonly injected = new Set<number>()
  readonly calls: string[] = []
  group_fails = false
  never_loads = false
  private next_id = 100

  readonly tabs = {
    create: async ({ url, active }: { url: string; active: boolean }) => {
      const id = this.next_id++
      this.tab_state.set(id, { url, status: "loading", active, windowId: 1 })
      if (!this.never_loads) setTimeout(() => this.finish_loading(id), 20)
      return { id, windowId: 1 }
    },
    get: async (id: number) => {
      const tab = this.tab_state.get(id)
      if (!tab) throw new Error(`No tab with id: ${id}.`)
      return { id, ...tab }
    },
    remove: async (id: number) => {
      this.calls.push(`remove ${id}`)
      this.tab_state.delete(id)
    },
    group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
      if (this.group_fails) throw new Error("groups unavailable")
      this.calls.push(`group ${tabIds.join(",")} into ${groupId ?? "new"}`)
      return groupId ?? 7
    },
  }

  readonly tabGroups = {
    update: async (group_id: number, properties: object) => {
      this.calls.push(`group ${group_id} ${JSON.stringify(properties)}`)
    },
  }

  readonly windows = {
    update: async (window_id: number) => {
      this.calls.push(`focus window ${window_id}`)
    },
  }

  readonly scripting = {
    executeScript: async ({ target, func, files, args }: { target: { tabId: number }; func?: { name: string }; files?: string[]; args?: unknown[] }) => {
      if (!this.tab_state.has(target.tabId)) throw new Error(`No tab with id: ${target.tabId}`)
      if (files) {
        this.injected.add(target.tabId)
        this.calls.push(`inject ${files.join(",")} into ${target.tabId}`)
        return [{}]
      }
      if (func?.name === "has_page_ops") return [{ result: this.injected.has(target.tabId) }]
      return [{ result: { ran: args?.[0], with: args?.[1] } }]
    },
  }

  add_user_tab(url: string): number {
    const id = this.next_id++
    this.tab_state.set(id, { url, status: "complete", active: true, windowId: 1 })
    return id
  }

  private finish_loading(id: number): void {
    const tab = this.tab_state.get(id)
    if (tab) tab.status = "complete"
  }
}

function make_commands() {
  const fake = new FakeChrome()
  return { fake, commands: new ChromeCommands(fake as unknown as ChromeApi) }
}

describe("ChromeCommands", () => {
  it("opens background reads quietly in a collapsed openMoi group and waits for the load", async () => {
    const { fake, commands } = make_commands()
    const { handle } = await commands.open({ url: "https://x.com/home", background: true })
    expect(fake.tab_state.get(Number(handle))).toMatchObject({ url: "https://x.com/home", status: "complete", active: false })
    expect(fake.calls).toEqual([`group ${handle} into new`, 'group 7 {"title":"openMoi","collapsed":true}'])
    await commands.open({ url: "https://x.com/home", background: true })
    expect(fake.calls.at(-1)).toMatch(/into 7$/)
    expect(commands.opened.size).toBe(2)
  })

  it("opens originals in front of you and focuses the window", async () => {
    const { fake, commands } = make_commands()
    const { handle } = await commands.open({ url: "https://news.example.com/story", background: false })
    expect(fake.tab_state.get(Number(handle))).toMatchObject({ active: true, status: "loading" })
    expect(fake.calls).toEqual(["focus window 1"])
    expect(commands.opened.has(Number(handle))).toBe(false)
  })

  it("closes a background tab that never finishes loading instead of leaving it in your Chrome", async () => {
    vi.useFakeTimers()
    try {
      const { fake, commands } = make_commands()
      fake.never_loads = true
      const opening = commands.open({ url: "https://slow.example.com", background: true })
      const failed = expect(opening).rejects.toThrow("the page did not finish loading")
      await vi.advanceTimersByTimeAsync(21_000)
      await failed
      expect(fake.tab_state.size).toBe(0)
      expect(fake.calls.at(-1)).toBe("remove 100")
      expect(commands.opened.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("still reads when tab groups are unavailable", async () => {
    const { fake, commands } = make_commands()
    fake.group_fails = true
    const { handle } = await commands.open({ url: "https://x.com/home" })
    expect(fake.tab_state.get(Number(handle))?.status).toBe("complete")
  })

  it("injects the page operations once, then runs them", async () => {
    const { fake, commands } = make_commands()
    const tab_id = fake.add_user_tab("https://news.ycombinator.com/")
    commands.chosen.add(tab_id)
    expect(await commands.run_command("run", { handle: String(tab_id), op: "extract", args: { spec: 1 } })).toEqual({ ran: "extract", with: { spec: 1 } })
    await commands.run_command("run", { handle: String(tab_id), op: "skeleton" })
    expect(fake.calls.filter((call) => call.startsWith("inject"))).toEqual([`inject content.js into ${tab_id}`])
  })

  it("closes only tabs openMoi opened, never yours", async () => {
    const { fake, commands } = make_commands()
    const yours = fake.add_user_tab("https://mail.example.com/")
    const { handle } = await commands.open({ url: "https://x.com/home" })
    await commands.run_command("close", { handle: String(yours) })
    await commands.run_command("close", { handle })
    expect(fake.tab_state.has(yours)).toBe(true)
    expect(fake.tab_state.has(Number(handle))).toBe(false)
    expect(fake.calls.filter((call) => call.startsWith("remove"))).toEqual([`remove ${handle}`])
  })

  it("reports a tab's url and rejects bad handles and unknown operations", async () => {
    const { fake, commands } = make_commands()
    const tab_id = fake.add_user_tab("https://shop.example.com/s?k=lamp")
    commands.chosen.add(tab_id)
    expect(await commands.run_command("url", { handle: String(tab_id) })).toBe("https://shop.example.com/s?k=lamp")
    await expect(commands.run_command("url", { handle: "not a tab" })).rejects.toThrow("bad tab handle")
    commands.chosen.add(999)
    await expect(commands.run_command("run", { handle: "999", op: "info" })).rejects.toThrow("No tab with id")
    await expect(commands.run_command("delete_history", {})).rejects.toThrow("unknown relay op delete_history")
  })

  it("never reads or reports a tab of yours you did not choose with Mine", async () => {
    const { fake, commands } = make_commands()
    const mail = fake.add_user_tab("https://mail.example.com/inbox")
    await expect(commands.run_command("run", { handle: String(mail), op: "extract", args: {} })).rejects.toThrow(`tab ${mail} is not one openMoi opened or you chose with Mine`)
    await expect(commands.run_command("url", { handle: String(mail) })).rejects.toThrow("is not one openMoi opened")
    expect(fake.calls.filter((call) => call.startsWith("inject"))).toEqual([])
    commands.chosen.add(mail)
    commands.forget(mail)
    await expect(commands.run_command("url", { handle: String(mail) })).rejects.toThrow("is not one openMoi opened")
  })

  it("keeps its tabs across a service worker restart and lets go of a chosen tab when its Mine page closes", async () => {
    const saved: Array<{ opened: number[]; chosen: number[] }> = []
    const memory = { load: async () => saved.at(-1) ?? {}, save: async (tabs: { opened: number[]; chosen: number[] }) => void saved.push(tabs) }
    const fake = new FakeChrome()
    const first = new ChromeCommands(fake as unknown as ChromeApi, memory)
    const { handle } = await first.open({ url: "https://x.com/home", background: true })
    const yours = fake.add_user_tab("https://shop.example.com/")
    first.choose(yours)
    const restarted = new ChromeCommands(fake as unknown as ChromeApi, memory)
    await restarted.restore()
    expect([...restarted.opened, ...restarted.chosen]).toEqual([Number(handle), yours])
    await restarted.close(String(yours))
    expect(fake.tab_state.has(yours)).toBe(true)
    expect(restarted.chosen.has(yours)).toBe(false)
    await restarted.close(handle)
    expect(saved.at(-1)).toEqual({ opened: [], chosen: [] })
  })

  it("closes the tabs it opened when openMoi is gone and only lets go of yours", async () => {
    const { fake, commands } = make_commands()
    const { handle } = await commands.open({ url: "https://x.com/home", background: true })
    const yours = fake.add_user_tab("https://mail.example.com/")
    commands.choose(yours)
    await commands.close_opened()
    expect(fake.tab_state.has(Number(handle))).toBe(false)
    expect(fake.tab_state.has(yours)).toBe(true)
    expect([commands.opened.size, commands.chosen.size]).toEqual([0, 0])
  })
})

