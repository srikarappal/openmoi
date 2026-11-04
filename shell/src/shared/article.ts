// Reader mode for Mine: Readability finds the article; its content becomes plain text blocks a lens can render safely.
import { Readability, isProbablyReaderable } from "@mozilla/readability"
import type { RawRecord } from "./types"

export interface Block {
  type: "h" | "p" | "img" | "quote" | "li"
  text?: string
  src?: string
}

const BLOCK_TYPES: Record<string, Block["type"]> = {
  H1: "h",
  H2: "h",
  H3: "h",
  H4: "h",
  H5: "h",
  H6: "h",
  P: "p",
  PRE: "p",
  FIGCAPTION: "p",
  BLOCKQUOTE: "quote",
  LI: "li",
}
const MAX_BLOCKS = 400
const MIN_ARTICLE_CHARS = 800
const MIN_ARTICLE_SHARE = 0.4
const MAX_TEXT = 2000

function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

function image_block(image: Element, page_url: string): Block | null {
  try {
    return { type: "img", src: new URL(image.getAttribute("src") ?? "", page_url).toString() }
  } catch {
    return null
  }
}

function collect_blocks(parent: ParentNode, page_url: string, blocks: Block[]): void {
  for (const element of Array.from(parent.children)) {
    const type = BLOCK_TYPES[element.tagName]
    const images = element.tagName === "IMG" ? [element] : type ? Array.from(element.querySelectorAll("img")) : []
    if (type && clean(element.textContent)) blocks.push({ type, text: clean(element.textContent) })
    for (const image of images) {
      const block = image.getAttribute("src") ? image_block(image, page_url) : null
      if (block) blocks.push(block)
    }
    if (!type && element.tagName !== "IMG") collect_blocks(element, page_url, blocks)
  }
}

export function article_blocks(root: ParentNode, page_url: string): Block[] {
  const blocks: Block[] = []
  collect_blocks(root, page_url, blocks)
  return blocks.slice(0, MAX_BLOCKS)
}

// An article record when the page is mostly one long article, otherwise null so Mine treats it as a listing.
export function read_article(doc: Document, page_url: string): RawRecord | null {
  if (!isProbablyReaderable(doc)) return null
  const article = new Readability(doc.cloneNode(true) as Document).parse()
  const text = clean(article?.textContent)
  const page_text = clean(doc.body?.textContent).length
  if (!article?.content || text.length < MIN_ARTICLE_CHARS || text.length < page_text * MIN_ARTICLE_SHARE) return null
  const blocks = article_blocks(new DOMParser().parseFromString(article.content, "text/html").body, page_url)
  return {
    native_id: page_url,
    url: page_url,
    kind: "article",
    title: clean(article.title) || doc.title,
    text: text.slice(0, MAX_TEXT),
    author_name: clean(article.byline),
    image_url: blocks.find((block) => block.type === "img")?.src ?? "",
    "extra.blocks": JSON.stringify(blocks),
  }
}
