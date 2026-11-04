// Page skeletons for extractor generation: structure only. Every text becomes {t:N}, so no page words reach a model.

const DROPPED_TAGS = new Set(["script", "style", "noscript", "svg", "iframe", "link", "meta", "template", "canvas", "video", "audio", "source", "object", "embed", "head"])
const KEPT_ATTRIBUTES = new Set(["role", "itemprop", "itemtype", "itemscope", "datetime", "type"])
const TEXT_ATTRIBUTES = new Set(["aria-label", "aria-description", "aria-valuetext", "title", "alt", "placeholder", "value"])
const STRUCTURAL_DATA = new Set(["data-testid", "data-component-type", "data-type", "data-role", "data-kind", "data-layout", "data-module", "data-section"])
// Path words that describe a site's structure rather than its content; every other segment is masked.
const URL_WORDS = new Set([
  "a", "article", "articles", "blog", "c", "categories", "category", "comments", "dp", "en", "gp", "item", "items", "job", "jobs",
  "list", "listing", "listings", "news", "p", "page", "post", "posts", "product", "products", "q", "questions", "r", "s",
  "search", "shop", "status", "store", "stories", "story", "t", "tag", "tags", "thread", "threads", "topic", "topics", "u",
  "user", "users", "video", "videos", "watch", "wiki",
])
const IDENTIFIER = /^[\w:./-]{0,60}$/
const STRUCTURAL_TOKEN = /^[A-Za-z_-]{1,20}$/
const PAGE_ORIGIN = "https://page.invalid"
const MAX_CLASSES = 4
const MAX_REPEATS = 3
const MAX_VALUE = 60
export const MAX_SKELETON_CHARS = 60_000

function text_length(node: Node): number {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim().length
}

// Numbers become 9, short structural words stay, anything else could be content and is masked.
function value_shape(value: string): string {
  if (/^\d+$/.test(value)) return "9"
  return STRUCTURAL_TOKEN.test(value) ? value : `{t:${value.trim().length}}`
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

function attribute_value(name: string, value: string): string | null {
  if (name === "class") return value.split(/\s+/).filter(Boolean).slice(0, MAX_CLASSES).join(" ")
  if (name === "href" || name === "src") return url_shape(value)
  if (name === "id") return value_shape(value)
  if (TEXT_ATTRIBUTES.has(name)) return `{t:${value.trim().length}}`
  if (STRUCTURAL_DATA.has(name) || name.startsWith("aria-")) return IDENTIFIER.test(value) ? value : `{t:${value.trim().length}}`
  if (name.startsWith("data-")) return value_shape(value)
  if (KEPT_ATTRIBUTES.has(name)) return value.slice(0, MAX_VALUE)
  return null
}

function attributes(element: Element): string {
  const parts: string[] = []
  for (const attribute of Array.from(element.attributes)) {
    const value = attribute_value(attribute.name.toLowerCase(), attribute.value)
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

function write_node(node: Node, depth: number, lines: string[]): void {
  const indent = " ".repeat(depth)
  if (node.nodeType === 3) {
    lines.push(`${indent}{t:${text_length(node)}}`)
    return
  }
  const element = node as Element
  const tag = element.tagName.toLowerCase()
  const open = `<${tag}${attributes(element)}>`
  const children = kept_children(element)
  if (!children.length) lines.push(`${indent}${open}`)
  else if (children.length === 1 && children[0].nodeType === 3) lines.push(`${indent}${open}{t:${text_length(children[0])}}</${tag}>`)
  else {
    lines.push(`${indent}${open}`)
    write_children(children, depth + 1, lines)
    lines.push(`${indent}</${tag}>`)
  }
}

// Long runs of siblings that look alike are cut to three examples and a count.
function write_children(children: Node[], depth: number, lines: string[]): void {
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
    else write_node(child, depth, lines)
  }
  if (skipped) lines.push(`${" ".repeat(depth)}<!-- ${skipped} more like the above -->`)
}

export function skeleton(root: Element): string {
  const lines: string[] = []
  write_node(root, 0, lines)
  const text = lines.join("\n")
  return text.length > MAX_SKELETON_CHARS ? `${text.slice(0, MAX_SKELETON_CHARS)}\n<!-- skeleton cut at ${MAX_SKELETON_CHARS} characters -->` : text
}
