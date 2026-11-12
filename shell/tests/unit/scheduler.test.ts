import { afterEach, describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import { Scheduler } from "../../src/main/scheduler"
import type { PageSource, ViewSchedule } from "../../src/shared/types"

const SEVEN = "2026-11-10T07:00:00Z"
const SIX_PM = "2026-11-10T18:00:00Z"

function schedule(fields: Partial<ViewSchedule> = {}): ViewSchedule {
  return { view_id: "feed", title: "Feed", edition: null, next_edition: SEVEN, read_for: null, visit_minutes: null, ...fields }
}

function make_scheduler(answers: Array<ViewSchedule[] | Error>, read: (view_id: string) => Promise<void> = async () => {}) {
  const brain = {
    schedule: vi.fn(async () => {
      const answer = answers.length > 1 ? answers.shift() : answers[0]
      if (answer instanceof Error) throw answer
      return answer ?? []
    }),
    schedule_done: vi.fn(async () => ({ status: "done" })),
    watches_due: vi.fn(async (): Promise<PageSource[]> => []),
  }
  const hooks = { read: vi.fn(read), watch: vi.fn(async (_source: PageSource) => {}), edition_out: vi.fn(), failed: vi.fn() }
  const scheduler = new Scheduler(brain as unknown as BrainClient, hooks, 1_000)
  return { scheduler, brain, hooks }
}

// A read that ends only when the test releases it.
class HeldRead {
  release: () => void = () => {}

  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.release = resolve
    })
  }
}

async function failing_read(): Promise<void> {
  throw new Error("brain gone")
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Scheduler", () => {
  it("runs a due read once and marks the edition read when it ends", async () => {
    const { scheduler, brain, hooks } = make_scheduler([[schedule({ read_for: SEVEN })], [schedule()]])
    await scheduler.tick()
    await scheduler.idle()
    expect(hooks.read).toHaveBeenCalledWith("feed")
    expect(brain.schedule_done).toHaveBeenCalledWith("feed", SEVEN)
    await scheduler.tick()
    expect(hooks.read).toHaveBeenCalledTimes(1)
  })

  it("never starts a second read of a view while one runs", async () => {
    const held = new HeldRead()
    const { scheduler, brain, hooks } = make_scheduler([[schedule({ read_for: SEVEN })]], held.run.bind(held))
    await scheduler.tick()
    await scheduler.tick()
    expect(hooks.read).toHaveBeenCalledTimes(1)
    held.release()
    await scheduler.idle()
    expect(brain.schedule_done).toHaveBeenCalledTimes(1)
  })

  it("marks an edition read even when its read failed, and says so", async () => {
    const { scheduler, brain, hooks } = make_scheduler([[schedule({ read_for: SEVEN })]], failing_read)
    await scheduler.tick()
    await scheduler.idle()
    expect(hooks.failed).toHaveBeenCalledWith("Reading for feed failed: brain gone")
    expect(brain.schedule_done).toHaveBeenCalledWith("feed", SEVEN)
  })

  it("reports an edition it could not mark read", async () => {
    const { scheduler, brain, hooks } = make_scheduler([[schedule({ read_for: SEVEN })]])
    brain.schedule_done.mockRejectedValueOnce(new Error("offline"))
    await scheduler.tick()
    await scheduler.idle()
    expect(hooks.failed).toHaveBeenCalledWith("Could not mark the feed edition read: offline")
  })

  it("survives a schedule it could not read", async () => {
    const { scheduler, hooks } = make_scheduler([new Error("brain restarting"), [schedule()]])
    await scheduler.tick()
    expect(hooks.failed).toHaveBeenCalledWith("The schedule could not be read: brain restarting")
    await scheduler.tick()
    expect(scheduler.schedules).toEqual([schedule()])
  })

  it("announces an edition only when a new one comes out, never the one on show at launch", async () => {
    const { scheduler, hooks } = make_scheduler([[schedule({ edition: SEVEN })], [schedule({ edition: SEVEN })], [schedule({ edition: SIX_PM })], [schedule({ view_id: "tech", edition: SIX_PM })]])
    await scheduler.tick()
    await scheduler.tick()
    expect(hooks.edition_out).not.toHaveBeenCalled()
    await scheduler.tick()
    expect(hooks.edition_out).toHaveBeenCalledWith(schedule({ edition: SIX_PM }))
    await scheduler.tick()
    expect(hooks.edition_out).toHaveBeenCalledTimes(1)
  })

  it("shares one look between ticks that overlap", async () => {
    const { scheduler, brain } = make_scheduler([[schedule()]])
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()])
    expect(brain.schedule).toHaveBeenCalledTimes(1)
  })

  it("looks again on every tick of its clock until stopped", async () => {
    vi.useFakeTimers()
    const { scheduler, brain } = make_scheduler([[schedule()]])
    scheduler.start()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(brain.schedule).toHaveBeenCalledTimes(3)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(brain.schedule).toHaveBeenCalledTimes(4)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(brain.schedule).toHaveBeenCalledTimes(4)
  })
})

describe("Scheduler watched pages", () => {
  const WATCHED = { source_id: "watch:visa.example.gov/slots", start_url: "https://visa.example.gov/slots", purpose: "watch" } as PageSource

  it("looks at each due watched page once at a time", async () => {
    const held = new HeldRead()
    const { scheduler, brain, hooks } = make_scheduler([[]])
    brain.watches_due.mockResolvedValue([WATCHED])
    hooks.watch.mockImplementation(() => held.run())
    await scheduler.tick()
    await scheduler.tick()
    expect(hooks.watch).toHaveBeenCalledTimes(1)
    held.release()
    await scheduler.idle()
    await scheduler.tick()
    expect(hooks.watch).toHaveBeenCalledTimes(2)
  })

  it("reports a look or a due list that failed", async () => {
    const { scheduler, brain, hooks } = make_scheduler([[]])
    brain.watches_due.mockRejectedValueOnce(new Error("brain restarting")).mockResolvedValue([WATCHED])
    hooks.watch.mockRejectedValue(new Error("tab crashed"))
    await scheduler.tick()
    expect(hooks.failed).toHaveBeenCalledWith("Watched pages could not be checked: brain restarting")
    await scheduler.tick()
    await scheduler.idle()
    expect(hooks.failed).toHaveBeenCalledWith("Looking at https://visa.example.gov/slots failed: tab crashed")
  })
})
