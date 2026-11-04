// Synthetic items that exercise a lens: every kind, missing fields, long text. Used by the smoke test and unit tests.
import type { Item, ItemKind, LensKind, ViewItem } from "./types"

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw="
const FEED_KINDS: ItemKind[] = ["post", "article", "video", "post", "link"]
const LISTING_KINDS: ItemKind[] = ["product", "link"]
const SMOKE_ITEMS = 30

export function synthetic_item(item_id: string, fields: Partial<Item> = {}, reasons = ["recent", "from x"]): ViewItem {
  return {
    item: {
      item_id,
      source_id: "x",
      native_id: item_id,
      kind: "post",
      url: `https://example.com/items/${item_id}`,
      title: null,
      text: `text of ${item_id}`,
      author_name: "Maya",
      author_handle: "maya",
      image_url: null,
      media_kind: null,
      published_at: new Date(Date.now() - 3_600_000).toISOString(),
      fetched_at: new Date().toISOString(),
      topics: [],
      tagged: true,
      available_actions: [],
      extra: {},
      ...fields,
    },
    reasons,
  }
}

function article_item(): ViewItem {
  const blocks = [
    { type: "h", text: "A heading" },
    { type: "p", text: "A paragraph of the article body. ".repeat(6) },
    { type: "img", src: PIXEL },
    { type: "quote", text: "A quoted line." },
    { type: "li", text: "A list item." },
  ]
  return synthetic_item("article0", { kind: "article", title: "A synthetic article", author_name: "Jordan", extra: { blocks: JSON.stringify(blocks) } })
}

export function synthetic_view_items(kind: LensKind, count = SMOKE_ITEMS): ViewItem[] {
  if (kind === "article") return [article_item()]
  const kinds = kind === "listing" ? LISTING_KINDS : FEED_KINDS
  return Array.from({ length: count }, (_, index) =>
    synthetic_item(`item${index}`, {
      kind: kinds[index % kinds.length],
      title: index % 4 === 0 ? null : `Synthetic title ${index}`,
      text: index === 7 ? "A very long text. ".repeat(120) : `Short text ${index}`,
      author_name: index % 5 === 0 ? null : "Maya",
      image_url: index % 2 === 0 ? PIXEL : null,
      published_at: index % 6 === 0 ? null : new Date(Date.now() - index * 3_600_000).toISOString(),
      extra: kind === "listing" ? { price_text: `$${index}.99` } : {},
    }),
  )
}
