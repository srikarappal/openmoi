// Synthetic items that exercise a lens: every kind, missing fields, long text, right to left scripts. Used by the lens
// test gate and unit tests; nothing here is yours, so a hosted model may see a screenshot of it.
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

const ALL_KINDS: ItemKind[] = ["post", "article", "video", "product", "link"]
export const TIMED_ITEMS = 50

export interface LensScenario {
  name: string
  items: ViewItem[]
  // The render whose speed counts, that is checked for accessibility and shown to the visual judge.
  timed?: boolean
}

// Items that break careless lenses: right to left text, a word too long for any line, nothing but an id, markup and
// emoji in text, and every kind of item.
export function hard_items(kind: LensKind): ViewItem[] {
  const kinds = kind === "listing" ? LISTING_KINDS : ALL_KINDS
  return [
    synthetic_item("rtl_arabic", { title: "عنوان طويل باللغة العربية عن الأخبار", text: "نص عربي طويل ".repeat(40), author_name: "مريم" }),
    synthetic_item("rtl_hebrew", { title: "כותרת בעברית", text: "טקסט ארוך בעברית ".repeat(30) }),
    synthetic_item("long_word", { title: "W".repeat(400), text: "x".repeat(10_000) }),
    synthetic_item("bare", { title: null, text: null, author_name: null, author_handle: null, published_at: null, image_url: null }),
    synthetic_item("markup", { title: "<b>not bold</b> & <script>not run</script> 🙂", text: "Line one\nLine two\t\u200b end" }),
    ...kinds.map((item_kind, index) => synthetic_item(`kind_${item_kind}_${index}`, { kind: item_kind, title: `A ${item_kind}`, image_url: index % 2 ? null : PIXEL, extra: kind === "listing" ? { price_text: "$9.99" } : {} })),
  ]
}

function rtl_article(): ViewItem {
  const blocks = [
    { type: "h", text: "عنوان فرعي" },
    { type: "p", text: "فقرة من نص المقال. ".repeat(12) },
    { type: "li", text: "عنصر في قائمة" },
  ]
  return synthetic_item("article_rtl", { kind: "article", title: "مقال تجريبي", author_name: "مريم", extra: { blocks: JSON.stringify(blocks) } })
}

// What the test gate renders, in order: nothing, one item, 50 timed, the hard cases, then 500.
export function lens_scenarios(kind: LensKind): LensScenario[] {
  if (kind === "article") {
    return [
      { name: "no items", items: [] },
      { name: "an article", items: [article_item()], timed: true },
      { name: "a right to left article", items: [rtl_article()] },
    ]
  }
  return [
    { name: "no items", items: [] },
    { name: "one item", items: synthetic_view_items(kind, 1) },
    { name: `${TIMED_ITEMS} items`, items: synthetic_view_items(kind, TIMED_ITEMS), timed: true },
    { name: "hard cases", items: hard_items(kind) },
    { name: "500 items", items: synthetic_view_items(kind, 500) },
  ]
}
