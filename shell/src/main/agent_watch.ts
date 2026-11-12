// Follows the agents you approved while they run: their plan card in the chat shows each step as it happens, what
// they tell you becomes a notice, edits they propose wait in the chat and actions they propose wait on the confirm
// sheet. Standing tasks (watch) run again when the brain says they are due.
import type { ActionDecision, AgentRun, Proposal } from "../shared/types"
import { BrainError, type BrainClient } from "./brain"

const POLL_MS = 700
const FINAL = new Set<AgentRun["status"]>(["done", "stopped", "failed", "declined"])

export interface AgentWatchHooks {
  update(run: AgentRun): void
  notify(text: string): void
  offer_proposal(proposal: Proposal, why: string): void
  offer_action(decision: ActionDecision): void
  withdraw_actions(request_ids: string[]): void
}

interface Following {
  timer: ReturnType<typeof setInterval>
  notices: number
  proposals: Set<string>
  busy: boolean
}

export class AgentWatcher {
  private readonly following = new Map<string, Following>()

  constructor(
    private readonly brain: BrainClient,
    private readonly hooks: AgentWatchHooks,
    private readonly poll_ms = POLL_MS,
  ) {}

  follow(plan_id: string): void {
    if (this.following.has(plan_id)) return
    const timer = setInterval(() => this.poll(plan_id), this.poll_ms)
    this.following.set(plan_id, { timer, notices: 0, proposals: new Set(), busy: false })
  }

  watching(): string[] {
    return [...this.following.keys()]
  }

  // Standing tasks due again are run again, and followed.
  async run_due(): Promise<void> {
    for (const plan_id of await this.brain.agents_due()) {
      this.hooks.update(await this.brain.agent_step(plan_id, "approve"))
      this.follow(plan_id)
    }
  }

  async poll(plan_id: string): Promise<void> {
    const following = this.following.get(plan_id)
    if (!following || following.busy) return
    following.busy = true
    try {
      const run = await this.brain.agent_run(plan_id)
      this.hooks.update(run)
      for (const text of run.notices.slice(following.notices)) this.hooks.notify(text)
      following.notices = run.notices.length
      for (const proposal_id of run.proposal_ids.filter((id) => !following.proposals.has(id))) {
        following.proposals.add(proposal_id)
        const proposal = await this.brain.proposal(proposal_id).catch((error) => {
          // One you already applied or discarded is gone; that is no reason to stop following.
          if (error instanceof BrainError && error.status < 500) return null
          throw error
        })
        if (proposal) this.hooks.offer_proposal(proposal, `An agent proposes this, for "${run.request}".`)
      }
      if (run.action_ids.length) {
        const waiting = (await this.brain.pending_actions()).filter((decision) => run.action_ids.includes(decision.request_id))
        for (const decision of waiting) this.hooks.offer_action(decision)
        const still = new Set(waiting.map((decision) => decision.request_id))
        this.hooks.withdraw_actions(run.action_ids.filter((request_id) => !still.has(request_id)))
      }
      if (FINAL.has(run.status)) this.unfollow(plan_id)
    } catch (error) {
      this.hooks.notify(`Could not follow an agent: ${error instanceof Error ? error.message : String(error)}`)
      this.unfollow(plan_id)
    } finally {
      following.busy = false
    }
  }

  private unfollow(plan_id: string): void {
    const following = this.following.get(plan_id)
    if (following) clearInterval(following.timer)
    this.following.delete(plan_id)
  }
}
