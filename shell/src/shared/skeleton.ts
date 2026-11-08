// Page skeletons for extractor generation: structure only. Every text becomes {t:N}, so no page words reach a model.

const DROPPED_TAGS = new Set(["script", "style", "noscript", "svg", "iframe", "link", "meta", "template", "canvas", "video", "audio", "source", "object", "embed", "head"])
const KEPT_ATTRIBUTES = new Set(["role", "itemprop", "itemtype", "itemscope", "datetime", "type"])
const TEXT_ATTRIBUTES = new Set(["aria-label", "aria-description", "aria-valuetext", "title", "alt", "placeholder", "value"])
const STRUCTURAL_DATA = new Set([
  "data-testid", "data-test", "data-test-id", "data-cy", "data-qa", "data-e2e", "data-component-type", "data-type", "data-role",
  "data-kind", "data-layout", "data-module", "data-section",
])
// Path words that describe a site's structure rather than its content; every other segment is masked.
const URL_WORDS = new Set([
  "a", "article", "articles", "blog", "c", "categories", "category", "comments", "dp", "en", "gp", "item", "items", "job", "jobs",
  "list", "listing", "listings", "news", "p", "page", "post", "posts", "product", "products", "q", "questions", "r", "s",
  "search", "shop", "status", "store", "stories", "story", "t", "tag", "tags", "thread", "threads", "topic", "topics", "u",
  "user", "users", "video", "videos", "watch", "wiki",
])
// Words that name parts of a page rather than anything about you; attribute tokens made of these are always kept.
const MARKUP_WORDS = new Set([
  "a", "action", "actions", "active", "add", "app", "article", "aside", "author", "avatar", "badge", "banner", "bar", "block", "body",
  "bottom", "box", "btn", "button", "buy", "caption", "card", "cart", "cell", "col", "column", "comment", "comments", "component",
  "container", "content", "count", "cover", "date", "description", "detail", "details", "dialog", "display", "entry", "feed", "field",
  "figure", "first", "footer", "form", "grid", "group", "handle", "head", "header", "heading", "hidden", "icon", "image", "img", "index",
  "info", "inline", "inner", "input", "item", "items", "label", "large", "last", "layout", "left", "like", "likes", "line", "link",
  "links", "list", "listing", "logo", "main", "media", "medium", "menu", "message", "meta", "module", "more", "name", "nav", "next",
  "normal", "offer", "offscreen", "outer", "overlay", "page", "pagination", "panel", "photo", "picture", "player", "post", "posts",
  "prev", "price", "primary", "product", "profile", "promo", "rating", "reply", "result", "results", "retweet", "review", "reviews",
  "right", "row", "score", "screen", "search", "secondary", "section", "share", "side", "sidebar", "site", "size", "small", "social",
  "source", "span", "star", "stars", "status", "story", "subtitle", "summary", "tab", "tabs", "tag", "tags", "text", "thumb",
  "thumbnail", "time", "timeline", "timestamp", "title", "toolbar", "top", "tweet", "type", "user", "username", "video", "view",
  "views", "visible", "wrap", "wrapper",
  "true", "false", "none", "auto", "on", "off", "yes", "no", "polite", "assertive", "step", "location",
  "news", "jobs", "job", "article", "articles", "stories", "videos", "products", "listings", "entries", "comments", "track", "click",
  "js", "wrapper", "titleline", "athing", "subtext", "hnuser", "age", "sitestr",
])
const PAGE_ORIGIN = "https://page.invalid"
const MAX_CLASSES = 4
const MAX_REPEATS = 3
const MAX_VALUE = 60
export const MAX_SKELETON_CHARS = 60_000

function text_length(node: Node): number {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim().length
}

// Lowercase words of a value or text: split at anything that is not a letter or digit and at camelCase humps.
export function words_of(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/))
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

// Markup words and two letter bits stay. Elsewhere a token could be about you: in strict values (ids, data values)
// it is masked, in class names and test ids only when it also shows in the page's text (a handle, a name, a topic)
// or carries a long number. Numbers on their own become 9.
function keep_token(token: string, page_words: Set<string>, strict: boolean): boolean {
  const words = words_of(token)
  if (words.every((word) => word.length <= 2 || MARKUP_WORDS.has(word))) return true
  return !strict && !/\d{4,}/.test(token) && words.every((word) => !page_words.has(word))
}

function masked_value(value: string, page_words: Set<string>, strict: boolean): string {
  return value.replace(/[A-Za-z0-9]+/g, (token) => {
    if (/^\d+$/.test(token)) return "9"
    return keep_token(token, page_words, strict) ? token : `{t:${token.length}}`
  })
}

function segment_shape(segment: string): string {
  const match = /^(.*?)(\.[a-z0-9]{1,4})?$/i.exec(segment)
  const stem = match?.[1] ?? segment
  const extension = match?.[2] ?? ""
  if (/^\d+$/.test(stem)) return `9${extension}`
  return `${URL_WORDS.has(stem.toLowerCase()) ? stem.toLowerCase() : "w"}${extension}`
}

// Link and image addresses keep only their shape, since paths, slugs and hosts carry content.
export function url_shape(value: string): string {
  try {
    const url = new URL(value, `${PAGE_ORIGIN}/`)
    if (url.protocol !== "https:" && url.protocol !== "http:") return url.protocol
    const path = `/${url.pathname.split("/").filter(Boolean).map(segment_shape).join("/")}`.slice(0, MAX_VALUE)
    const query = url.search ? "?q" : ""
    return url.origin === PAGE_ORIGIN ? `${path}${query}` : `${url.protocol}//ext${path}${query}`
  } catch {
    return "{url}"
  }
}

// Class lists keep whole classes (never a class cut in two, which would name one the page does not have).
function attribute_value(name: string, value: string, page_words: Set<string>): string | null {
  if (name === "class") return value.split(/\s+/).filter(Boolean).slice(0, MAX_CLASSES).map((single) => masked_value(single, page_words, false)).join(" ")
  if (name === "href" || name === "src") return url_shape(value)
  if (TEXT_ATTRIBUTES.has(name)) return `{t:${value.trim().length}}`
  if (STRUCTURAL_DATA.has(name)) return masked_value(value.slice(0, MAX_VALUE), page_words, false)
  if (name === "id" || name.startsWith("data-") || name.startsWith("aria-")) return masked_value(value.slice(0, MAX_VALUE), page_words, true)
  if (KEPT_ATTRIBUTES.has(name)) return value.slice(0, MAX_VALUE)
  return null
}

function attributes(element: Element, page_words: Set<string>): string {
  const parts: string[] = []
  for (const attribute of Array.from(element.attributes)) {
    const value = attribute_value(attribute.name.toLowerCase(), attribute.value, page_words)
    if (value !== null) parts.push(` ${attribute.name.toLowerCase()}="${value.replaceAll('"', "'")}"`)
  }
  return parts.join("")
}

function kept_children(element: Element): Node[] {
  return Array.from(element.childNodes).filter((node) =>
    node.nodeType === 1 ? !DROPPED_TAGS.has((node as Element).tagName.toLowerCase()) : node.nodeType === 3 && text_length(node) > 0,
  )
}

function signature(node: Node): string {
  if (node.nodeType !== 1) return "#text"
  const element = node as Element
  return `${element.tagName}.${element.getAttribute("class") ?? ""}`
}

function write_node(node: Node, depth: number, lines: string[], page_words: Set<string>): void {
  const indent = " ".repeat(depth)
  if (node.nodeType === 3) {
    lines.push(`${indent}{t:${text_length(node)}}`)
    return
  }
  const element = node as Element
  const tag = element.tagName.toLowerCase()
  const open = `<${tag}${attributes(element, page_words)}>`
  const children = kept_children(element)
  if (!children.length) lines.push(`${indent}${open}`)
  else if (children.length === 1 && children[0].nodeType === 3) lines.push(`${indent}${open}{t:${text_length(children[0])}}</${tag}>`)
  else {
    lines.push(`${indent}${open}`)
    write_children(children, depth + 1, lines, page_words)
    lines.push(`${indent}</${tag}>`)
  }
}

// Long runs of siblings that look alike are cut to three examples and a count.
function write_children(children: Node[], depth: number, lines: string[], page_words: Set<string>): void {
  let previous = ""
  let run = 0
  let skipped = 0
  for (const child of children) {
    const current = signature(child)
    if (current !== previous && skipped) {
      lines.push(`${" ".repeat(depth)}<!-- ${skipped} more like the above -->`)
      skipped = 0
    }
    run = current === previous ? run + 1 : 1
    previous = current
    if (run > MAX_REPEATS) skipped += 1
    else write_node(child, depth, lines, page_words)
  }
  if (skipped) lines.push(`${" ".repeat(depth)}<!-- ${skipped} more like the above -->`)
}

// The words a person sees on the page: text inside scripts, styles and the other dropped tags does not count.
function visible_words(root: Element): Set<string> {
  const words = new Set<string>()
  const walker = root.ownerDocument.createTreeWalker(root, 4)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (has_dropped_ancestor(node, root)) continue
    for (const word of words_of(node.textContent ?? "")) words.add(word)
  }
  return words
}

function has_dropped_ancestor(node: Node, root: Element): boolean {
  for (let parent = node.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
    if (DROPPED_TAGS.has(parent.tagName.toLowerCase())) return true
  }
  return false
}

export function skeleton(root: Element): string {
  const lines: string[] = []
  write_node(root, 0, lines, visible_words(root))
  const text = lines.join("\n")
  return text.length > MAX_SKELETON_CHARS ? `${text.slice(0, MAX_SKELETON_CHARS)}\n<!-- skeleton cut at ${MAX_SKELETON_CHARS} characters -->` : text
}
