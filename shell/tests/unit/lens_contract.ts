// Runs any lens HTML in jsdom against a recording fake of the moi helper.
import { JSDOM } from "jsdom"
import type { Item, ViewItem } from "../../src/shared/types"

type Listener = (items: ViewItem[], cursor: string | null) => void

export class FakeMoi {
  readonly sent: Array<Record<string, unknown>> = []
  private render_listener: Listener | null = null
  private append_listener: Listener | null = null

  on_render(listener: Listener): void {
    this.render_listener = listener
  }
  on_append(listener: Listener): void {
    this.append_listener = listener
  }
  ready(): void {
    this.sent.push({ type: "ready" })
  }
  open(item_id: string): void {
    this.sent.push({ type: "open", item_id })
  }
  more(cursor: string): void {
    this.sent.push({ type: "more", cursor })
  }
  seen(item_ids: string[]): void {
    this.sent.push({ type: "seen", item_ids })
  }
  less_like_this(item_id: string): void {
    this.sent.push({ type: "less_like_this", item_id })
  }
  render(items: ViewItem[], cursor: string | null): void {
    this.render_listener?.(items, cursor)
  }
  append(items: ViewItem[], cursor: string | null): void {
    this.append_listener?.(items, cursor)
  }
}

// jsdom has no IntersectionObserver; this one reports nothing, which keeps lenses quiet in tests.
class SilentObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export function run_lens(html: string): { dom: JSDOM; moi: FakeMoi } {
  const moi = new FakeMoi()
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.assign(window, { moi, IntersectionObserver: SilentObserver })
    },
  })
  return { dom, moi }
}

export function view_item(item_id: string, fields: Partial<Item> = {}, reasons = ["recent", "from x"]): ViewItem {
  return {
    item: {
      item_id,
      source_id: "x",
      native_id: item_id,
      kind: "post",
      url: `https://x.com/a/status/${item_id}`,
      title: null,
      text: `text of ${item_id}`,
      author_name: "Maya",
      author_handle: "maya",
      image_url: null,
      media_kind: null,
      published_at: new Date(Date.now() - 3_600_000).toISOString(),
      fetched_at: new Date().toISOString(),
      topics: [],
      available_actions: [],
      extra: {},
      ...fields,
    },
    reasons,
  }
}

export function synthetic_items(count: number): ViewItem[] {
  return Array.from({ length: count }, (_, index) => view_item(`item${index}`, { title: `Synthetic title ${index}` }))
}
