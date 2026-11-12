// The packaged app (scripts/package.sh builds it): from a fresh home to a first merged Feed within three minutes, its
// brain on the app's own Python and its own Mac helper. Its fuses forbid the debugger Playwright drives Electron with,
// so the app is started as you would start it and checked through its brain. Skipped until a package is built.
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { BrainClient } from "../../src/main/brain"
import type { ViewPage } from "../../src/shared/types"
import { FakeWorld, Harness, SHELL_DIR, TOKEN, eventually } from "./harness"

const PACKAGED = path.join(SHELL_DIR, "release", "mac-arm64", "openMoi.app", "Contents", "MacOS", "openMoi")

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

test("the packaged app goes from a fresh home to a first merged Feed within three minutes", async () => {
  test.skip(!existsSync(PACKAGED), "no package built: run scripts/package.sh")
  test.setTimeout(240_000)
  const root = mkdtempSync(path.join(tmpdir(), "moi_e2e_"))
  const assets = path.join(root, "assets")
  const home = path.join(root, "home")
  Harness.prepare(world, {}, assets, home)
  const socket = path.join(root, "brain.sock")
  const started = Date.now()
  const app = spawn(PACKAGED, [], {
    env: { ...process.env, MOI_HOME: home, MOI_ASSETS_DIR: assets, MOI_YOUTUBE_BASE: world.base_url, MOI_HEADLESS: "1", MOI_BRAIN_SOCKET: socket, MOI_TOKEN: TOKEN, MOI_RELAY_PORT: "0" },
    stdio: "ignore",
  })
  try {
    const brain = new BrainClient(socket, TOKEN)
    const page = await eventually(
      () => brain.view_page("feed", []).catch(() => null),
      (found: ViewPage | null) => {
        const titles = (found?.items ?? []).map((entry) => entry.item.title ?? "")
        return titles.includes("New laptop chip doubles battery life") && titles.includes("Local bakery wins national prize")
      },
      180_000,
    )
    expect(Date.now() - started).toBeLessThan(180_000)
    const sources = new Set(page?.items.map((entry) => entry.item.source_id))
    expect(sources.has("rss:tech") && sources.has("rss:news")).toBe(true)
    const apps = await brain.request<{ status: Record<string, string> }>("GET", "/apps")
    expect(Object.keys(apps.status).sort()).toEqual(["calendar", "files", "mail", "notes"])
  } finally {
    app.kill()
    rmSync(root, { recursive: true, force: true })
  }
})
