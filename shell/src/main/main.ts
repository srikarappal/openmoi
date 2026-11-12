// Electron entry: start the brain, configure sessions, open the window.
import path from "node:path"
import { app, dialog } from "electron"
import { BrainProcess } from "./brain"
import { configure_sessions } from "./sessions"
import { Shell } from "./shell"

const DIST_DIR = __dirname
const REPO_DIR = path.resolve(__dirname, "..", "..")

let brain_process: BrainProcess | null = null
let window_shell: Shell | null = null

// Started at login, openMoi reads on schedule without putting a window in front of you.
async function launch(): Promise<void> {
  configure_sessions()
  brain_process = await BrainProcess.start(REPO_DIR)
  window_shell = new Shell(brain_process.client, DIST_DIR, process.env.MOI_HEADLESS === "1", app.getLoginItemSettings().wasOpenedAtLogin === true)
  await window_shell.start()
}

function quitting(): void {
  if (window_shell) window_shell.quitting = true
  stop_brain()
}

function stop_brain(): void {
  brain_process?.stop()
}

// The reason goes in a dialog as well as the terminal: started from the Dock there is no terminal to read.
function fail(error: unknown): void {
  console.error(`openMoi failed to start: ${error}`)
  dialog.showErrorBox("openMoi could not start", error instanceof Error ? error.message : String(error))
  stop_brain()
  app.quit()
}

app.whenReady().then(launch).catch(fail)
app.on("window-all-closed", () => app.quit())
app.on("before-quit", quitting)
// Clicking openMoi in the Dock brings back a window hidden while it reads in the background.
app.on("activate", () => window_shell?.show())
