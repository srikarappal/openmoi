// The chat panel: every request becomes a proposed edit to your .md files that you confirm or discard.
import type { ChatEntry, Proposal } from "../shared/types"
import { BrainError, type BrainClient } from "./brain"

const MAX_ENTRIES = 60

export interface ChatHooks {
  chat_view(): string
  on_applied(proposal: Proposal): Promise<void>
  changed(): void
}

export function explain(error: unknown): string {
  if (error instanceof BrainError && error.kind === "privacy") {
    return "This needs a local model. Start Ollama, or set allow_content_to_hosted in ~/openMoi/.moi/config.json."
  }
  if (error instanceof BrainError && error.kind === "llm") return `The model did not answer: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function ignore(): void {}

export class ChatController {
  private entries: ChatEntry[] = []
  private next_id = 1
  thinking = false

  constructor(
    private readonly brain: BrainClient,
    private readonly hooks: ChatHooks,
  ) {}

  list(): ChatEntry[] {
    return this.entries
  }

  say(text: string): void {
    this.add({ role: "moi", text })
  }

  async send(text: string, item_id?: string, view_id = this.hooks.chat_view()): Promise<void> {
    this.add({ role: "you", text })
    this.thinking = true
    this.hooks.changed()
    try {
      const proposal = await this.brain.edit(view_id, text, item_id)
      if (proposal.changes.length || proposal.lens_action) this.add({ role: "moi", text: proposal.reply || "Here is what I would change.", proposal, status: "pending" })
      else this.say(proposal.reply || "Nothing to change.")
    } catch (error) {
      this.say(explain(error))
    } finally {
      this.thinking = false
      this.hooks.changed()
    }
  }

  async apply(proposal_id: string): Promise<void> {
    const entry = this.pending(proposal_id)
    if (!entry) return
    try {
      const proposal = await this.brain.apply_edit(proposal_id)
      entry.status = "applied"
      this.hooks.changed()
      await this.hooks.on_applied(proposal)
    } catch (error) {
      entry.status = "discarded"
      this.say(explain(error))
    }
  }

  async discard(proposal_id: string): Promise<void> {
    const entry = this.pending(proposal_id)
    if (!entry) return
    entry.status = "discarded"
    this.hooks.changed()
    await this.brain.discard_edit(proposal_id).catch(ignore)
  }

  private pending(proposal_id: string): ChatEntry | undefined {
    return this.entries.find((entry) => entry.proposal?.proposal_id === proposal_id && entry.status === "pending")
  }

  private add(entry: Omit<ChatEntry, "entry_id">): void {
    this.entries = [...this.entries, { entry_id: this.next_id++, ...entry }].slice(-MAX_ENTRIES)
    this.hooks.changed()
  }
}
