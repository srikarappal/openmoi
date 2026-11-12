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

export interface PlayerInfo {
  item_id: string
  title: string
  url: string
}

export interface LensVerdict {
  verdict: "matches" | "differs" | "skipped"
  problem: string
}

export interface SearchHit {
  item: Item
  score: number
}

export interface ViewItem {
  item: Item
  reasons: string[]
  // The value a group_by rule groups this item under; the lens heads each run of one group.
  group?: string | null
  // A summarize_only rule matched: the card shows the summary in place of the item's own text.
  summary_only?: boolean
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
  // How far a source may be scrolled in a day, over all its reads.
  daily_steps?: number
}

export interface PageSource {
  source_id: string
  page_type: string
  start_url: string
  // null until a spec for this page exists; the reader makes one from the page the first time.
  spec: ExtractorSpec | null
  budget: PilotBudget
  // Posts come newest first: reaching what was read before means nothing newer was missed.
  chronological?: boolean
  // "follows": a page listing the accounts you follow, read into who you know rather than into items.
  // "watch": a page whose text is compared with its last look.
  purpose?: "items" | "follows" | "watch"
  // "assist": read only while you browse the page yourself in Chrome, never by a reader tab (the site's policy or its line).
  mode?: "pilot" | "assist"
  // Also read the JSON the page fetches by itself, in openMoi's own session (the site's policy).
  capture?: boolean
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
  // Per source, the share of its items the view's rules let through.
  keep_rate?: Record<string, number>
  // Feeds still being fetched for this view, apart from tagging.
  reading?: boolean
  // A view with editions: when the one on show came out and when the next comes out.
  edition?: string | null
  next_edition?: string | null
}

// A view with a Time section: its editions, a read due now and how long one visit lasts.
export interface ViewSchedule {
  view_id: string
  title: string
  edition: string | null
  next_edition: string | null
  read_for: string | null
  visit_minutes: number | null
}

// What a source showed you lately and what passed your rules, from the brain's mirror.
export interface SourceMirror {
  source_id: string
  listed: number
  kept: number
  seen: number
  opened: number
  strangers: number | null
  judged: Record<string, number>
}

export interface ViewMirror {
  view_id: string
  visits: number
  extended: number
  early: number
}

export interface Mirror {
  days: number
  since: string
  sources: SourceMirror[]
  views: ViewMirror[]
}

export type MomentKind = "visit" | "extended" | "early"

// One answer to "why are you here?": a view, how long a visit lasts and when its next edition comes out.
export interface GateChoice {
  view_id: string
  title: string
  visit_minutes: number | null
  next_edition: string | null
}

// Shown when a visit's time is up, in place of the view.
export interface StopScreen {
  view_id: string
  title: string
  minutes: number
  read: string[]
  next_edition: string | null
}

export interface IngestResult {
  items: Item[]
  // Positions of records the source had stored before.
  already?: number[]
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

// update: items already shown, with new fields (a summary); a lens refreshes them in place and keeps your place.
export interface HostToLens {
  type: "render" | "append" | "update"
  items: ViewItem[]
  cursor: string | null
}

export type LensToHost =
  | { type: "ready" }
  | { type: "open"; item_id: string }
  | { type: "more"; cursor: string }
  | { type: "seen"; item_ids: string[] }
  | { type: "less_like_this"; item_id: string }
  | { type: "play"; item_id: string }

export type PageOp = "info" | "challenge" | "extract" | "scroll" | "skeleton" | "readability" | "text" | "transcript" | "structured"

// What a page says about itself (rung 2): its kind, the items its structured data names and the feeds it offers.
export interface StructuredPage {
  page_type: "video" | "product" | "search" | "profile" | "thread" | "article" | "feed" | "listing"
  records: RawRecord[]
  feeds: Array<{ title: string; url: string }>
}

// One run of a spec for its health check: how many records, how many lacked each field, a few samples.
export interface RunReport {
  domain: string
  path_pattern: string
  version: number
  count: number
  missing: Record<string, number>
  samples: Array<{ title: string; url: string }>
  // The page it ran on: usual counts are kept per page.
  page: string
}

export interface HealthVerdict {
  healthy: boolean
  status: "candidate" | "active" | "failing"
  problem: string
}

// What a video page says about its captions, read by the "transcript" page operation; the brain fetches the captions.
export interface TranscriptSource {
  title: string
  description: string
  caption_url: string | null
}

// An item a summarize rule wants read in full.
export interface ContentWanted {
  item_id: string
  url: string
  video: boolean
}

// What reading an item in full found: its title and text, and for a video where its captions are.
export interface ItemContent {
  title: string
  text: string
  caption_url: string | null
}

// A watched page's text, read by the "text" page operation.
export interface PageText {
  title: string
  text: string
}

// A watched page changed in a way a view's rules keep.
export interface WatchAlert {
  view_id: string
  title: string
  text: string
}

export interface WatchReport {
  changed: boolean
  alert: WatchAlert | null
}

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

export type EditScope = "any" | "memory" | "rules" | "sources" | "layout" | "time" | "view"

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
  // The extension holds a secret from an earlier openMoi: it has to Pair again before Allow can work.
  unrecognized?: string | null
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
  gate: GateChoice[] | null
  stop: StopScreen | null
  player: PlayerInfo | null
}

export type ShellCommand =
  | { type: "open_view"; view_id: string }
  | { type: "open_tab"; url: string }
  | { type: "open_link"; url: string }
  | { type: "close_player" }
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
  | { type: "choose_view"; view_id: string }
  | { type: "extend_visit" }
  | { type: "open_early"; view_id: string }
  | { type: "import_view"; name: string; text: string }
  | { type: "import_history"; name: string; text: string }
  | { type: "end_visit" }
