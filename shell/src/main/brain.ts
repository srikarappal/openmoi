// Starts the Python brain, keeps it alive and talks to it over localhost HTTP.
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { request as http_request } from "node:http"
import { tmpdir } from "node:os"
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
  AppAccess,
  LookupStart,
  PeopleReply,
  ShopStart,
  ActionDecision,
  AgentKind,
  AgentRun,
  LensVerdict,
} from "../shared/types"

const START_TIMEOUT_MS = 60_000
// The host every request names: the brain turns away any other, as it does on a port.
const SOCKET_HOST = "moi.brain"
// A brain that stops answering its health check this many times in a row is stopped, and restarts.
const HEALTH_EVERY_MS = 10_000
const HEALTH_TIMEOUT_MS = 5_000
const HEALTH_MISSES = 3
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

interface RawReply {
  status: number
  type: string
  text: string
}

// One request to the brain over its Unix socket.
function over_socket(socket_path: string, method: string, route: string, headers: Record<string, string>, body: string | undefined, timeout_ms: number): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const outgoing = http_request({ socketPath: socket_path, path: route, method, headers: { ...headers, host: SOCKET_HOST }, timeout: timeout_ms }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, type: String(response.headers["content-type"] ?? ""), text: Buffer.concat(chunks).toString("utf-8") }))
      response.on("error", reject)
    })
    outgoing.on("timeout", () => outgoing.destroy(new Error(`the brain did not answer ${route} in ${timeout_ms / 1000} s`)))
    outgoing.on("error", reject)
    outgoing.end(body)
  })
}

export class BrainClient {
  constructor(
    readonly socket_path: string,
    private readonly token: string,
  ) {}

  async request<T>(method: "GET" | "POST", route: string, body?: unknown, timeout_ms = 0): Promise<T> {
    const reply = await over_socket(this.socket_path, method, route, { "x-moi-token": this.token, "content-type": "application/json" }, body === undefined ? undefined : JSON.stringify(body), timeout_ms)
    const is_json = reply.type.includes("application/json")
    const payload = is_json ? JSON.parse(reply.text) : reply.text
    if (reply.status < 200 || reply.status >= 300) {
      const detail = is_json ? payload : { detail: payload }
      throw new BrainError(reply.status, detail.kind ?? "http", String(detail.detail ?? reply.status))
    }
    return payload as T
  }

  // Answers within a few seconds or fails: a check, not a wait.
  quick_health(): Promise<{ status: string }> {
    return this.request("GET", "/health", undefined, HEALTH_TIMEOUT_MS)
  }

  health(): Promise<{ status: string; boot?: string }> {
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

  view_page(view_id: string, exclude_ids: string[], limit?: number): Promise<ViewPage> {
    return this.request("POST", `/view/${encodeURIComponent(view_id)}`, limit === undefined ? { exclude_ids } : { exclude_ids, limit })
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

  agent_step(plan_id: string, step: "approve" | "decline" | "stop", cloud = false): Promise<AgentRun> {
    return this.request("POST", `/agents/${encodeURIComponent(plan_id)}/${step}`, step === "approve" ? { cloud } : {})
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

  lookup(view_id: string, item_id: string, entity: string): Promise<LookupStart> {
    return this.request("POST", "/lookup", { view_id, item_id, entity })
  }

  apps(): Promise<AppAccess> {
    return this.request("GET", "/apps")
  }

  allow_app(capability: "calendar" | "mail" | "notes" | "files"): Promise<AppAccess> {
    return this.request("POST", "/apps/allow", { capability })
  }

  export_everything(): Promise<{ path: string }> {
    return this.request("POST", "/data/export")
  }

  // The brain marks everything for deleting and ends; the next one deletes it before it starts.
  delete_everything(): Promise<{ status: string }> {
    return this.request("POST", "/data/delete", { confirm: "delete everything" })
  }

  people_suggest(): Promise<PeopleReply> {
    return this.request("POST", "/people/suggest")
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

// A socket in a fresh folder only you can open (mkdtemp makes it 0700), so no other account on the Mac can reach it.
function private_socket(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "moi-")), "brain.sock")
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

  private health_timer: ReturnType<typeof setInterval> | null = null
  private misses = 0

  private constructor(
    private readonly repo_dir: string,
    private readonly socket: string,
    private readonly token: string,
    private readonly owns_folder: boolean,
    private readonly python: string | undefined,
  ) {
    this.client = new BrainClient(socket, token)
    this.spawn_failed.catch(ignore)
  }

  // With a bundled Python (the packaged app) the brain runs on it from repo_dir/brain; otherwise uv runs it.
  static async start(repo_dir: string, python?: string): Promise<BrainProcess> {
    const given = process.env.MOI_BRAIN_SOCKET
    const token = process.env.MOI_TOKEN || randomBytes(16).toString("hex")
    const brain = new BrainProcess(repo_dir, given || private_socket(), token, !given, python)
    brain.spawn()
    try {
      await Promise.race([wait_for(() => brain.client.health(), START_TIMEOUT_MS, 200), brain.spawn_failed])
    } catch (error) {
      brain.stop()
      throw error
    }
    brain.health_timer = setInterval(() => brain.check_health(), HEALTH_EVERY_MS)
    return brain
  }

  // A brain that is running but stops answering (stuck, not crashed) is stopped after a few missed checks; its exit
  // then restarts it like any crash.
  async check_health(): Promise<void> {
    if (this.stopping || !this.child || Date.now() - this.started_at < START_TIMEOUT_MS) return
    try {
      await this.client.quick_health()
      this.misses = 0
    } catch {
      this.misses += 1
      if (this.misses >= HEALTH_MISSES) {
        this.misses = 0
        this.signal("SIGKILL")
      }
    }
  }

  private spawn(): void {
    const project = path.join(this.repo_dir, "brain")
    this.started_at = Date.now()
    const brain_args = ["-m", "moi_brain", "--socket", this.socket]
    // The app's own Python writes no bytecode into the signed bundle and puts nothing but the brain on its path.
    const [command, args, extra] = this.python
      ? [this.python, ["-P", ...brain_args], { PYTHONPATH: project, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" }]
      : ["uv", ["run", "--project", project, "python", ...brain_args], {}]
    // Its own process group, so stopping it stops the Python uv starts as well, not only uv.
    this.child = spawn(command, args, {
      cwd: project,
      detached: true,
      env: { ...process.env, ...extra, MOI_TOKEN: this.token },
      stdio: ["ignore", "inherit", "inherit"],
    })
    this.child.on("error", (error) => {
      console.error(`openMoi brain: ${error.message}`)
      const advice = this.python ? "reinstall openMoi" : "install uv, see the README"
      this.fail_start(new Error(`the brain could not be started with ${this.python ? "its Python" : "uv"} (${error.message}); ${advice}`))
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

  // To the brain's whole process group (uv and the Python it runs); a child without a pid gets it alone.
  private signal(name: NodeJS.Signals): void {
    const pid = this.child?.pid
    try {
      if (pid) process.kill(-pid, name)
      else this.child?.kill(name)
    } catch {
      this.child?.kill(name)
    }
  }

  stop(): void {
    this.stopping = true
    if (this.health_timer) clearInterval(this.health_timer)
    this.signal("SIGTERM")
    if (this.owns_folder) rmSync(path.dirname(this.socket), { recursive: true, force: true })
  }
}
