// The chat panel: slash commands for each kind of setting, free form for everything else.
// Every change to your .md files is a proposed edit you confirm or discard; /model, /settings and /help answer directly.
import { format_model, format_overview, help_text, parse_chat, type ChatCommand } from "../shared/commands"
import type { ChatEntry, EditScope, Proposal } from "../shared/types"
import { BrainError, type BrainClient } from "./brain"

const MAX_ENTRIES = 60

export interface ChatHooks {
  chat_view(): string
  on_applied(proposal: Proposal): Promise<void>
  view_created(view_id: string): Promise<void>
  open_folder(path: string): void
  changed(): void
}

export function explain(error: unknown): string {
  if (error instanceof BrainError && error.kind === "privacy") {
    return "This needs a model that may see your content. Start Ollama, or allow hosted models with /model privacy on."
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

  // A reaction to an item ("less like this") is always free form, for the view it came from.
  async send(text: string, item_id?: string, view_id = this.hooks.chat_view()): Promise<void> {
    this.add({ role: "you", text })
    this.thinking = true
    this.hooks.changed()
    try {
      await this.run(item_id ? { kind: "edit", scope: "any", text } : parse_chat(text), view_id, item_id)
    } catch (error) {
      this.say(explain(error))
    } finally {
      this.thinking = false
      this.hooks.changed()
    }
  }

  private async run(command: ChatCommand, view_id: string, item_id?: string): Promise<void> {
    switch (command.kind) {
      case "edit":
        return this.propose(view_id, command.text, command.scope, item_id)
      case "new_view":
        return this.new_view(command.view_id, command.title, command.description)
      case "model": {
        const info = command.change ? await this.brain.update_model(command.change) : await this.brain.model_info()
        this.say(`${command.change ? "Models updated.\n" : ""}${format_model(info)}`)
        return
      }
      case "settings": {
        const overview = await this.brain.overview(view_id)
        if (command.open) this.hooks.open_folder(overview.home)
        this.say(command.open ? `Opened ${overview.home}.` : format_overview(overview))
        return
      }
      case "help":
        this.say(help_text())
        return
      case "error":
        this.say(command.message)
        return
    }
  }

  private async propose(view_id: string, text: string, scope: EditScope, item_id?: string): Promise<void> {
    const proposal = await this.brain.edit(view_id, text, item_id, scope)
    if (proposal.changes.length || proposal.lens_action) this.add({ role: "moi", text: proposal.reply || "Here is what I would change.", proposal, status: "pending" })
    else this.say(proposal.reply || "Nothing to change.")
  }

  // A bare name makes an empty view right away; with a description the model drafts the file for you to confirm.
  private async new_view(view_id: string, title: string, description: string): Promise<void> {
    if (description) {
      await this.propose(view_id, description, "view")
      return
    }
    await this.brain.create_view(view_id, title)
    this.say(`Created views/${view_id}.md. Add sources with /sources, then rules with /feed.`)
    await this.hooks.view_created(view_id)
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
