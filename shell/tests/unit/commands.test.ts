import { describe, expect, it } from "vitest"
import { COMMANDS, format_mirror, format_model, format_search, help_text, linked_parts, matching_commands, parse_chat } from "../../src/shared/commands"
import type { Item, Mirror } from "../../src/shared/types"

describe("parse_chat", () => {
  it.each([
    ["no shorts please", { kind: "edit", scope: "any", text: "no shorts please" }],
    ["  /memory   I'm vegetarian ", { kind: "edit", scope: "memory", text: "I'm vegetarian" }],
    ["/FEED hide politics", { kind: "edit", scope: "rules", text: "hide politics" }],
    ["/sources add https://a.com/rss", { kind: "edit", scope: "sources", text: "add https://a.com/rss" }],
    ["/layout compact cards", { kind: "edit", scope: "layout", text: "compact cards" }],
    ["/time editions at 7:00 and 18:00", { kind: "edit", scope: "time", text: "editions at 7:00 and 18:00" }],
    ["/background on", { kind: "background", on: true }],
    ["/background off", { kind: "background", on: false }],
    ["/mirror", { kind: "mirror", days: 7 }],
    ["/mirror 30", { kind: "mirror", days: 30 }],
    ["/search  lithium   recycling ", { kind: "search", query: "lithium   recycling" }],
    ["/collections", { kind: "collections" }],
    ["/shop  desk lamp ", { kind: "shop", query: "desk lamp" }],
    ["/agent shop a quiet dishwasher under $900", { kind: "agent", agent: "shop", request: "a quiet dishwasher under $900" }],
    ["/agent digest", { kind: "agent", agent: "digest", request: "catch me up" }],
    ["/agent cleanup", { kind: "agent", agent: "cleanup", request: "tidy up what I follow" }],
    ["/ask what was that piece on lithium?", { kind: "ask", question: "what was that piece on lithium?" }],
    ["What did I read about lithium last week?", { kind: "ask", question: "What did I read about lithium last week?" }],
    ["which video did I watch on traffic?", { kind: "ask", question: "which video did I watch on traffic?" }],
    ["Have I read anything about lithium?", { kind: "ask", question: "Have I read anything about lithium?" }],
    ["How many videos did I watch this week?", { kind: "ask", question: "How many videos did I watch this week?" }],
    ["which video did I watch on traffic", { kind: "edit", scope: "any", text: "which video did I watch on traffic" }],
    ["When I see posts about crypto, hide them", { kind: "edit", scope: "any", text: "When I see posts about crypto, hide them" }],
    ["When I watch YouTube, skip the shorts", { kind: "edit", scope: "any", text: "When I watch YouTube, skip the shorts" }],
    ["what should my feed show?", { kind: "edit", scope: "any", text: "what should my feed show?" }],
    ["hide what I already read", { kind: "edit", scope: "any", text: "hide what I already read" }],
    ["/export", { kind: "export", format: "md", collection: null }],
    ["/export json", { kind: "export", format: "json", collection: null }],
    ["/export read later", { kind: "export", format: "md", collection: "read later" }],
    ["/export md watch later", { kind: "export", format: "md", collection: "watch later" }],
    ["/import https://gist.example/ai.md", { kind: "import", url: "https://gist.example/ai.md" }],
    ["/share", { kind: "share" }],
    ["/google", { kind: "google", connect: false }],
    ["/google connect", { kind: "google", connect: true }],
    ["/newview Tech", { kind: "new_view", view_id: "tech", title: "Tech", description: "" }],
    ["/newview space_news space and physics", { kind: "new_view", view_id: "space_news", title: "space_news", description: "space and physics" }],
    ["/model", { kind: "model", change: null }],
    ["/model privacy off", { kind: "model", change: { allow_content_to_hosted: false } }],
    ["/model both openrouter nvidia/nemotron-3.5-super-vl:free", { kind: "model", change: { slot: "both", provider: "openrouter", model: "nvidia/nemotron-3.5-super-vl:free" } }],
    ["/model fast ollama llama3.2", { kind: "model", change: { slot: "fast", provider: "ollama", model: "llama3.2" } }],
    ["/model smart gpt-x", { kind: "model", change: { slot: "smart", provider: undefined, model: "gpt-x" } }],
    ["/model openrouter some/model", { kind: "model", change: { slot: "both", provider: "openrouter", model: "some/model" } }],
    ["/settings", { kind: "settings", open: false }],
    ["/settings open", { kind: "settings", open: true }],
    ["/help", { kind: "help" }],
  ])("%s", (typed, expected) => {
    expect(parse_chat(typed)).toEqual(expected)
  })

  it.each([
    ["/memory", "Usage: /memory <what to remember or forget>"],
    ["/layout   ", "Usage: /layout <how it should look>"],
    ["/newview", "Usage: /newview <name> [what it should be]"],
    ["/newview ../etc", "Usage: /newview <name> [what it should be]"],
    ["/newview my-view", "Usage: /newview <name> [what it should be]"],
    ["/model privacy maybe", `Usage: ${COMMANDS.find((command) => command.name === "/model")?.usage}`],
    ["/model fast openrouter", `Usage: ${COMMANDS.find((command) => command.name === "/model")?.usage}`],
    ["/settings delete", "Usage: /settings [open]"],
    ["/time", "Usage: /time <when this view comes out>"],
    ["/background", "Usage: /background on|off"],
    ["/background maybe", "Usage: /background on|off"],
    ["/mirror 0", "Usage: /mirror [days]"],
    ["/search", "Usage: /search <words>"],
    ["/collections now", "Usage: /collections"],
    ["/ask", "Usage: /ask <question>"],
    ["/shop", "Usage: /shop <what you want>"],
    ["/agent", "Usage: /agent digest|shop|research|cleanup|watch <task>"],
    ["/agent shop", "Usage: /agent digest|shop|research|cleanup|watch <task>"],
    ["/agent buy a lamp", "Usage: /agent digest|shop|research|cleanup|watch <task>"],
    ["/search   ", "Usage: /search <words>"],
    ["/mirror 31", "Usage: /mirror [days]"],
    ["/mirror week", "Usage: /mirror [days]"],
    ["/mirror 7 more", "Usage: /mirror [days]"],
    ["/import", "Usage: /import <https link to a view file>"],
    ["/import http://gist.example/ai.md", "Usage: /import <https link to a view file>"],
    ["/import https://a.example/1 https://b.example/2", "Usage: /import <https link to a view file>"],
    ["/share feed", "Usage: /share"],
    ["/google disconnect", "Usage: /google [connect]"],
    ["/nope", "Unknown command /nope. Type /help for the list."],
  ])("%s is a usage error", (typed, message) => {
    expect(parse_chat(typed)).toEqual({ kind: "error", message })
  })
})

describe("command hints", () => {
  it("match while you type the command name only", () => {
    expect(matching_commands("/").map((command) => command.name)).toEqual(COMMANDS.map((command) => command.name))
    expect(matching_commands("/m").map((command) => command.name)).toEqual(["/memory", "/model", "/mirror"])
    expect(matching_commands("/memory I like")).toEqual([])
    expect(matching_commands("hello")).toEqual([])
  })

  it("help lists every command", () => {
    for (const command of COMMANDS) expect(help_text()).toContain(command.usage)
  })

  it("model text says where models run and whether a key is missing", () => {
    const text = format_model({
      fast: { provider: "openrouter", model: "m", base_url: "https://openrouter.ai/api/v1", local: false, key_ready: false },
      smart: { provider: "ollama", model: "llama3", base_url: "http://127.0.0.1:11434/v1", local: true, key_ready: true },
      allow_content_to_hosted: false,
    })
    expect(text).toBe(
      "fast: m via openrouter (hosted, key missing)\nsmart: llama3 via ollama (on this machine)\nYour content may go to hosted models: off (turn on with /model privacy on)",
    )
  })
})

describe("format_mirror", () => {
  it("says per source what it showed, what passed, strangers and judgments, then how views were used", () => {
    const mirror: Mirror = {
      days: 7,
      since: "2026-11-03T09:00:00Z",
      sources: [
        { source_id: "x", listed: 600, kept: 42, seen: 120, opened: 4, strangers: 246, judged: { angry: 198, job_or_ad: 0 } },
        { source_id: "rss:ars", listed: 1, kept: 1, seen: 1, opened: 0, strangers: null, judged: {} },
      ],
      views: [
        { view_id: "feed", visits: 12, extended: 3, early: 2 },
        { view_id: "break", visits: 1, extended: 1, early: 1 },
      ],
    }
    expect(format_mirror(mirror)).toBe(
      [
        "What your sources showed you in the last 7 days:",
        "* x: 600 items, 7% passed your rules, 41% from strangers, 33% judged angry. You saw 120 and opened 4.",
        "* rss:ars: 1 item, 100% passed your rules. You saw 1 and opened 0.",
        "How you used your views:",
        "* feed: 12 visits, 3 times 5 more minutes, opened early 2 times.",
        "* break: 1 visit, 1 time 5 more minutes, opened early 1 time.",
      ].join("\n"),
    )
  })

  it("says when nothing was read", () => {
    expect(format_mirror({ days: 1, since: "2026-11-09T09:00:00Z", sources: [], views: [] })).toBe("Nothing was read in the last day.")
    expect(format_mirror({ days: 2, since: "2026-11-08T09:00:00Z", sources: [], views: [{ view_id: "feed", visits: 1, extended: 0, early: 0 }] })).toBe(
      "What your sources showed you in the last 2 days:\nHow you used your views:\n* feed: 1 visit.",
    )
  })
})

function search_item(fields: Partial<Item>): Item {
  return {
    item_id: "i1",
    source_id: "rss:news",
    native_id: "1",
    kind: "article",
    url: "https://news.example/lithium",
    title: null,
    text: null,
    author_name: null,
    author_handle: null,
    image_url: null,
    media_kind: null,
    published_at: null,
    fetched_at: "2026-11-02T08:00:00Z",
    topics: [],
    tagged: true,
    available_actions: [],
    extra: {},
    ...fields,
  }
}

describe("format_search", () => {
  it("lists hits best first with source, day and link, or says nothing matched", () => {
    const hits = [
      { item: search_item({ title: "Lithium   recycling\nscales up", published_at: "2026-11-01T10:00:00Z" }), score: 0.9 },
      { item: search_item({ item_id: "i2", source_id: "x", url: "https://x.com/a/status/1", text: "a".repeat(120) }), score: 0.4 },
    ]
    expect(format_search("lithium", hits)).toBe(
      [
        '2 items match "lithium", best first:',
        "* Lithium recycling scales up (rss:news, 2026-11-01) https://news.example/lithium",
        `* ${"a".repeat(80)} (x, 2026-11-02) https://x.com/a/status/1`,
      ].join("\n"),
    )
    expect(format_search("lithium", hits.slice(0, 1)).split("\n")[0]).toBe('One item matches "lithium", best first:')
    expect(format_search("zebra", [])).toBe('Nothing you were shown matches "zebra".')
  })
})

describe("linked_parts", () => {
  it("splits text around web links and leaves trailing punctuation out of them", () => {
    expect(linked_parts("see https://a.example/x?y=1, and (http://b.example/z).")).toEqual([
      { text: "see " },
      { text: "https://a.example/x?y=1", url: "https://a.example/x?y=1" },
      { text: ", and (" },
      { text: "http://b.example/z", url: "http://b.example/z" },
      { text: ")." },
    ])
    expect(linked_parts("no links here")).toEqual([{ text: "no links here" }])
    expect(linked_parts("")).toEqual([])
    expect(linked_parts("javascript:alert(1) ftp://x.example")).toEqual([{ text: "javascript:alert(1) ftp://x.example" }])
    expect(linked_parts("see https://en.wikipedia.org/wiki/Mercury_(planet).")).toEqual([
      { text: "see " },
      { text: "https://en.wikipedia.org/wiki/Mercury_(planet)", url: "https://en.wikipedia.org/wiki/Mercury_(planet)" },
      { text: "." },
    ])
    expect(linked_parts("[https://a.example/x]")).toEqual([{ text: "[" }, { text: "https://a.example/x", url: "https://a.example/x" }, { text: "]" }])
    expect(linked_parts("odd https://. end")).toEqual([{ text: "odd https://. end" }])
  })
})
