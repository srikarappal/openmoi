import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AgentWatcher } from "../../src/main/agent_watch"
import { BrainError, type BrainClient } from "../../src/main/brain"
import type { AgentRun } from "../../src/shared/types"

function run(fields: Partial<AgentRun> = {}): AgentRun {
  return {
    plan_id: "p1",
    kind: "shop",
    request: "a desk lamp",
    summary: "I will shop",
    steps: [],
    budget: { max_steps: 12, max_seconds: 300, max_cost_usd: 0.25 },
    created_at: "2026-11-12T12:00:00Z",
    expires_at: "2026-11-13T12:00:00Z",
    status: "running",
    reason: "",
    trace: [],
    result: null,
    question: "",
    answer: "",
    action_ids: [],
    proposal_ids: [],
    notices: [],
    cost_usd: 0,
    next_run_at: null,
    runs: 1,
    ...fields,
  }
}

function make(answers: AgentRun[]) {
  const brain = {
    agent_run: vi.fn(async () => answers.shift() ?? run({ status: "done" })),
    agents_due: vi.fn(async () => ["w1"]),
    agent_step: vi.fn(async () => run({ plan_id: "w1", kind: "watch" })),
    proposal: vi.fn(async (proposal_id: string) => ({ proposal_id, view_id: "feed", changes: [], lens_action: null, reply: "" })),
    pending_actions: vi.fn(async () => [{ request_id: "a1", allowed: true, confirm: true }, { request_id: "other", allowed: true, confirm: true }]),
  }
  const hooks = { update: vi.fn(), notify: vi.fn(), offer_proposal: vi.fn(), offer_action: vi.fn(), withdraw_actions: vi.fn() }
  return { watcher: new AgentWatcher(brain as unknown as BrainClient, hooks, 100), brain, hooks }
}

describe("AgentWatcher", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("follows a run, passing on each state, new notices once, its proposals and its actions, until it ends", async () => {
    const { watcher, brain, hooks } = make([
      run({ notices: ["first"] }),
      run({ notices: ["first", "second"], proposal_ids: ["e1"] }),
      run({ status: "done", notices: ["first", "second"], proposal_ids: ["e1"], action_ids: ["a1"] }),
    ])
    watcher.follow("p1")
    watcher.follow("p1")
    await vi.advanceTimersByTimeAsync(350)
    expect(hooks.update).toHaveBeenCalledTimes(3)
    expect(hooks.notify.mock.calls).toEqual([["first"], ["second"]])
    expect(hooks.offer_proposal.mock.calls).toEqual([[expect.objectContaining({ proposal_id: "e1" }), 'An agent proposes this, for "a desk lamp".']])
    expect(hooks.offer_action.mock.calls).toEqual([[expect.objectContaining({ request_id: "a1" })]])
    expect(watcher.watching()).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(brain.agent_run).toHaveBeenCalledTimes(3)
  })

  it("skips a proposal already applied or discarded and withdraws actions no longer waiting", async () => {
    const { watcher, brain, hooks } = make([run({ proposal_ids: ["gone", "e2"], action_ids: ["a1", "a_stopped"] }), run({ status: "stopped", action_ids: ["a1", "a_stopped"] })])
    brain.proposal.mockRejectedValueOnce(new BrainError(400, "bad_input", "No proposal has that id."))
    brain.pending_actions.mockResolvedValueOnce([{ request_id: "a1", allowed: true, confirm: true }] as never).mockResolvedValueOnce([] as never)
    watcher.follow("p1")
    await vi.advanceTimersByTimeAsync(250)
    expect(hooks.offer_proposal.mock.calls.map((call) => call[0].proposal_id)).toEqual(["e2"])
    expect(hooks.withdraw_actions.mock.calls).toEqual([[["a_stopped"]], [["a1", "a_stopped"]]])
    expect(hooks.notify).not.toHaveBeenCalled()
    expect(watcher.watching()).toEqual([])
  })

  it("stops following a run it cannot read and says so", async () => {
    const { watcher, brain, hooks } = make([])
    brain.agent_run.mockRejectedValueOnce(new Error("gone"))
    watcher.follow("p1")
    await vi.advanceTimersByTimeAsync(150)
    expect(hooks.notify).toHaveBeenCalledWith("Could not follow an agent: gone")
    expect(watcher.watching()).toEqual([])
  })

  it("runs standing tasks that are due again and follows them", async () => {
    const { watcher, brain, hooks } = make([])
    await watcher.run_due()
    expect(brain.agent_step).toHaveBeenCalledWith("w1", "approve")
    expect(hooks.update).toHaveBeenCalledWith(expect.objectContaining({ plan_id: "w1" }))
    expect(watcher.watching()).toEqual(["w1"])
  })
})
