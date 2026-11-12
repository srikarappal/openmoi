// Runs any lens HTML in jsdom against a recording fake of the moi helper.
import { JSDOM } from "jsdom"
import type { ViewItem } from "../../src/shared/types"

type Listener = (items: ViewItem[], cursor: string | null) => void

export class FakeMoi {
  readonly sent: Array<Record<string, unknown>> = []
  private render_listener: Listener | null = null
  private append_listener: Listener | null = null
  private update_listener: Listener | null = null

  on_render(listener: Listener): void {
    this.render_listener = listener
  }
  on_append(listener: Listener): void {
    this.append_listener = listener
  }
  on_update(listener: Listener): void {
    this.update_listener = listener
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
  play(item_id: string): void {
    this.sent.push({ type: "play", item_id })
  }

  save(item_id: string, collection = "read_later"): void {
    this.sent.push({ type: "save", item_id, collection })
  }

  unsave(item_id: string, collection = "read_later"): void {
    this.sent.push({ type: "unsave", item_id, collection })
  }

  act(item_id: string, action: string, text = ""): void {
    this.sent.push({ type: "act", item_id, action, text })
  }

  lookup(item_id: string, entity: string): void {
    this.sent.push({ type: "lookup", item_id, entity })
  }

  highlight(item_id: string, quote = "", note = ""): void {
    this.sent.push({ type: "highlight", item_id, quote, note })
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
  update(items: ViewItem[]): void {
    this.update_listener?.(items, null)
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
