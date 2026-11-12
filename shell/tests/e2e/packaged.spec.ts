// The packaged app (scripts/package.sh builds it): from a fresh home to a first merged Feed within three minutes, its
// brain on the app's own Python and its own Mac helper. Skipped until a package is built.
import { existsSync } from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { FakeWorld, Harness, SHELL_DIR, eventually } from "./harness"

const PACKAGED = path.join(SHELL_DIR, "release", "mac-arm64", "openMoi.app", "Contents", "MacOS", "openMoi")

let world: FakeWorld

test.beforeAll(async () => {
  world = await FakeWorld.start()
})

test.afterAll(() => world.stop())

test("the packaged app goes from a fresh home to a first merged Feed within three minutes", async () => {
  test.skip(!existsSync(PACKAGED), "no package built: run scripts/package.sh")
  const started = Date.now()
  const harness = await Harness.launch(world, { executable: PACKAGED })
  try {
    await eventually(
      () => harness.lens_text(),
      (text) => text.includes("New laptop chip") && text.includes("Local bakery wins national prize"),
      180_000,
    )
    expect(Date.now() - started).toBeLessThan(180_000)
    const apps = await harness.brain<{ status: Record<string, string> }>("/apps")
    expect(Object.keys(apps.status).sort()).toEqual(["calendar", "files", "mail", "notes"])
  } finally {
    await harness.close()
  }
})
