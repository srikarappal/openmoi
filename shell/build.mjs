// Bundles the main process, the three preloads, the chrome UI and the Chrome extension into dist/.
import { cpSync, mkdirSync } from "node:fs"
import { build } from "esbuild"

const common = { bundle: true, logLevel: "warning", target: "es2022" }

mkdirSync("dist/ui", { recursive: true })
mkdirSync("dist/extension", { recursive: true })
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
await build({ ...common, entryPoints: ["src/extension/background.ts"], outfile: "dist/extension/background.js", platform: "browser", format: "esm" })
await build({ ...common, entryPoints: { content: "src/extension/content.ts", popup: "src/extension/popup.ts" }, outdir: "dist/extension", platform: "browser", format: "iife" })
for (const file of ["manifest.json", "popup.html"]) cpSync(`extension/${file}`, `dist/extension/${file}`)
cpSync("src/ui/index.html", "dist/ui/index.html")
cpSync("src/ui/styles.css", "dist/ui/styles.css")
