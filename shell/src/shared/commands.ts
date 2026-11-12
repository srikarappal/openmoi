// Chat commands: "/memory", "/feed", "/sources", "/layout", "/settings", "/newview", "/model", "/help".
// Anything without a slash stays free form and openMoi works out from context what to change.
import type { AgentKind, Answer, CollectionInfo, EditScope, Mirror, ModelChange, ModelInfo, Overview, SearchHit, SlotInfo, SourceMirror, ViewMirror } from "./types"

export interface CommandHelp {
  name: string
  usage: string
  summary: string
}

export const COMMANDS: CommandHelp[] = [
  { name: "/feed", usage: "/feed <what this view should show>", summary: "rules: hide, boost or limit items in this view" },
  { name: "/sources", usage: "/sources <what to read>", summary: "add or remove sources of this view" },
  { name: "/layout", usage: "/layout <how it should look>", summary: "change the look; builds a new tested lens" },
  { name: "/time", usage: "/time <when this view comes out>", summary: "editions and how long a visit lasts" },
  { name: "/memory", usage: "/memory <what to remember or forget>", summary: "facts, likes, dislikes and people, for every view" },
  { name: "/newview", usage: "/newview <name> [what it should be]", summary: "create views/<name>.md as a new tab" },
  { name: "/model", usage: "/model [fast|smart|both] [ollama|openrouter] <model>  or  /model privacy on|off", summary: "show or change models and the privacy switch" },
  { name: "/settings", usage: "/settings [open]", summary: "show this view's settings, memory and models; open the folder" },
  { name: "/background", usage: "/background on|off", summary: "keep reading on schedule with the window closed, and start at login" },
  { name: "/mirror", usage: "/mirror [days]", summary: "what each source showed you and how much passed your rules" },
  { name: "/search", usage: "/search <words>", summary: "find items you were shown, by their words and by meaning" },
  { name: "/ask", usage: "/ask <question>", summary: "answer a question from what you read, with links to where it came from" },
  { name: "/agent", usage: "/agent digest|shop|research|cleanup|watch <task>", summary: "a task done for you: planned first, run once you approve" },
  { name: "/shop", usage: "/shop <what you want>", summary: "search your stores, ranked your way, with the lowest prices you have seen" },
  { name: "/collections", usage: "/collections", summary: "your Read later, Watch later and other lists, with how many items each" },
  { name: "/export", usage: "/export [md|json] [collection]", summary: "save this view, or a collection, as a Markdown or JSON file" },
  { name: "/import", usage: "/import <https link to a view file>", summary: "add a view someone shared; or drop its .md file here" },
  { name: "/share", usage: "/share", summary: "save a copy of this view to send, without your people" },
  { name: "/people", usage: "/people", summary: "accounts on different sites that look like one person, to link in people.md" },
  { name: "/allow", usage: "/allow [calendar|mail|notes|files]", summary: "let openMoi read one app on this Mac (macOS asks you), or see what it may read" },
  { name: "/google", usage: "/google [connect]", summary: "sign in to Google in your browser so YouTube subscriptions come from your account" },
  { name: "/help", usage: "/help", summary: "list the commands" },
]

const SCOPES: Record<string, EditScope> = { "/memory": "memory", "/feed": "rules", "/sources": "sources", "/layout": "layout", "/time": "time" }
const VIEW_NAME = /^[a-z0-9_]{1,40}$/i
const SLOTS = new Set(["fast", "smart", "both"])
const PROVIDERS = new Set(["ollama", "openrouter"])

export type ChatCommand =
  | { kind: "edit"; scope: EditScope; text: string }
  | { kind: "new_view"; view_id: string; title: string; description: string }
  | { kind: "model"; change: ModelChange | null }
  | { kind: "settings"; open: boolean }
  | { kind: "background"; on: boolean }
  | { kind: "mirror"; days: number }
  | { kind: "search"; query: string }
  | { kind: "ask"; question: string }
  | { kind: "shop"; query: string }
  | { kind: "agent"; agent: AgentKind; request: string }
  | { kind: "collections" }
  | { kind: "export"; format: "md" | "json"; collection: string | null }
  | { kind: "import"; url: string }
  | { kind: "share" }
  | { kind: "people" }
  | { kind: "allow"; capability: AppCapability | null }
  | { kind: "google"; connect: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string }

export type AppCapability = "calendar" | "mail" | "notes" | "files"

function is_capability(word: string): word is AppCapability {
  return word === "calendar" || word === "mail" || word === "notes" || word === "files"
}

function usage_error(name: string): ChatCommand {
  const help = COMMANDS.find((command) => command.name === name)
  return { kind: "error", message: `Usage: ${help?.usage ?? name}` }
}

// "/model", "/model privacy on", "/model both openrouter <model>", "/model fast <model>".
export function parse_model(words: string[]): ChatCommand {
  if (!words.length) return { kind: "model", change: null }
  if (words[0] === "privacy") {
    if (words[1] !== "on" && words[1] !== "off") return usage_error("/model")
    return { kind: "model", change: { allow_content_to_hosted: words[1] === "on" } }
  }
  const [first, ...rest] = words
  const slot = SLOTS.has(first) ? (first as ModelChange["slot"]) : "both"
  const remaining = SLOTS.has(first) ? rest : words
  const provider = PROVIDERS.has(remaining[0]) ? (remaining[0] as ModelChange["provider"]) : undefined
  const model = (provider ? remaining.slice(1) : remaining).join(" ")
  if (!model) return usage_error("/model")
  return { kind: "model", change: { slot, provider, model } }
}

// "What did I read about lithium?" or "Have I watched anything on traffic?" asks your history; it is a question
// (it ends with a question mark), so "When I see crypto posts, hide them" stays a request for an edit.
const AGENTS = new Set<AgentKind>(["digest", "shop", "research", "cleanup", "watch"])
const HISTORY_QUESTION = /^(what|which|who|when|where|did|do|have|had|how many|how much)\b.*\b(i|me|my)\b.*\b(read|see|saw|seen|watch|watched|open|opened|save|saved|highlight|highlighted|mark|marked|note|noted|bought|liked)\b[^?]*\?\s*$/i

export function parse_chat(input: string): ChatCommand {
  const text = input.trim()
  if (!text.startsWith("/")) return HISTORY_QUESTION.test(text) ? { kind: "ask", question: text } : { kind: "edit", scope: "any", text }
  const [name, ...words] = text.split(/\s+/)
  const command = name.toLowerCase()
  const rest = text.slice(name.length).trim()
  if (command in SCOPES) return rest ? { kind: "edit", scope: SCOPES[command], text: rest } : usage_error(command)
  if (command === "/newview") {
    if (!words[0] || !VIEW_NAME.test(words[0])) return usage_error(command)
    return { kind: "new_view", view_id: words[0].toLowerCase(), title: words[0], description: words.slice(1).join(" ") }
  }
  if (command === "/model") return parse_model(words)
  if (command === "/settings") return words[0] && words[0] !== "open" ? usage_error(command) : { kind: "settings", open: words[0] === "open" }
  if (command === "/background") return words[0] === "on" || words[0] === "off" ? { kind: "background", on: words[0] === "on" } : usage_error(command)
  if (command === "/mirror") {
    const days = words[0] === undefined ? 7 : Number(words[0])
    return Number.isInteger(days) && days >= 1 && days <= 30 && words.length <= 1 ? { kind: "mirror", days } : usage_error(command)
  }
  if (command === "/search") return rest ? { kind: "search", query: rest } : usage_error(command)
  if (command === "/agent") {
    const agent = words[0]?.toLowerCase() as AgentKind
    const request = words.slice(1).join(" ")
    if (!AGENTS.has(agent) || (!request && agent !== "digest" && agent !== "cleanup")) return usage_error(command)
    return { kind: "agent", agent, request: request || (agent === "digest" ? "catch me up" : "tidy up what I follow") }
  }
  if (command === "/shop") return rest ? { kind: "shop", query: rest } : usage_error(command)
  if (command === "/ask") return rest ? { kind: "ask", question: rest } : usage_error(command)
  if (command === "/collections") return words.length ? usage_error(command) : { kind: "collections" }
  if (command === "/export") {
    const format = words[0] === "json" || words[0] === "md" ? words[0] : "md"
    const named = (format === words[0] ? words.slice(1) : words).join(" ").trim()
    return { kind: "export", format, collection: named || null }
  }
  if (command === "/import") return words.length === 1 && words[0].startsWith("https://") ? { kind: "import", url: words[0] } : usage_error(command)
  if (command === "/share") return words.length ? usage_error(command) : { kind: "share" }
  if (command === "/people") return words.length ? usage_error(command) : { kind: "people" }
  if (command === "/allow") {
    if (!words.length) return { kind: "allow", capability: null }
    const capability = words[0].toLowerCase()
    return words.length === 1 && is_capability(capability) ? { kind: "allow", capability } : usage_error(command)
  }
  if (command === "/google") return words.length === 0 || (words.length === 1 && words[0] === "connect") ? { kind: "google", connect: words[0] === "connect" } : usage_error(command)
  if (command === "/help") return { kind: "help" }
  return { kind: "error", message: `Unknown command ${name}. Type /help for the list.` }
}

export function matching_commands(input: string): CommandHelp[] {
  const typed = input.trim().toLowerCase()
  if (!typed.startsWith("/") || /\s/.test(typed)) return []
  return COMMANDS.filter((command) => command.name.startsWith(typed))
}

export function help_text(): string {
  return ["Commands (anything else is understood from context):", ...COMMANDS.map((command) => `${command.usage}\n    ${command.summary}`)].join("\n")
}

function slot_line(name: string, slot: SlotInfo): string {
  const where = slot.local ? "on this machine" : "hosted"
  const key = slot.key_ready ? "" : ", key missing"
  return `${name}: ${slot.model} via ${slot.provider} (${where}${key})`
}

export function format_model(info: ModelInfo): string {
  const privacy = info.allow_content_to_hosted
    ? "Your content may go to hosted models: on (turn off with /model privacy off)"
    : "Your content may go to hosted models: off (turn on with /model privacy on)"
  return [slot_line("fast", info.fast), slot_line("smart", info.smart), privacy].join("\n")
}

function block(label: string, body: string): string {
  return `${label}:\n${body.trim() || "(empty)"}`
}

export function format_overview(overview: Overview): string {
  const sections = Object.entries(overview.sections).map(([name, body]) => block(name, body))
  const memory = Object.entries(overview.memory).map(([name, body]) => block(`memory/${name}`, body))
  return [
    `Settings for ${overview.view_file} (change with /feed, /sources, /layout):`,
    ...sections,
    "Memory, for every view (change with /memory):",
    ...memory,
    "Models (change with /model):",
    format_model(overview.model),
    `Chrome: ${overview.relay.connected ? "connected" : "not connected"}`,
    `Files: ${overview.home} (type /settings open to open the folder)`,
  ].join("\n")
}

function share(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`
}

function times(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function source_line(source: SourceMirror): string {
  const parts = [`${times(source.listed, "item")}`, `${share(source.kept, source.listed)} passed your rules`]
  if (source.strangers !== null) parts.push(`${share(source.strangers, source.listed)} from strangers`)
  for (const [name, count] of Object.entries(source.judged)) if (count) parts.push(`${share(count, source.listed)} judged ${name.replaceAll("_", " ")}`)
  return `* ${source.source_id}: ${parts.join(", ")}. You saw ${source.seen} and opened ${source.opened}.`
}

function view_line(view: ViewMirror): string {
  const parts = []
  if (view.visits) parts.push(times(view.visits, "visit"))
  if (view.extended) parts.push(`${times(view.extended, "time")} 5 more minutes`)
  if (view.early) parts.push(`opened early ${times(view.early, "time")}`)
  return `* ${view.view_id}: ${parts.join(", ")}.`
}

// The mirror as chat text: per source what it showed and what passed, then how you used your views.
export function format_mirror(mirror: Mirror): string {
  const period = mirror.days === 1 ? "the last day" : `the last ${mirror.days} days`
  if (!mirror.sources.length && !mirror.views.length) return `Nothing was read in ${period}.`
  const lines = [`What your sources showed you in ${period}:`, ...mirror.sources.map(source_line)]
  if (mirror.views.length) lines.push("How you used your views:", ...mirror.views.map(view_line))
  return lines.join("\n")
}

const MAX_HIT_TEXT = 80
const LINK = /https?:\/\/[^\s<>"]+/g
const TRAILING = /[.,;:!?'"]$/

function hit_line(hit: SearchHit): string {
  const item = hit.item
  const title = (item.title || item.text || item.url).replace(/\s+/g, " ").trim().slice(0, MAX_HIT_TEXT)
  const day = (item.published_at ?? item.fetched_at).slice(0, 10)
  return `* ${title} (${item.source_id}, ${day}) ${item.url}`
}

export function format_search(query: string, hits: SearchHit[]): string {
  if (!hits.length) return `Nothing you were shown matches "${query}".`
  return [`${hits.length === 1 ? "One item matches" : `${hits.length} items match`} "${query}", best first:`, ...hits.map(hit_line)].join("\n")
}

export interface TextPart {
  text: string
  url?: string
}

function count(text: string, character: string): number {
  return text.split(character).length - 1
}

// A link as written in text, without the punctuation after it: "(see https://a.example/x)." ends at x, while
// https://en.wikipedia.org/wiki/Mercury_(planet) keeps the parenthesis it opened.
export function link_end(candidate: string): string {
  let link = candidate
  for (;;) {
    if (TRAILING.test(link)) link = link.slice(0, -1)
    else if (link.endsWith(")") && count(link, ")") > count(link, "(")) link = link.slice(0, -1)
    else if (link.endsWith("]") && count(link, "]") > count(link, "[")) link = link.slice(0, -1)
    else return link
  }
}

// Chat text split around its web links, so each link can be opened with a click.
export function linked_parts(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0
    const link = link_end(match[0])
    if (link.length <= "https://".length) continue
    if (start > last) parts.push({ text: text.slice(last, start) })
    parts.push({ text: link, url: link })
    last = start + link.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}

export function format_collections(collections: CollectionInfo[]): string {
  if (!collections.length) return "Nothing saved yet. Read later and Watch later on a card keep it here."
  const lines = collections.map((info) => {
    const where = info.views.length ? `in the ${info.views.join(", ")} tab${info.views.length > 1 ? "s" : ""}` : "no tab reads it yet"
    return `* ${info.title}: ${times(info.count, "item")}, ${where}`
  })
  return ["Your collections:", ...lines, "Export one with /export md <collection>."].join("\n")
}

// The answer, then each source it cites with its link, so a click opens the original.
export function format_answer(answer: Answer): string {
  return [answer.answer, ...answer.citations.map((citation) => `[${citation.number}] ${citation.title} ${citation.url}`)].join("\n")
}
