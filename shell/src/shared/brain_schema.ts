// Made by `uv run python -m moi_brain.schema_ts` from the brain's models; do not edit by hand.

export interface ActionAnchor {
  select: string
  within: string | null
  active_state: string | null
  changed: string | null
  input: string | null
  submit: string | null
}

export interface ActionDecision {
  request_id: string
  action: string
  label: string
  tier: 0 | 1 | 2 | 3
  allowed: boolean
  confirm: boolean
  undo_seconds: number
  reason: string
  url: string
  title: string
  site: string
  text: string
  anchor: ActionAnchor | null
  origin: "gesture" | "plan"
  plan_id: string | null
}

export interface AgentResult {
  answer: string
  citations: Array<Citation>
  shortlist: Array<ShortlistEntry>
}

export interface AgentRun {
  plan_id: string
  kind: "digest" | "shop" | "research" | "cleanup" | "watch"
  request: string
  summary: string
  steps: Array<PlanStep>
  budget: Budget
  created_at: string
  expires_at: string
  status: "proposed" | "running" | "paused" | "done" | "stopped" | "failed" | "declined"
  reason: string
  trace: Array<TraceEntry>
  result: AgentResult | null
  refs: Array<string>
  question: string
  answer: string
  action_ids: Array<string>
  proposal_ids: Array<string>
  cost_usd: number
  notices: Array<string>
  next_run_at: string | null
  runs: number
  cloud: boolean
}

export interface AppAccess {
  status: Record<string, string>
  message: string
}

export interface Budget {
  max_steps: number
  max_seconds: number
  max_cost_usd: number
}

export interface Change {
  file: string
  old_text: string
  new_text: string
  diff: string
}

export interface Citation {
  number: number
  item_id: string
  title: string
  url: string
}

export interface CollectionInfo {
  name: string
  title: string
  count: number
  views: Array<string>
}

export interface Item {
  item_id: string
  source_id: string
  native_id: string
  kind: "post" | "article" | "video" | "product" | "link"
  url: string
  title: string | null
  text: string | null
  author_name: string | null
  author_handle: string | null
  image_url: string | null
  media_kind: string | null
  published_at: string | null
  fetched_at: string
  topics: Array<string>
  tagged: boolean
  available_actions: Array<string>
  extra: Record<string, string>
}

export interface LookupStart {
  view_id: string
  entity: string
  site: string
}

export interface Mention {
  entity: string
  status: "found" | "possible" | "looking" | "not_found" | "unresolved"
  can_look_up: boolean
}

export interface PeopleReply {
  proposal: Proposal | null
  suggestion: PeopleSuggestion | null
  more: number
}

export interface PeopleSuggestion {
  name: string
  accounts: Array<[string, string]>
  items: number
}

export interface PlanStep {
  tool: "search_store" | "read_item" | "build_view" | "open_source_page" | "propose_action" | "propose_memory_edit" | "notify" | "ask_user"
  args: Record<string, unknown>
  why: string
}

export interface Proposal {
  proposal_id: string
  view_id: string
  changes: Array<Change>
  lens_action: "rollback" | null
  reply: string
}

export interface Related {
  item_id: string
  source_id: string
  title: string
  url: string
  price_text: string
  label: string
}

export interface SearchHit {
  item: Item
  score: number
}

export interface ShopStart {
  view_id: string
  query: string
  created: boolean
}

export interface ShortlistEntry {
  item_id: string
  title: string
  url: string
  why: string
}

export interface TraceEntry {
  step: number
  tool: string
  args: Record<string, unknown>
  ok: boolean
  outcome: string
  seconds: number
}

export interface ViewItem {
  item: Item
  reasons: Array<string>
  related: Array<Related>
  mentions: Array<Mention>
  group: string | null
  summary_only: boolean
  collections: Array<string>
}

export interface ViewPage {
  view_id: string
  items: Array<ViewItem>
  has_more: boolean
  refreshing: boolean
  caught_up: boolean
  summary: string
  warnings: Array<string>
  version: string
  layout_hash: string
  lens_stale: boolean
  keep_rate: Record<string, number>
  reading: boolean
  edition: string | null
  next_edition: string | null
}

export interface ViewSchedule {
  view_id: string
  title: string
  edition: string | null
  next_edition: string | null
  read_for: string | null
  visit_minutes: number | null
}
