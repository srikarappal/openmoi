// Builds a new lens when a view's Layout changed: generate, smoke test, one retry with the error, then accept or keep the old one.
import type { LensKind } from "../shared/types"
import type { Track } from "./activity"
import type { BrainClient } from "./brain"
import { explain } from "./chat"
import type { SmokeTester } from "./smoke"

const ATTEMPTS = 2

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

  constructor(
    private readonly brain: BrainClient,
    private readonly smoke: SmokeTester,
    private readonly hooks: LensGenHooks,
  ) {}

  // Starts a build unless one is running or this exact layout already failed; a changed layout tries again.
  ensure(view_id: string, kind: LensKind, layout_hash: string): Promise<void> {
    const running_key = `${view_id}:${kind}`
    const layout_key = `${running_key}:${layout_hash}`
    if (this.running.has(running_key) || this.failed.has(layout_key)) return Promise.resolve()
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
      .finally(() => this.running.delete(running_key))
  }

  // True when a lens passed the smoke test and went live.
  private async build(view_id: string, kind: LensKind): Promise<boolean> {
    const started = Date.now()
    this.hooks.say(`Building a new look for ${view_label(view_id)}.`)
    let last_error: string | undefined
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const html = await this.brain.generate_lens(view_id, kind, last_error)
      const problem = await this.smoke.problem(html, kind)
      if (!problem) {
        const version = await this.brain.accept_lens(view_id, kind, html)
        this.hooks.say(`New look for ${view_label(view_id)} is live (version ${version}, ${Math.round((Date.now() - started) / 1000)} s).`)
        await this.hooks.on_new_lens(view_id, kind)
        return true
      }
      last_error = problem
    }
    this.hooks.say(`That look did not work (${last_error}). Keeping the current one.`)
    return false
  }
}
