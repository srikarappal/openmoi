// Bundles the main process, the three preloads and the chrome UI into dist/.
import { cpSync, mkdirSync } from "node:fs"
import { build } from "esbuild"

const common = { bundle: true, logLevel: "warning", target: "es2022" }

mkdirSync("dist/ui", { recursive: true })
await build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.js", platform: "node", format: "cjs", external: ["electron"] })
await build({
  ...common,
  entryPoints: { preload_page: "src/preload/page.ts", preload_lens: "src/preload/lens.ts", preload_chrome: "src/preload/chrome.ts" },
  outdir: "dist",
  platform: "browser",
  format: "cjs",
  external: ["electron"],
})
await build({ ...common, entryPoints: ["src/ui/app.tsx"], outfile: "dist/ui/app.js", platform: "browser", format: "iife", jsx: "automatic" })
cpSync("src/ui/index.html", "dist/ui/index.html")
cpSync("src/ui/styles.css", "dist/ui/styles.css")
