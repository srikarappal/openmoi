// The static gate: a generated lens is read before it ever runs. Anything that reaches the network, stores data,
// navigates, runs strings as code or reaches for Node is refused, so is markup that loads from elsewhere, item text
// written as HTML and colors that do not come from the shared design tokens. The sandbox still contains whatever
// this misses; the gate turns most mistakes into a clear error the model can fix.

interface Check {
  pattern: RegExp
  problem: string
}

const SCRIPT_CHECKS: Check[] = [
  { pattern: /(?:(?<![\w$.])|\b(?:window|self|globalThis|top|parent)\s*\.\s*)fetch\s*\(/, problem: "uses fetch" },
  { pattern: /\bXMLHttpRequest\b/, problem: "uses XMLHttpRequest" },
  { pattern: /\bWebSocket\b/, problem: "uses WebSocket" },
  { pattern: /\bEventSource\b/, problem: "uses EventSource" },
  { pattern: /\bWebTransport\b/, problem: "uses WebTransport" },
  { pattern: /\bRTCPeerConnection\b/, problem: "uses RTCPeerConnection" },
  { pattern: /\bsendBeacon\b/, problem: "uses navigator.sendBeacon" },
  { pattern: /(?<![\w$.])eval\s*\(/, problem: "uses eval" },
  { pattern: /\bnew\s+Function\b|(?<![\w$.])Function\s*\(/, problem: "builds code from a string with Function" },
  { pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/, problem: "passes code as a string to a timer" },
  { pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b|\bcaches\s*\./, problem: "uses storage" },
  { pattern: /\bdocument\s*\.\s*cookie\b/, problem: "uses cookies" },
  { pattern: /\b(?:window|self|globalThis|top|parent)\s*\.\s*open\s*\(/, problem: "opens windows" },
  { pattern: /(?<![\w$])location\s*(?:=(?!=)|\.\s*(?:href\s*=(?!=)|assign\s*\(|replace\s*\(|reload\s*\())/, problem: "navigates" },
  { pattern: /\bimportScripts\b|(?<![\w$.])import\s*\(/, problem: "imports code" },
  { pattern: /\bnew\s+(?:Shared)?Worker\b|\bserviceWorker\b/, problem: "starts workers" },
  { pattern: /(?<![\w$.])require\s*\(|\bipcRenderer\b|\bprocess\s*\.\s*(?:env|versions|binding|mainModule)\b/, problem: "reaches for Node or Electron" },
  { pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/, problem: "uses document.write" },
  { pattern: /\b(?:inner|outer)HTML\b|\binsertAdjacentHTML\b|\bsetHTMLUnsafe\b|\bcreateContextualFragment\b|\bparseFromString\b|\bsrcdoc\b/, problem: "writes HTML from strings (set text with textContent)" },
]

const MARKUP_CHECKS: Check[] = [
  { pattern: /<[a-z][^>]*\son[a-z]+\s*=/i, problem: "has an inline event handler attribute (use addEventListener)" },
  { pattern: /<\s*(?:form|iframe|frame|frameset|object|embed|portal|base|applet)\b/i, problem: "has a form, frame, object, embed or base tag" },
  { pattern: /<\s*link\b/i, problem: "has a link tag" },
  { pattern: /<\s*script\b[^>]*\bsrc\s*=/i, problem: "loads a script file" },
  { pattern: /<\s*meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i, problem: "refreshes or redirects with a meta tag" },
  { pattern: /\b(?:src|href|action|formaction|poster|srcset|data|ping|background|xlink:href)\s*=\s*["']?\s*(?:https?:|\/\/|ftp:|ws:|wss:)/i, problem: "points at an address elsewhere" },
  { pattern: /url\(\s*["']?\s*(?:https?:|\/\/)/i, problem: "loads CSS from an address elsewhere" },
  { pattern: /@import\b/i, problem: "imports CSS" },
]

const COLOR_PROPERTIES = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|--[\w-]+)$/i
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|\b(?:white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink|brown|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
const STYLE_ATTRIBUTE = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
const DECLARATION = /([\w-]+)\s*:\s*([^;{}]+)/g
const COMMENT = /\/\*[\s\S]*?\*\//g
const MAX_LENS_BYTES = 400_000

function blocks(html: string, pattern: RegExp, group: number): string[] {
  return Array.from(html.matchAll(pattern), (match) => match[group] ?? "")
}

// A declaration such as "color: #333" or "--accent: red": colors come only from the shared tokens.
export function hardcoded_colors(css: string): string[] {
  const found: string[] = []
  for (const match of css.replace(COMMENT, "").matchAll(DECLARATION)) {
    const [property, value] = [match[1], match[2].trim()]
    if (COLOR_PROPERTIES.test(property) && COLOR_LITERAL.test(value)) found.push(`${property}: ${value}`.slice(0, 80))
  }
  return found
}

// Clearing an element with innerHTML = "" writes no HTML, so it is the one use of innerHTML a lens may make.
const CLEARING = /\.innerHTML\s*=\s*(["'`])\1(?=\s*(?:[;,)}\n]|$))/g

// Script text without its comments, so a word in a comment is not mistaken for a call, and without clearing.
export function code_only(script: string): string {
  return script.replace(/\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*/g, " ").replace(CLEARING, ".cleared")
}

// The first problem with a lens, or null when it passes; the message is meant for the model to fix.
export function gate_problem(html: string): string | null {
  if (new TextEncoder().encode(html).length > MAX_LENS_BYTES) return `the lens is larger than ${MAX_LENS_BYTES / 1000} kB`
  const scripts = blocks(html, SCRIPT_BLOCK, 1).map(code_only).join("\n")
  for (const check of SCRIPT_CHECKS) if (check.pattern.test(scripts)) return `the lens ${check.problem}, which lenses may not do`
  for (const check of MARKUP_CHECKS) if (check.pattern.test(html)) return `the lens ${check.problem}, which lenses may not do`
  const css = [...blocks(html, STYLE_BLOCK, 1), ...blocks(html, STYLE_ATTRIBUTE, 2)].join("\n")
  const [color] = hardcoded_colors(css)
  if (color) return `the lens hardcodes a color (${color}); use the shared tokens such as var(--text), var(--muted), var(--accent)`
  return null
}
