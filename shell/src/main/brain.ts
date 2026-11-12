// Starts the Python brain, keeps it alive and talks to it over localhost HTTP.
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import path from "node:path"
import { wait_for } from "../shared/timing"
import type {
  BrainEvent,
  EditScope,
  ExtractorSpec,
  IngestResult,
  Item,
  LensKind,
  ModelChange,
  ModelInfo,
  Overview,
  PageSource,
  Proposal,
  RawRecord,
  RelayPoll,
  ViewInfo,
  ViewPage,
  ViewSchedule,
  Mirror,
  MomentKind,
  WatchReport,
  ContentWanted,
  HealthVerdict,
  RunReport,
  SearchHit,
  CollectionInfo,
  Answer,
  ShopStart,
  ActionDecision,
  AgentKind,
  AgentRun,
  LensVerdict,
} from "../shared/types"

const START_TIMEOUT_MS = 60_000
const RESTART_DELAY_MS = 1_000
const MAX_RESTART_DELAY_MS = 30_000
// A brain that ran this long before exiting was working, so the next restart is quick again.
const STABLE_MS = 30_000

export class BrainError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
  ) {
    super(message)
  }
}

export class BrainClient {
  constructor(
    readonly base_url: string,
    private readonly token: string,
  ) {}

  async request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base_url}${route}`, {
      method,
      headers: { "x-moi-token": this.token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const is_json = (response.headers.get("content-type") ?? "").includes("application/json")
    const payload = is_json ? await response.json() : await response.text()
    if (!response.ok) {
      const detail = is_json ? payload : { detail: payload }
      throw new BrainError(response.status, detail.kind ?? "http", String(detail.detail ?? response.statusText))
    }
    return payload as T
  }

  health(): Promise<{ status: string }> {
    return this.request("GET", "/health")
  }

  views(): Promise<ViewInfo[]> {
    return this.request("GET", "/views")
  }

  refresh(view_id: string, force: boolean): Promise<{ page_sources: PageSource[] }> {
    return this.request("POST", "/refresh", { view_id, force })
  }

  // With a view id the brain also ranks the items in page order by that view's rules (a Mine page).
  ingest(source_id: string, records: RawRecord[], page_url?: string, view_id?: string, kind?: LensKind): Promise<IngestResult> {
    return this.request("POST", "/ingest", { source_id, records, page_url, view_id, kind })
  }

  view_page(view_id: string, exclude_ids: string[]): Promise<ViewPage> {
    return this.request("POST", `/view/${encodeURIComponent(view_id)}`, { exclude_ids })
  }

  // notes: items just opened that a note rule covers.
  events(events: BrainEvent[]): Promise<{ recorded: number; notes?: string[] }> {
    return this.request("POST", "/events", { events })
  }

  edit(view_id: string, text: string, item_id?: string, scope: EditScope = "any"): Promise<Proposal> {
    return this.request("POST", "/edit", { view_id, text, item_id, scope })
  }

  create_view(view_id: string, title: string): Promise<ViewInfo> {
    return this.request("POST", "/views", { view_id, title })
  }

  model_info(): Promise<ModelInfo> {
    return this.request("GET", "/model")
  }

  update_model(change: ModelChange): Promise<ModelInfo> {
    return this.request("POST", "/model", change)
  }

  overview(view_id: string): Promise<Overview> {
    return this.request("GET", `/overview/${encodeURIComponent(view_id)}`)
  }

  apply_edit(proposal_id: string): Promise<Proposal> {
    return this.request("POST", "/edit/apply", { proposal_id })
  }

  discard_edit(proposal_id: string): Promise<{ status: string }> {
    return this.request("POST", "/edit/discard", { proposal_id })
  }

  follows(list_url: string, records: RawRecord[]): Promise<{ stored: number }> {
    return this.request("POST", "/follows", { list_url, records })
  }

  import_view(name: string, text: string | null, url: string | null): Promise<Proposal> {
    return this.request("POST", "/import", { name, text, url })
  }

  google_connect(): Promise<{ auth_url: string }> {
    return this.request("POST", "/google/connect")
  }

  google_status(): Promise<{ connected: boolean; status: string; client: boolean }> {
    return this.request("GET", "/google/status")
  }

  update_packs(): Promise<{ status: string }> {
    return this.request("POST", "/packs/update")
  }

  import_history(name: string, text: string): Promise<{ source_id: string; stored: number }> {
    return this.request("POST", "/history", { name, text })
  }

  share_view(view_id: string): Promise<{ path: string }> {
    return this.request("POST", "/share", { view_id })
  }

  content_wanted(): Promise<ContentWanted[]> {
    return this.request("GET", "/content/wanted")
  }

  add_content(item_id: string, purpose: "summary" | "note" | "offline", title: string, text: string, caption_url: string | null): Promise<{ status: string; item?: Item | null }> {
    return this.request("POST", "/content", { item_id, purpose, title, text, caption_url })
  }

  watches_due(): Promise<PageSource[]> {
    return this.request("GET", "/watches/due")
  }

  watch_report(url: string, title: string, text: string): Promise<WatchReport> {
    return this.request("POST", "/watches/report", { url, title, text })
  }

  open_early(view_id: string): Promise<{ status: string }> {
    return this.request("POST", `/view/${encodeURIComponent(view_id)}/early`)
  }

  moment(view_id: string, kind: MomentKind): Promise<{ status: string }> {
    return this.request("POST", "/moments", { view_id, kind })
  }

  plan_agent(kind: AgentKind, request: string): Promise<AgentRun> {
    return this.request("POST", "/agents", { kind, request })
  }

  agent_run(plan_id: string): Promise<AgentRun> {
    return this.request("GET", `/agents/${encodeURIComponent(plan_id)}`)
  }

  agent_step(plan_id: string, step: "approve" | "decline" | "stop"): Promise<AgentRun> {
    return this.request("POST", `/agents/${encodeURIComponent(plan_id)}/${step}`, {})
  }

  answer_agent(plan_id: string, answer: string): Promise<AgentRun> {
    return this.request("POST", `/agents/${encodeURIComponent(plan_id)}/answer`, { answer })
  }

  agents_due(): Promise<string[]> {
    return this.request("GET", "/agents/due")
  }

  pending_actions(): Promise<ActionDecision[]> {
    return this.request("GET", "/actions/pending")
  }

  proposal(proposal_id: string): Promise<Proposal> {
    return this.request("GET", `/proposals/${encodeURIComponent(proposal_id)}`)
  }

  check_action(item_id: string, action: string, text: string, origin: "gesture" | "plan" = "gesture"): Promise<ActionDecision> {
    return this.request("POST", "/actions/check", { item_id, action, text, origin })
  }

  action_result(request_id: string, outcome: "done" | "failed" | "undone" | "declined", detail = ""): Promise<{ recorded: boolean; item: Item | null }> {
    return this.request("POST", "/actions/result", { request_id, outcome, detail })
  }

  shop(query: string, view_id: string): Promise<ShopStart> {
    return this.request("POST", "/shop", { query, view_id })
  }

  ask(question: string): Promise<Answer> {
    return this.request("POST", "/ask", { question })
  }

  save_item(name: string, item_id: string, saved: boolean): Promise<CollectionInfo> {
    return this.request("POST", "/collections", { name, item_id, saved })
  }

  collections(): Promise<CollectionInfo[]> {
    return this.request("GET", "/collections")
  }

  collection_view(name: string): Promise<ViewInfo> {
    return this.request("POST", "/collections/view", { name })
  }

  async export(format: "md" | "json", target: { collection?: string; view_id?: string }): Promise<string> {
    return (await this.request<{ path: string }>("POST", "/export", { format, ...target })).path
  }

  async highlight(item_id: string, quote: string, note: string): Promise<string> {
    return (await this.request<{ line: string }>("POST", "/highlight", { item_id, quote, note })).line
  }

  search(query: string, limit = 20): Promise<SearchHit[]> {
    return this.request("GET", `/search?q=${encodeURIComponent(query)}&limit=${limit}`)
  }

  mirror(days: number): Promise<Mirror> {
    return this.request("GET", `/mirror?days=${days}`)
  }

  weekly_mirror(): Promise<Mirror | null> {
    return this.request("GET", "/mirror/weekly")
  }

  schedule(): Promise<ViewSchedule[]> {
    return this.request("GET", "/schedule")
  }

  schedule_done(view_id: string, edition: string): Promise<{ status: string }> {
    return this.request("POST", "/schedule/done", { view_id, edition })
  }

  lens(view_id: string, kind: LensKind): Promise<string> {
    return this.request("GET", `/lens/${encodeURIComponent(view_id)}?kind=${kind}`)
  }

  // A new lens and the hash of the Layout it was made for.
  generate_lens(view_id: string, kind: LensKind, last_error?: string): Promise<{ html: string; layout_hash: string }> {
    return this.request("POST", "/lens/generate", { view_id, kind, last_error })
  }

  judge_lens(view_id: string, kind: LensKind, screenshot: string): Promise<LensVerdict> {
    return this.request("POST", "/lens/judge", { view_id, kind, screenshot })
  }

  async accept_lens(view_id: string, kind: LensKind, html: string, layout_hash?: string): Promise<number> {
    return (await this.request<{ version: number }>("POST", "/lens/accept", { view_id, kind, html, layout_hash })).version
  }

  previous_extractors(url: string, version: number): Promise<ExtractorSpec[]> {
    return this.request("GET", `/extractor/previous?url=${encodeURIComponent(url)}&version=${version}`)
  }

  report_extractor(report: RunReport): Promise<HealthVerdict> {
    return this.request("POST", "/extractor/health", report)
  }

  async find_extractor(url: string): Promise<ExtractorSpec | null> {
    return (await this.request<{ spec: ExtractorSpec | null }>("GET", `/extractor?url=${encodeURIComponent(url)}`)).spec
  }

  async generate_extractor(url: string, skeleton: string, last_error?: string): Promise<ExtractorSpec> {
    return (await this.request<{ spec: ExtractorSpec }>("POST", "/extractor/generate", { url, skeleton, last_error })).spec
  }

  relay_poll(): Promise<RelayPoll> {
    return this.request("GET", "/relay/poll")
  }

  relay_trust(extension_id: string): Promise<RelayPoll["status"]> {
    return this.request("POST", "/relay/trust", { extension_id })
  }

  // One page operation in your Chrome; the brain forwards it to the extension and waits for the answer.
  async relay_call<T>(op: "open" | "run" | "url" | "close", args: Record<string, unknown>): Promise<T> {
    return (await this.request<{ result: T }>("POST", "/relay/call", { op, args })).result
  }

  async accept_extractor(spec: ExtractorSpec): Promise<ExtractorSpec> {
    return (await this.request<{ spec: ExtractorSpec }>("POST", "/extractor/accept", spec)).spec
  }
}

function free_port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function ignore(): void {}

// The brain child process: spawned with uv, restarted if it exits while the shell is running, waiting longer
// after each quick crash so a brain that cannot start does not spin.
export class BrainProcess {
  readonly client: BrainClient
  private child: ChildProcess | null = null
  private stopping = false
  private restarts = 0
  private started_at = 0
  private fail_start: (error: Error) => void = ignore
  // Rejects when uv itself cannot be started: waiting the full start timeout would not help.
  private readonly spawn_failed = new Promise<never>((_, reject) => {
    this.fail_start = reject
  })

  private constructor(
    private readonly repo_dir: string,
    private readonly port: number,
    private readonly token: string,
  ) {
    this.client = new BrainClient(`http://127.0.0.1:${port}`, token)
    this.spawn_failed.catch(ignore)
  }

  static async start(repo_dir: string): Promise<BrainProcess> {
    const port = Number(process.env.MOI_BRAIN_PORT) || (await free_port())
    const token = process.env.MOI_TOKEN || randomBytes(16).toString("hex")
    const brain = new BrainProcess(repo_dir, port, token)
    brain.spawn()
    await Promise.race([wait_for(() => brain.client.health(), START_TIMEOUT_MS, 200), brain.spawn_failed])
    return brain
  }

  private spawn(): void {
    const project = path.join(this.repo_dir, "brain")
    this.started_at = Date.now()
    this.child = spawn("uv", ["run", "--project", project, "python", "-m", "moi_brain", "--port", String(this.port)], {
      env: { ...process.env, MOI_TOKEN: this.token },
      stdio: ["ignore", "inherit", "inherit"],
    })
    this.child.on("error", (error) => {
      console.error(`openMoi brain: ${error.message}`)
      this.fail_start(new Error(`the brain could not be started with uv (${error.message}); install uv, see the README`))
    })
    this.child.on("exit", () => this.exited())
  }

  // Waits 1, 2, 4 ... up to 30 s between quick crashes; a brain that ran a while restarts after 1 s.
  private exited(): void {
    if (this.stopping) return
    this.restarts = Date.now() - this.started_at > STABLE_MS ? 0 : this.restarts + 1
    const delay = Math.min(RESTART_DELAY_MS * 2 ** Math.max(this.restarts - 1, 0), MAX_RESTART_DELAY_MS)
    setTimeout(() => {
      if (!this.stopping) this.spawn()
    }, delay)
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
  }
}
