// Starts the Python brain, keeps it alive and talks to it over localhost HTTP.
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import path from "node:path"
import { wait_for } from "../shared/timing"
import type { BrainEvent, Item, LensKind, PageSource, Proposal, RawRecord, ViewInfo, ViewPage } from "../shared/types"

const START_TIMEOUT_MS = 60_000
const RESTART_DELAY_MS = 1_000

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

  ingest(source_id: string, records: RawRecord[], page_url?: string): Promise<{ items: Item[] }> {
    return this.request("POST", "/ingest", { source_id, records, page_url })
  }

  view_page(view_id: string, exclude_ids: string[]): Promise<ViewPage> {
    return this.request("POST", `/view/${encodeURIComponent(view_id)}`, { exclude_ids })
  }

  events(events: BrainEvent[]): Promise<{ recorded: number }> {
    return this.request("POST", "/events", { events })
  }

  edit(view_id: string, text: string, item_id?: string): Promise<Proposal> {
    return this.request("POST", "/edit", { view_id, text, item_id })
  }

  apply_edit(proposal_id: string): Promise<Proposal> {
    return this.request("POST", "/edit/apply", { proposal_id })
  }

  discard_edit(proposal_id: string): Promise<{ status: string }> {
    return this.request("POST", "/edit/discard", { proposal_id })
  }

  lens(view_id: string, kind: LensKind): Promise<string> {
    return this.request("GET", `/lens/${encodeURIComponent(view_id)}?kind=${kind}`)
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

// The brain child process: spawned with uv, restarted if it exits while the shell is running.
export class BrainProcess {
  readonly client: BrainClient
  private child: ChildProcess | null = null
  private stopping = false

  private constructor(
    private readonly repo_dir: string,
    private readonly port: number,
    private readonly token: string,
  ) {
    this.client = new BrainClient(`http://127.0.0.1:${port}`, token)
  }

  static async start(repo_dir: string): Promise<BrainProcess> {
    const port = Number(process.env.MOI_BRAIN_PORT) || (await free_port())
    const token = process.env.MOI_TOKEN || randomBytes(16).toString("hex")
    const brain = new BrainProcess(repo_dir, port, token)
    brain.spawn()
    await wait_for(() => brain.client.health(), START_TIMEOUT_MS, 200)
    return brain
  }

  private spawn(): void {
    const project = path.join(this.repo_dir, "brain")
    this.child = spawn("uv", ["run", "--project", project, "python", "-m", "moi_brain", "--port", String(this.port)], {
      env: { ...process.env, MOI_TOKEN: this.token },
      stdio: ["ignore", "inherit", "inherit"],
    })
    this.child.on("exit", () => {
      if (!this.stopping) setTimeout(() => this.spawn(), RESTART_DELAY_MS)
    })
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
  }
}
