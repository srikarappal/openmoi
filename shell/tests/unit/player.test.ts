import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ViewHost } from "../../src/main/host"
import { FakeWebContentsView, reset_electron } from "./fake_electron"

vi.mock("electron", async () => await import("./fake_electron"))

const { Player, embed_url, EMBED_REFERRER } = await import("../../src/main/player")
const { PLAYER_PARTITION } = await import("../../src/main/sessions")

function make_player() {
  const host = { attached: [] as unknown[], detached: [] as unknown[], attach: (view: unknown) => host.attached.push(view), detach: (view: unknown) => host.detached.push(view) }
  const hooks = { open_original: vi.fn(), changed: vi.fn() }
  const player = new Player(host as unknown as ViewHost, hooks, "https://embed.example")
  return { host, hooks, player }
}

const VIDEO = { item_id: "v1", url: "https://www.youtube.com/watch?v=VIDEO00001A", title: "Why the sky is blue", text: null } as never

beforeEach(() => reset_electron())

describe("Player", () => {
  it("plays a YouTube video in a cookieless embed above the lens and closes it", () => {
    const { host, hooks, player } = make_player()
    FakeWebContentsView.created = []
    expect(player.play(VIDEO)).toBe(true)
    const [view] = FakeWebContentsView.created
    expect(view.options.webPreferences).toMatchObject({ partition: PLAYER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true })
    expect(view.webContents.load_options).toEqual([{ httpReferrer: EMBED_REFERRER }])
    expect(view.webContents.loads).toEqual([embed_url("VIDEO00001A", "https://embed.example")])
    expect(view.webContents.loads[0]).toBe("https://embed.example/embed/VIDEO00001A?autoplay=1&rel=0&modestbranding=1")
    expect(host.attached).toEqual([view])
    expect(view.visible).toBe(true)
    expect(player.playing).toEqual({ item_id: "v1", title: "Why the sky is blue", url: "https://www.youtube.com/watch?v=VIDEO00001A" })
    expect(player.front()).toBe(view)
    player.close()
    expect(host.detached).toEqual([view])
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(player.playing).toBeNull()
    player.close()
    expect(hooks.changed).toHaveBeenCalledTimes(2)
  })

  it("keeps the embed on its own site, sends what it opens to where originals open and closes on Escape", () => {
    const { hooks, player } = make_player()
    FakeWebContentsView.created = []
    player.play(VIDEO)
    const contents = FakeWebContentsView.created[0].webContents
    const inside = { preventDefault: vi.fn() }
    contents.emit("will-navigate", inside, "https://embed.example/embed/OTHER000001")
    const outside = { preventDefault: vi.fn() }
    contents.emit("will-navigate", outside, "https://www.youtube.com/watch?v=VIDEO00001A")
    expect(inside.preventDefault).not.toHaveBeenCalled()
    expect(outside.preventDefault).toHaveBeenCalled()
    expect(contents.open_handler?.({ url: "https://www.youtube.com/channel/x" })).toEqual({ action: "deny" })
    expect(hooks.open_original.mock.calls).toEqual([["https://www.youtube.com/watch?v=VIDEO00001A"], ["https://www.youtube.com/channel/x"]])
    const typed = { preventDefault: vi.fn() }
    contents.emit("before-input-event", typed, { type: "keyDown", key: "a" })
    expect(player.playing).not.toBeNull()
    contents.emit("before-input-event", typed, { type: "keyDown", key: "Escape" })
    expect(player.playing).toBeNull()
  })

  it("plays nothing but YouTube videos and replaces one video with the next", () => {
    const { host, player } = make_player()
    FakeWebContentsView.created = []
    expect(player.play({ item_id: "a", url: "https://evil.example/watch?v=VIDEO00001A", title: "x" } as never)).toBe(false)
    expect(FakeWebContentsView.created).toHaveLength(0)
    player.play(VIDEO)
    player.play({ item_id: "v2", url: "https://youtu.be/dQw4w9WgXcQ", title: null, text: "A song" } as never)
    expect(host.detached).toEqual([FakeWebContentsView.created[0]])
    expect(player.playing?.title).toBe("A song")
  })
})
