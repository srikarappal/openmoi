import { describe, expect, it, vi } from "vitest"
import { ActivityTracker } from "../../src/main/activity"

describe("ActivityTracker", () => {
  it("shows a task while it runs and drops it when it ends, even when it fails", async () => {
    const changed = vi.fn()
    const tracker = new ActivityTracker(changed)
    let finish: (value: string) => void = () => {}
    const running = tracker.track("Designing a new look for feed", () => new Promise<string>((resolve) => (finish = resolve)))
    expect(tracker.list().map((activity) => activity.label)).toEqual(["Designing a new look for feed"])
    expect(tracker.list()[0].started_at).toBeLessThanOrEqual(Date.now())
    const failing = tracker.track("Reading x", async () => Promise.reject(new Error("tab closed")))
    await expect(failing).rejects.toThrow("tab closed")
    expect(tracker.list()).toHaveLength(1)
    finish("done")
    expect(await running).toBe("done")
    expect(tracker.list()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(4)
  })
})
