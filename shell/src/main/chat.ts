// The chat panel: slash commands for each kind of setting, free form for everything else.
// Every change to your .md files is a proposed edit you confirm or discard; /model, /settings and /help answer directly.
import { format_answer, format_collections, format_mirror, format_model, format_overview, format_search, help_text, parse_chat, type ChatCommand } from "../shared/commands"
import type { AgentRun, ChatEntry, EditScope, Proposal } from "../shared/types"
import type { Track } from "./activity"
import { sleep } from "../shared/timing"
import { BrainError, type BrainClient } from "./brain"

const MAX_ENTRIES = 60

export interface ChatHooks {
  chat_view(): string
  on_applied(proposal: Proposal): Promise<void>
  view_created(view_id: string): Promise<void>
  // A view was given something to shop for: show it, made just now or not, and read its stores.
  shopping(view_id: string, created: boolean): Promise<void>
  model_changed(): void
  // macOS let openMoi read an app: the view you are on reads again.
  app_allowed(): Promise<void>
  open_folder(path: string): void
  // Turns reading in the background on or off; the reply says what that means.
  set_background(on: boolean): string
  show_file(path: string): void
  // Opens an address in your system browser (Google's sign in never runs inside openMoi).
  open_external(url: string): void
  track: Track
  changed(): void
}

interface EditRequest {
  view_id: string
  text: string
  scope: EditScope
  item_id?: string
}

const ASKING = "Asking the model about your request"
const GOOGLE_POLL_MS = 2_000
const GOOGLE_POLLS = 150

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
  private readonly requests = new Map<string, EditRequest>()
  private readonly applying = new Set<string>()
  private working_count = 0

  constructor(
    private readonly brain: BrainClient,
    private readonly hooks: ChatHooks,
  ) {}

  list(): ChatEntry[] {
    return this.entries
  }

  // True while any request is still with the model, not only the last one sent.
  get thinking(): boolean {
    return this.working_count > 0
  }

  say(text: string): void {
    this.add({ role: "moi", text })
  }

  // A reaction to an item ("less like this") is always free form, for the view it came from.
  async send(text: string, item_id?: string, view_id = this.hooks.chat_view()): Promise<void> {
    this.add({ role: "you", text })
    const command: ChatCommand = item_id ? { kind: "edit", scope: "any", text } : parse_chat(text)
    await this.working(() => this.run(command, view_id, item_id))
  }

  private async working(work: () => Promise<void>): Promise<void> {
    this.working_count += 1
    this.hooks.changed()
    try {
      await work()
    } catch (error) {
      this.say(explain(error))
    } finally {
      this.working_count -= 1
      this.hooks.changed()
    }
  }

  private async run(command: ChatCommand, view_id: string, item_id?: string): Promise<void> {
    switch (command.kind) {
      case "edit":
        return this.propose({ view_id, text: command.text, scope: command.scope, item_id })
      case "new_view":
        return this.new_view(command.view_id, command.title, command.description)
      case "model": {
        const info = command.change ? await this.brain.update_model(command.change) : await this.brain.model_info()
        this.say(`${command.change ? "Models updated.\n" : ""}${format_model(info)}`)
        if (command.change) this.hooks.model_changed()
        return
      }
      case "settings": {
        const overview = await this.brain.overview(view_id)
        if (command.open) this.hooks.open_folder(overview.home)
        this.say(command.open ? `Opened ${overview.home}.` : format_overview(overview))
        return
      }
      case "background":
        this.say(this.hooks.set_background(command.on))
        return
      case "mirror":
        this.say(format_mirror(await this.brain.mirror(command.days)))
        return
      case "search":
        this.say(format_search(command.query, await this.brain.search(command.query)))
        return
      case "agent": {
        const run = await this.hooks.track("Planning it", () => this.brain.plan_agent(command.agent, command.request))
        this.add({ role: "moi", text: `Here is the plan. ${run.reason ? `(${run.reason}.) ` : ""}Approve it and I will run it.`, plan: run })
        return
      }
      case "shop": {
        const started = await this.brain.shop(command.query, view_id)
        this.say(`Looking for "${started.query}" in ${started.view_id}${started.created ? ", a new Shop view (its stores are in views/shop.md)" : ""}.`)
        await this.hooks.shopping(started.view_id, started.created)
        return
      }
      case "ask":
        this.say(format_answer(await this.hooks.track("Looking through what you read", () => this.brain.ask(command.question))))
        return
      case "collections":
        this.say(format_collections(await this.brain.collections()))
        return
      case "export": {
        const path = await this.brain.export(command.format, command.collection ? { collection: command.collection } : { view_id })
        this.hooks.show_file(path)
        this.say(`Saved ${command.collection ?? view_id} as ${path}.`)
        return
      }
      case "import":
        return this.offer_import(await this.hooks.track("Reading the shared view", () => this.brain.import_view("", null, command.url)))
      case "google":
        return command.connect ? this.connect_google() : this.google_status()
      case "share": {
        const { path } = await this.brain.share_view(view_id)
        this.hooks.show_file(path)
        this.say(`Saved a copy of ${view_id} to send: ${path}. People, following lists and watched pages are left out.`)
        return
      }
      case "allow": {
        if (!command.capability) {
          const access = await this.brain.apps()
          const lines = Object.entries(access.status).map(([app, status]) => `${app}: ${status.replaceAll("_", " ")}`)
          this.say(lines.length ? `What openMoi may read on this Mac: ${lines.join(", ")}. Say /allow calendar, mail or notes to ask for one.` : `Apps on this Mac are out of reach: ${access.message}`)
          return
        }
        const capability = command.capability
        const access = await this.hooks.track(`Asking macOS about ${capability}`, () => this.brain.allow_app(capability))
        this.say(access.message)
        if (access.status[capability] === "allowed") await this.hooks.app_allowed()
        return
      }
      case "people": {
        const found = await this.brain.people_suggest()
        if (!found.proposal) {
          this.say("No accounts look like one person yet: openMoi suggests a link when one full name posts on two sites.")
          return
        }
        const more = found.more ? ` (${found.more} more: say /people again after this one.)` : ""
        this.add({ role: "moi", text: `${found.proposal.reply}${more}`, proposal: found.proposal, status: "pending" })
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

  private async propose(request: EditRequest): Promise<void> {
    const proposal = await this.hooks.track(ASKING, () => this.brain.edit(request.view_id, request.text, request.item_id, request.scope))
    if (!proposal.changes.length && !proposal.lens_action) {
      this.say(proposal.reply || "Nothing to change.")
      return
    }
    this.requests.set(proposal.proposal_id, request)
    this.add({ role: "moi", text: proposal.reply || "Here is what I would change.", proposal, status: "pending" })
  }

  // A bare name makes an empty view right away; with a description the model drafts the file for you to confirm.
  // A view file you dropped here: it becomes a proposal for a new view, like any edit you confirm.
  async import_file(name: string, text: string): Promise<void> {
    this.add({ role: "you", text: `Import ${name}` })
    await this.working(async () => this.offer_import(await this.brain.import_view(name, text, null)))
  }

  // A data export you dropped (Facebook posts or events, Amazon orders): stored as your history, which a view lists.
  async import_history(name: string, text: string): Promise<void> {
    this.add({ role: "you", text: `Import ${name}` })
    await this.working(async () => {
      const { source_id, stored } = await this.hooks.track(`Reading ${name}`, () => this.brain.import_history(name, text))
      const history = source_id.replace(/^history:/, "")
      this.say(`Your ${history} history now holds ${stored} items. Add "History: ${history}" to a view's Sources to see them.`)
    })
  }

  private async google_status(): Promise<void> {
    const status = await this.brain.google_status()
    if (!status.client) this.say("Google is not set up: add GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET) from a Google desktop OAuth client to openMoi's .env.")
    else this.say(status.connected ? "Google is connected: YouTube subscriptions come from your account." : `Google is ${status.status}. Use /google connect.`)
  }

  // Google's sign in opens in your browser; openMoi waits for it to come back for up to five minutes.
  private async connect_google(): Promise<void> {
    const { auth_url } = await this.brain.google_connect()
    this.hooks.open_external(auth_url)
    this.say("Sign in to Google in your browser; openMoi waits for it here.")
    const status = await this.hooks.track("Waiting for Google", () => this.google_finished())
    this.say(status.connected ? "Google is connected: YouTube subscriptions now come from your account." : `Google did not connect: ${status.status}.`)
  }

  private async google_finished(): Promise<{ connected: boolean; status: string }> {
    for (let attempt = 0; attempt < GOOGLE_POLLS; attempt++) {
      // This sign in's own outcome, not an older token: "connected" or "not connected: why" once it finished.
      const status = await this.brain.google_status()
      if (status.status === "connected" || status.status.startsWith("not connected:")) return status
      await sleep(GOOGLE_POLL_MS)
    }
    return { connected: false, status: "no answer from the browser in five minutes" }
  }

  private offer_import(proposal: Proposal): void {
    this.add({ role: "moi", text: `Add ${proposal.reply}`, proposal, status: "pending" })
  }

  private async new_view(view_id: string, title: string, description: string): Promise<void> {
    if (description) {
      await this.propose({ view_id, text: description, scope: "view" })
      return
    }
    await this.brain.create_view(view_id, title)
    this.say(`Created views/${view_id}.md. Add sources with /sources, then rules with /feed.`)
    await this.hooks.view_created(view_id)
  }

  // A proposal made before another one was applied is stale; it is asked again on top of the current file instead of failing.
  // A second click while the first is applying does nothing, and a problem after the files were written does not undo "applied".
  async apply(proposal_id: string): Promise<void> {
    const entry = this.pending(proposal_id)
    if (!entry || this.applying.has(proposal_id)) return
    const request = this.requests.get(proposal_id)
    this.applying.add(proposal_id)
    let proposal: Proposal
    try {
      proposal = await this.brain.apply_edit(proposal_id)
    } catch (error) {
      entry.status = "discarded"
      if (error instanceof BrainError && error.kind === "stale" && request) {
        this.say("The file changed after this was proposed, so I asked again on top of the current version.")
        await this.working(() => this.propose(request))
      } else {
        this.say(explain(error))
      }
      return
    } finally {
      this.applying.delete(proposal_id)
      this.requests.delete(proposal_id)
    }
    entry.status = "applied"
    this.hooks.changed()
    await this.hooks.on_applied(proposal).catch((error) => this.say(`Saved, but the view could not update: ${explain(error)}`))
  }

  async discard(proposal_id: string): Promise<void> {
    const entry = this.pending(proposal_id)
    if (!entry) return
    entry.status = "discarded"
    this.requests.delete(proposal_id)
    this.hooks.changed()
    await this.brain.discard_edit(proposal_id).catch(ignore)
  }

  // A run's latest state shows in the chat entry of its plan.
  update_plan(run: AgentRun): void {
    const entry = this.entries.find((each) => each.plan?.plan_id === run.plan_id)
    if (!entry) return
    entry.plan = run
    this.hooks.changed()
  }

  // An edit an agent proposed, for you to confirm or discard like any other.
  offer_proposal(proposal: Proposal, why: string): void {
    this.add({ role: "moi", text: why, proposal, status: "pending" })
  }

  private pending(proposal_id: string): ChatEntry | undefined {
    return this.entries.find((entry) => entry.proposal?.proposal_id === proposal_id && entry.status === "pending")
  }

  // Proposals that scroll out of the chat can no longer be confirmed, so their requests go too.
  private add(entry: Omit<ChatEntry, "entry_id">): void {
    this.entries = [...this.entries, { entry_id: this.next_id++, ...entry }].slice(-MAX_ENTRIES)
    const shown = new Set(this.entries.map((each) => each.proposal?.proposal_id))
    for (const proposal_id of this.requests.keys()) if (!shown.has(proposal_id)) this.requests.delete(proposal_id)
    this.hooks.changed()
  }
}
