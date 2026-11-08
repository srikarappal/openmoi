// Shapes shared by the main process, preloads and the chrome UI. They mirror the brain's pydantic models.

export type ItemKind = "post" | "article" | "video" | "product" | "link"

export interface Item {
  item_id: string
  source_id: string
  native_id: string
  kind: ItemKind
  url: string
  title: string | null
  text: string | null
  author_name: string | null
  author_handle: string | null
  image_url: string | null
  media_kind: string | null
  published_at: string | null
  fetched_at: string
  topics: string[]
  tagged: boolean
  available_actions: string[]
  extra: Record<string, string>
}

export interface ViewItem {
  item: Item
  reasons: string[]
}

export type RawRecord = Record<string, string>

export interface FieldRule {
  select: string
  take: string
  transform?: string | null
  optional?: boolean
  nth?: number
}

export interface ExtractorSpec {
  domain: string
  path_pattern: string
  page_type: string
  version: number
  start_url?: string | null
  item_root: string
  native_id?: FieldRule | null
  fields: Record<string, FieldRule>
  pagination: { kind: "none" | "scroll"; step_px: number }
}

export interface PilotBudget {
  page_loads: number
  scroll_steps: number
  min_step_interval_ms: number
}

export interface PageSource {
  source_id: string
  page_type: string
  start_url: string
  spec: ExtractorSpec
  budget: PilotBudget
}

export interface ViewPage {
  view_id: string
  items: ViewItem[]
  has_more: boolean
  refreshing: boolean
  caught_up: boolean
  summary: string
  warnings: string[]
  version: string
  layout_hash: string
  lens_stale: boolean
}

export interface IngestResult {
  items: Item[]
  view_items: ViewItem[]
  lens_stale: boolean
  layout_hash: string
}

export interface ViewInfo {
  view_id: string
  title: string
}

export type EventKind = "open" | "seen" | "less_like_this"

export interface BrainEvent {
  view_id: string
  item_id: string | null
  event_kind: EventKind
}

export type LensKind = "feed" | "article" | "listing"

export interface HostToLens {
  type: "render" | "append"
  items: ViewItem[]
  cursor: string | null
}

export type LensToHost =
  | { type: "ready" }
  | { type: "open"; item_id: string }
  | { type: "more"; cursor: string }
  | { type: "seen"; item_ids: string[] }
  | { type: "less_like_this"; item_id: string }

export type PageOp = "info" | "challenge" | "extract" | "scroll" | "skeleton" | "readability"

export interface PageRequest {
  request_id: number
  op: PageOp
  args: Record<string, unknown>
}

export interface PageResponse {
  request_id: number
  result?: unknown
  error?: string
}

export interface Change {
  file: string
  diff: string
}

export interface Proposal {
  proposal_id: string
  view_id: string
  changes: Change[]
  lens_action: "rollback" | null
  reply: string
}

export type EditScope = "any" | "memory" | "rules" | "sources" | "layout" | "view"

export interface ModelChange {
  slot?: "fast" | "smart" | "both"
  provider?: "openrouter" | "ollama"
  model?: string
  allow_content_to_hosted?: boolean
}

export interface SlotInfo {
  provider: string
  model: string
  base_url: string
  local: boolean
  key_ready: boolean
}

export interface ModelInfo {
  fast: SlotInfo
  smart: SlotInfo
  allow_content_to_hosted: boolean
}

export interface Overview {
  home: string
  view_id: string
  view_file: string
  sections: Record<string, string>
  memory: Record<string, string>
  model: ModelInfo
  relay: { connected: boolean }
}

export interface ChatEntry {
  entry_id: number
  role: "you" | "moi"
  text: string
  proposal?: Proposal
  status?: "pending" | "applied" | "discarded"
}

export interface TabInfo {
  tab_id: number
  title: string
  url: string
  mine: boolean
}

export type ActiveTarget = { kind: "view"; view_id: string } | { kind: "tab"; tab_id: number } | { kind: "chrome"; page_id: number }

export interface Notice {
  notice_id: number
  text: string
  url?: string
  action?: { label: string; command: ShellCommand }
  // Notices with a tag are withdrawn together once what they asked for has happened.
  tag?: string
}

// A page in your Chrome shown here as Mine.
export interface ChromePageInfo {
  page_id: number
  title: string
  url: string
}

export interface RelayInfo {
  connected: boolean
  waiting_for_approval: string | null
  // An extension was approved before, so Chrome is expected back even while it is not connected.
  paired: boolean
}

export interface MineRequestEvent {
  event: "mine"
  handle: string
  url: string
  title: string
}

export interface RelayPoll {
  status: RelayInfo & { extension_id: string | null; passive_batches: number }
  events: MineRequestEvent[]
}

export interface Activity {
  activity_id: number
  label: string
  started_at: number
}

export interface ShellState {
  views: ViewInfo[]
  tabs: TabInfo[]
  active: ActiveTarget
  address: string
  notices: Notice[]
  chat: ChatEntry[]
  chat_view: string
  thinking: boolean
  activities: Activity[]
  chrome_pages: ChromePageInfo[]
  relay: RelayInfo
}

export type ShellCommand =
  | { type: "open_view"; view_id: string }
  | { type: "open_tab"; url: string }
  | { type: "select_tab"; tab_id: number }
  | { type: "close_tab"; tab_id: number }
  | { type: "navigate"; url: string }
  | { type: "refresh" }
  | { type: "open_notice"; notice_id: number }
  | { type: "dismiss_notice"; notice_id: number }
  | { type: "chat_send"; text: string }
  | { type: "proposal_apply"; proposal_id: string }
  | { type: "proposal_discard"; proposal_id: string }
  | { type: "toggle_mine" }
  | { type: "select_chrome_page"; page_id: number }
  | { type: "close_chrome_page"; page_id: number }
  | { type: "relay_trust"; extension_id: string }
