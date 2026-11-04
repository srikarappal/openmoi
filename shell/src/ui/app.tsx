// The chrome UI: view and web tabs, the address bar and the side panel.
import { useEffect, useState, type FormEvent } from "react"
import { createRoot } from "react-dom/client"
import type { ShellCommand, ShellState } from "../shared/types"

interface ShellBridge {
  command(command: ShellCommand): void
  get_state(): Promise<ShellState>
  on_state(listener: (state: ShellState) => void): void
}

declare global {
  interface Window {
    shell: ShellBridge
  }
}

function send(command: ShellCommand): void {
  window.shell.command(command)
}

function TopBar({ state }: { state: ShellState }) {
  const [address, set_address] = useState(state.address)
  useEffect(() => set_address(state.address), [state.address])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (address.trim()) send({ type: "navigate", url: address.trim() })
  }
  return (
    <header className="top">
      <nav className="tabs">
        {state.views.map((view) => (
          <button
            key={view.view_id}
            className={state.active.kind === "view" && state.active.view_id === view.view_id ? "tab view active" : "tab view"}
            onClick={() => send({ type: "open_view", view_id: view.view_id })}
          >
            {view.title}
          </button>
        ))}
        {state.tabs.length > 0 && <span className="divider" />}
        {state.tabs.map((tab) => (
          <span key={tab.tab_id} className={state.active.kind === "tab" && state.active.tab_id === tab.tab_id ? "tab web active" : "tab web"}>
            <button className="tab_title" title={tab.url} onClick={() => send({ type: "select_tab", tab_id: tab.tab_id })}>
              {tab.title || tab.url || "New tab"}
            </button>
            <button className="close" aria-label="Close tab" onClick={() => send({ type: "close_tab", tab_id: tab.tab_id })}>
              ×
            </button>
          </span>
        ))}
      </nav>
      <form className="address" onSubmit={submit}>
        <input value={address} placeholder="Type a URL or search" onChange={(event) => set_address(event.target.value)} />
      </form>
      <button className="action" onClick={() => send({ type: "refresh" })}>
        Refresh
      </button>
    </header>
  )
}

function SidePanel({ state }: { state: ShellState }) {
  return (
    <aside className="side">
      <section className="notices">
        {state.notices.map((notice) => (
          <div key={notice.notice_id} className="notice">
            <span>{notice.text}</span>
            <span className="notice_actions">
              {notice.url && <button onClick={() => send({ type: "open_notice", notice_id: notice.notice_id })}>Open</button>}
              <button onClick={() => send({ type: "dismiss_notice", notice_id: notice.notice_id })}>Dismiss</button>
            </span>
          </div>
        ))}
      </section>
    </aside>
  )
}

function App() {
  const [state, set_state] = useState<ShellState | null>(null)
  useEffect(() => {
    window.shell.on_state(set_state)
    window.shell.get_state().then(set_state)
  }, [])
  if (!state) return <div className="loading">Starting openMoi</div>
  return (
    <>
      <TopBar state={state} />
      <SidePanel state={state} />
    </>
  )
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />)
