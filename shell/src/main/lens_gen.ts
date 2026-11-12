// Builds a new lens when a view's Layout changed: generate (a patch on the live lens), then the static gate, the test
// gate and the visual judge; up to three rounds, each told what failed last, then accept or keep the old lens.
import { gate_problem } from "../shared/lens_gate"
import type { LensKind } from "../shared/types"
import type { Track } from "./activity"
import type { BrainClient } from "./brain"
import { explain } from "./chat"
import type { SmokeTester } from "./smoke"

const ROUNDS = 3

export interface LensGenHooks {
  say(text: string): void
  on_new_lens(view_id: string, kind: LensKind): Promise<void>
  track: Track
}

export function view_label(view_id: string): string {
  return view_id.replace(/^site_/, "")
}

export class LensGenerator {
  private readonly running = new Set<string>()
  private readonly failed = new Set<string>()
  // A layout that changed while a build for the same view and kind was running; it is built next.
  private readonly queued = new Map<string, string>()

  constructor(
    private readonly brain: BrainClient,
    private readonly smoke: SmokeTester,
    private readonly hooks: LensGenHooks,
  ) {}

  // Starts a build unless this exact layout already failed; a changed layout tries again. A layout that changes while
  // a build runs waits for it and is built after, so an edit made just as a look goes live is not lost.
  ensure(view_id: string, kind: LensKind, layout_hash: string): Promise<void> {
    const running_key = `${view_id}:${kind}`
    const layout_key = `${running_key}:${layout_hash}`
    if (this.failed.has(layout_key)) return Promise.resolve()
    if (this.running.has(running_key)) {
      this.queued.set(running_key, layout_hash)
      return Promise.resolve()
    }
    this.running.add(running_key)
    return this.hooks
      .track(`Designing a new look for ${view_label(view_id)}, usually under a minute`, () => this.build(view_id, kind))
      .then((built) => {
        if (!built) this.failed.add(layout_key)
      })
      .catch((error) => {
        this.failed.add(layout_key)
        this.hooks.say(`Could not build a new look for ${view_label(view_id)}: ${explain(error)}`)
      })
      .finally(() => {
        this.running.delete(running_key)
        const next = this.queued.get(running_key)
        this.queued.delete(running_key)
        if (next !== undefined && next !== layout_hash) return this.ensure(view_id, kind, next)
      })
  }

  // The first problem a lens has, from the cheapest check to the dearest: what it says, how it runs, how it looks.
  private async problem(view_id: string, kind: LensKind, html: string): Promise<string | null> {
    const static_problem = gate_problem(html)
    if (static_problem) return static_problem
    const check = await this.smoke.check(html, kind)
    if (check.problem || !check.screenshot) return check.problem
    const verdict = await this.brain.judge_lens(view_id, kind, check.screenshot)
    return verdict.verdict === "differs" ? `it does not look the way the layout asks: ${verdict.problem}` : null
  }

  // True when a lens passed every gate and went live.
  private async build(view_id: string, kind: LensKind): Promise<boolean> {
    const started = Date.now()
    this.hooks.say(`Building a new look for ${view_label(view_id)}.`)
    let last_error: string | undefined
    for (let round = 0; round < ROUNDS; round++) {
      const html = await this.brain.generate_lens(view_id, kind, last_error)
      const problem = await this.problem(view_id, kind, html)
      if (!problem) {
        const version = await this.brain.accept_lens(view_id, kind, html)
        this.hooks.say(`New look for ${view_label(view_id)} is live (version ${version}, ${Math.round((Date.now() - started) / 1000)} s).`)
        await this.hooks
          .on_new_lens(view_id, kind)
          .catch((error) => this.hooks.say(`The new look is saved but could not be shown yet (${explain(error)}); reopen ${view_label(view_id)} to see it.`))
        return true
      }
      last_error = problem
    }
    this.hooks.say(`That look did not work (${last_error}). Keeping the current one.`)
    return false
  }
}
