// The extraction interpreter: runs a declarative ExtractorSpec against any DOM and returns raw records.
import type { ExtractorSpec, FieldRule, RawRecord } from "./types"

export function extract_records(root: ParentNode, spec: ExtractorSpec, page_url: string): RawRecord[] {
  const records: RawRecord[] = []
  for (const element of Array.from(root.querySelectorAll(spec.item_root))) {
    const record = extract_record(element, spec, page_url)
    if (record) records.push(record)
  }
  return records
}

// One record per item root, or null when a required field is missing.
export function extract_record(element: Element, spec: ExtractorSpec, page_url: string): RawRecord | null {
  const record: RawRecord = {}
  for (const [name, rule] of Object.entries(spec.fields)) {
    const value = read_field(element, rule, page_url)
    if (value !== null) record[name] = value
    else if (!rule.optional) return null
  }
  const native_id = spec.native_id ? read_field(element, spec.native_id, page_url) : null
  if (native_id) record.native_id = native_id
  return record
}

export function read_field(element: Element, rule: FieldRule, page_url: string): string | null {
  const target = rule.select === ":scope" ? element : element.querySelectorAll(rule.select)[rule.nth ?? 0]
  if (!target) return null
  const raw = take_value(target, rule.take)
  if (raw === null) return null
  const value = apply_transform(raw.replace(/\s+/g, " ").trim(), rule.transform ?? null, page_url)
  return value ? value : null
}

function take_value(target: Element, take: string): string | null {
  if (take === "text") return target.textContent
  if (take.startsWith("attr:")) return target.getAttribute(take.slice(5))
  if (take.startsWith("const:")) return take.slice(6)
  return null
}

export function apply_transform(value: string, transform: string | null, page_url: string): string | null {
  if (!transform) return value
  if (transform === "absolute_url") return absolute_url(value, page_url)
  if (transform === "iso_datetime") {
    const moment = Date.parse(value)
    return Number.isNaN(moment) ? null : new Date(moment).toISOString()
  }
  if (transform.startsWith("regex:")) {
    const match = safe_regex(transform.slice(6))?.exec(value)
    return match ? (match[1] ?? match[0]) : null
  }
  if (transform.startsWith("strip_prefix:")) {
    const prefix = transform.slice("strip_prefix:".length)
    return value.startsWith(prefix) ? value.slice(prefix.length) : value
  }
  return value
}

function safe_regex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

function absolute_url(value: string, page_url: string): string | null {
  try {
    return new URL(value, page_url).toString()
  } catch {
    return null
  }
}

// A listing extraction is usable when at least three records carry a title or text and a URL.
export function is_good_extraction(records: RawRecord[]): boolean {
  return records.filter((record) => record.url && (record.title || record.text)).length >= 3
}
