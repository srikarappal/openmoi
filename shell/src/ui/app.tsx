// The chrome UI: view and web tabs, the address bar and the side panel.
import { useEffect, useRef, useState, type FormEvent } from "react"
import { createRoot } from "react-dom/client"
import { matching_commands } from "../shared/commands"
import type { Activity, ChatEntry, ShellCommand, ShellState } from "../shared/types"

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
  const active_tab = state.active.kind === "tab" ? state.tabs.find((tab) => state.active.kind === "tab" && tab.tab_id === state.active.tab_id) : undefined
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
        {state.tabs.length + state.chrome_pages.length > 0 && <span className="divider" />}
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
        {state.chrome_pages.map((page) => (
          <span key={page.page_id} className={state.active.kind === "chrome" && state.active.page_id === page.page_id ? "tab chrome active" : "tab chrome"}>
            <button className="tab_title" title={page.url} onClick={() => send({ type: "select_chrome_page", page_id: page.page_id })}>
              Mine: {page.title}
            </button>
            <button className="close" aria-label="Close" onClick={() => send({ type: "close_chrome_page", page_id: page.page_id })}>
              ×
            </button>
          </span>
        ))}
      </nav>
      <span className={state.relay.connected ? "relay on" : "relay"} title="openMoi reads pages through your Chrome when the extension is connected">
        {state.relay.connected ? "Chrome connected" : state.relay.waiting_for_approval ? "Chrome waiting" : "Chrome not connected"}
      </span>
      <form className="address" onSubmit={submit}>
        <input value={address} placeholder="Type a URL or search" onChange={(event) => set_address(event.target.value)} />
      </form>
      {active_tab && (
        <button className={active_tab.mine ? "action mine on" : "action mine"} title="Your version of this page" onClick={() => send({ type: "toggle_mine" })}>
          Mine
        </button>
      )}
      <button className="action" onClick={() => send({ type: "refresh" })}>
        Refresh
      </button>
    </header>
  )
}

function diff_class(line: string): string {
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-")) return "remove"
  return "same"
}

function DiffView({ file, diff }: { file: string; diff: string }) {
  const lines = diff.split("\n").filter((line) => !/^(---|\+\+\+|@@)/.test(line))
  return (
    <div className="diff">
      <div className="diff_file">{file}</div>
      {lines.map((line, index) => (
        <div key={index} className={diff_class(line)}>
          {line || " "}
        </div>
      ))}
    </div>
  )
}

function ChatMessage({ entry }: { entry: ChatEntry }) {
  const proposal = entry.proposal
  return (
    <div className={`message ${entry.role}`}>
      <div className="message_text">{entry.text}</div>
      {proposal && (
        <div className="proposal">
          {proposal.changes.map((change) => (
            <DiffView key={change.file} file={change.file} diff={change.diff} />
          ))}
          {proposal.lens_action === "rollback" && <div className="lens_action">Bring back the previous look</div>}
          {entry.status === "pending" ? (
            <div className="proposal_actions">
              <button className="confirm" onClick={() => send({ type: "proposal_apply", proposal_id: proposal.proposal_id })}>
                Confirm
              </button>
              <button onClick={() => send({ type: "proposal_discard", proposal_id: proposal.proposal_id })}>Discard</button>
            </div>
          ) : (
            <div className={`proposal_status ${entry.status}`}>{entry.status}</div>
          )}
        </div>
      )}
    </div>
  )
}

function CommandHints({ text, pick }: { text: string; pick: (name: string) => void }) {
  const hints = matching_commands(text)
  if (!hints.length) return null
  return (
    <div className="hints">
      {hints.map((hint) => (
        <button key={hint.name} type="button" className="hint" onClick={() => pick(hint.name)}>
          <span className="hint_usage">{hint.usage}</span>
          <span className="hint_summary">{hint.summary}</span>
        </button>
      ))}
    </div>
  )
}

// New replies, proposals and "new look is live" land at the bottom, so the chat follows them there.
function Chat({ state }: { state: ShellState }) {
  const [text, set_text] = useState("")
  const messages = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (messages.current) messages.current.scrollTop = messages.current.scrollHeight
  }, [state.chat.length, state.thinking])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim()) return
    send({ type: "chat_send", text: text.trim() })
    set_text("")
  }
  return (
    <section className="chat">
      <div className="messages" ref={messages}>
        {state.chat.map((entry) => (
          <ChatMessage key={entry.entry_id} entry={entry} />
        ))}
        {state.thinking && <div className="message moi thinking">Thinking</div>}
      </div>
      <form className="composer" onSubmit={submit}>
        <CommandHints text={text} pick={(name) => set_text(`${name} `)} />
        <div className="chat_view">Changes apply to {state.chat_view}</div>
        <input value={text} placeholder="Tell openMoi what you want, or type / for commands" onChange={(event) => set_text(event.target.value)} />
      </form>
    </section>
  )
}

// Ticks once a second while something runs, so elapsed times move.
function use_now(ticking: boolean): number {
  const [now, set_now] = useState(Date.now())
  useEffect(() => {
    if (!ticking) return
    set_now(Date.now())
    const timer = setInterval(() => set_now(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

// What openMoi is doing right now: the model thinking, a new look being designed, sources being read.
function StatusLine({ activities }: { activities: Activity[] }) {
  const now = use_now(activities.length > 0)
  if (!activities.length) return <section className="status idle">Idle</section>
  return (
    <section className="status" aria-live="polite">
      {activities.map((activity) => (
        <div key={activity.activity_id} className="activity">
          <span className="pulse" />
          <span className="activity_label">{activity.label}</span>
          <span className="elapsed">{Math.max(0, Math.round((now - activity.started_at) / 1000))} s</span>
        </div>
      ))}
    </section>
  )
}

function SidePanel({ state }: { state: ShellState }) {
  return (
    <aside className="side">
      <StatusLine activities={state.activities} />
      <section className="notices">
        {state.notices.map((notice) => (
          <div key={notice.notice_id} className="notice">
            <span>{notice.text}</span>
            <span className="notice_actions">
              {notice.action && <button onClick={() => notice.action && send(notice.action.command)}>{notice.action.label}</button>}
              {notice.url && <button onClick={() => send({ type: "open_notice", notice_id: notice.notice_id })}>Open</button>}
              <button onClick={() => send({ type: "dismiss_notice", notice_id: notice.notice_id })}>Dismiss</button>
            </span>
          </div>
        ))}
      </section>
      <Chat state={state} />
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
