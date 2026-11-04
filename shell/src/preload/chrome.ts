// Preload for the chrome UI: commands go to the main process, state comes back.
import { contextBridge, ipcRenderer } from "electron"
import type { ShellCommand, ShellState } from "../shared/types"

contextBridge.exposeInMainWorld("shell", {
  command: (command: ShellCommand) => ipcRenderer.send("moi:command", command),
  get_state: (): Promise<ShellState> => ipcRenderer.invoke("moi:get_state"),
  on_state: (listener: (state: ShellState) => void) => {
    ipcRenderer.on("moi:state", (_event, state: ShellState) => listener(state))
  },
})
