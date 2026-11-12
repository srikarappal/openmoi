import { afterEach, describe, expect, it, vi } from "vitest"
import type { BrainClient } from "../../src/main/brain"
import { Scheduler } from "../../src/main/scheduler"
import type { ContentWanted, PageSource, ViewSchedule } from "../../src/shared/types"

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
    content_wanted: vi.fn(async (): Promise<ContentWanted[]> => []),
    update_packs: vi.fn(async () => ({ status: "no pack channel" })),
  }
  const hooks = {
    read: vi.fn(read),
    watch: vi.fn(async (_source: PageSource) => {}),
    summarize: vi.fn(async (_wanted: ContentWanted) => {}),
    edition_out: vi.fn(),
    read_done: vi.fn(),
    packs: vi.fn(),
    failed: vi.fn(),
  }
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

describe("Scheduler summaries", () => {
  const FIRST = { item_id: "a1", url: "https://blog.example/1", video: false }
  const SECOND = { item_id: "a2", url: "https://blog.example/2", video: false }

  it("reads wanted items one at a time and never starts a second round while one runs", async () => {
    const held = new HeldRead()
    const { scheduler, brain, hooks } = make_scheduler([[]])
    brain.content_wanted.mockResolvedValue([FIRST, SECOND])
    hooks.summarize.mockImplementationOnce(() => held.run())
    await scheduler.tick()
    await scheduler.tick()
    expect(brain.content_wanted).toHaveBeenCalledTimes(1)
    expect(hooks.summarize).toHaveBeenCalledTimes(1)
    held.release()
    await scheduler.idle()
    expect(hooks.summarize.mock.calls.map((call) => call[0])).toEqual([FIRST, SECOND])
  })

  it("reports summaries that could not be made", async () => {
    const { scheduler, brain, hooks } = make_scheduler([[]])
    brain.content_wanted.mockRejectedValueOnce(new Error("brain restarting"))
    await scheduler.tick()
    await scheduler.idle()
    expect(hooks.failed).toHaveBeenCalledWith("Summaries could not be made: brain restarting")
  })
})

describe("Scheduler after the review", () => {
  const SEVEN = "2026-11-10T07:00:00Z"

  it("announces an edition the Mac slept through only once its late read is done, then shows it again", async () => {
    const late = { view_id: "feed", title: "Feed", edition: SEVEN, next_edition: null, read_for: SEVEN, visit_minutes: null }
    const read = { ...late, read_for: null }
    const { scheduler, hooks, brain } = make_scheduler([[{ ...late, edition: "2026-11-09T18:00:00Z", read_for: null }], [late], [read]])
    await scheduler.tick()
    await scheduler.tick()
    expect(hooks.edition_out).not.toHaveBeenCalled()
    await scheduler.idle()
    expect(brain.schedule_done).toHaveBeenCalledWith("feed", SEVEN)
    expect(hooks.read_done).toHaveBeenCalledWith("feed")
    await scheduler.tick()
    expect(hooks.edition_out).toHaveBeenCalledWith(read)
  })

  it("keeps summarizing while a view named summaries has a read due", async () => {
    const held = new HeldRead()
    const { scheduler, brain, hooks } = make_scheduler([[{ view_id: "summaries", title: "S", edition: null, next_edition: null, read_for: SEVEN, visit_minutes: null }]], held.run.bind(held))
    brain.content_wanted.mockResolvedValue([{ item_id: "a1", url: "https://a.example/1", video: false }])
    await scheduler.tick()
    await vi.waitFor(() => expect(hooks.summarize).toHaveBeenCalledTimes(1))
    held.release()
    await scheduler.idle()
  })
})

describe("Scheduler packs", () => {
  it("asks the pack channel once a day and reports what it found or that it failed", async () => {
    vi.useFakeTimers()
    const { scheduler, brain, hooks } = make_scheduler([[]])
    brain.update_packs.mockResolvedValueOnce({ status: "installed pack v2" }).mockRejectedValueOnce(new Error("brain gone"))
    await scheduler.tick()
    await vi.waitFor(() => expect(hooks.packs).toHaveBeenCalledWith("installed pack v2"))
    await scheduler.tick()
    expect(brain.update_packs).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    await scheduler.tick()
    await vi.waitFor(() => expect(hooks.failed).toHaveBeenCalledWith("The pack channel could not be checked: brain gone"))
  })
})
