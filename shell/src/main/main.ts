// Electron entry: start the brain, configure sessions, open the window.
import path from "node:path"
import { app } from "electron"
import { BrainProcess } from "./brain"
import { configure_sessions } from "./sessions"
import { Shell } from "./shell"

const DIST_DIR = __dirname
const REPO_DIR = path.resolve(__dirname, "..", "..")

let brain_process: BrainProcess | null = null

async function launch(): Promise<void> {
  configure_sessions()
  brain_process = await BrainProcess.start(REPO_DIR)
  await new Shell(brain_process.client, DIST_DIR, process.env.MOI_HEADLESS === "1").start()
}

function stop_brain(): void {
  brain_process?.stop()
}

function fail(error: unknown): void {
  console.error(`openMoi failed to start: ${error}`)
  stop_brain()
  app.quit()
}

app.whenReady().then(launch).catch(fail)
app.on("window-all-closed", () => app.quit())
app.on("before-quit", stop_brain)
