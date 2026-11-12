// Launch hardening in the real app: the kill switch, end to end. A pack signed with openMoi's key, fetched from its
// channel on schedule, turns a site off, and the app stops reading it and says why.
import { generateKeyPairSync, sign } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"
import { FakeWorld, Harness, eventually, fixture_view } from "./harness"

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

interface Channel {
  server: Server
  url: string
  // What the channel serves now: nothing yet (404), or a pack and its signature.
  pack: { body: string; signature: string } | null
}

async function pack_channel(): Promise<Channel> {
  const channel: Channel = { server: createServer(), url: "", pack: null }
  channel.server.on("request", (request, response) => {
    if (!channel.pack) return response.writeHead(404).end()
    if (request.url === "/pack.json") return response.writeHead(200, { "content-type": "application/json" }).end(channel.pack.body)
    if (request.url === "/pack.json.sig") return response.writeHead(200).end(channel.pack.signature)
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => channel.server.listen(0, "127.0.0.1", resolve))
  channel.url = `http://127.0.0.1:${(channel.server.address() as AddressInfo).port}/pack.json`
  return channel
}

test("the kill switch: a signed pack turns a site off and openMoi stops reading it", async () => {
  const keys = generateKeyPairSync("ed25519")
  const public_key = Buffer.from(keys.publicKey.export({ format: "jwk" }).x as string, "base64url").toString("base64")
  const channel = await pack_channel()
  const feed = `# Feed\n\n## Sources\n* Page: ${world.base_url}/pages/endless.html\n`
  const harness = await Harness.launch(world, {
    views: { feed },
    assets: { "policy/pack_key.pub": public_key },
    config: { pack_url: channel.url },
    // A minute is half a second here, so the half hourly pack check comes every 15 s.
    env: { MOI_MINUTE_MS: "500" },
  })
  try {
    await eventually(
      () => world.hits("/pages/endless.html"),
      (hits) => hits.length > 0,
      60_000,
    )
    const before = await harness.brain<{ page_sources: Array<{ start_url: string }> }>("/refresh", { view_id: "feed" })
    expect(before.page_sources.map((source) => source.start_url)).toContain(`${world.base_url}/pages/endless.html`)

    const body = JSON.stringify({ pack_version: 2, policy: { policy_version: 2, sites: { "127.0.0.1": { status: "removed" } } } })
    // A pack signed with some other key is refused; the site stays on.
    const stranger = generateKeyPairSync("ed25519")
    channel.pack = { body, signature: sign(null, Buffer.from(body), stranger.privateKey).toString("base64") }
    await expect(harness.chrome.locator(".message.moi", { hasText: "signature does not check out" })).toBeVisible({ timeout: 60_000 })
    channel.pack = { body, signature: sign(null, Buffer.from(body), keys.privateKey).toString("base64") }
    await expect(harness.chrome.locator(".message.moi", { hasText: "Site packs: installed pack v2" })).toBeVisible({ timeout: 60_000 })

    const after = await harness.brain<{ page_sources: Array<{ start_url: string }> }>("/refresh", { view_id: "feed" })
    expect(after.page_sources).toEqual([])
    const page = await harness.brain<{ warnings: string[] }>("/view/feed", {})
    expect(page.warnings).toContain("127.0.0.1 is removed by the site policy, so openMoi does not read it.")
  } finally {
    await harness.close()
    channel.server.close()
  }
})

test("a fresh install shows a first merged Feed well within three minutes", async () => {
  const started = Date.now()
  const harness = await Harness.launch(world)
  try {
    await eventually(
      () => harness.lens_text(),
      (text) => text.includes("New laptop chip") && text.includes("Local bakery wins national prize"),
      180_000,
    )
    expect(Date.now() - started).toBeLessThan(180_000)
  } finally {
    await harness.close()
  }
})

test("your data: /backup saves all of it, /delete everything starts openMoi over keeping only the exports", async () => {
  const feed = fixture_view("feed", world.base_url)
  const extra = `# Extra\n\n## Sources\n* RSS: ${world.base_url}/rss/news.xml\n`
  // The fresh start begins from this template, so it reads the fake world, not the internet.
  const harness = await Harness.launch(world, { views: { feed, extra }, assets: { "templates/views/feed.md": feed } })
  try {
    await eventually(
      () => harness.lens_text(),
      (text) => text.includes("New laptop chip"),
    )
    await harness.chat("/backup")
    await expect(harness.chrome.locator(".message.moi").last()).toContainText("Saved everything you have in openMoi")
    const [backup] = harness.files_in("exports")
    expect(backup).toMatch(/^openmoi_everything_\d{8}_\d{6}\.zip$/)
    await harness.chat("/delete everything")
    await expect(harness.chrome.locator(".message.moi").last()).toContainText("say /delete everything confirm")
    expect(harness.files_in("views").sort()).toEqual(["extra.md", "feed.md"])
    await harness.chat("/delete everything confirm")
    await expect(harness.chrome.locator(".message.moi").last()).toHaveText("Everything is deleted. openMoi starts over from its first views.", { timeout: 90_000 })
    expect(harness.files_in("views")).toEqual(["feed.md"])
    expect(harness.files_in("exports")).toEqual([backup])
    const views = await harness.brain<Array<{ view_id: string }>>("/views")
    expect(views.map((view) => view.view_id)).toEqual(["feed"])
  } finally {
    await harness.close()
  }
})
