// The chrome UI: view and web tabs, the address bar and the side panel.
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type MouseEvent } from "react"
import { createRoot } from "react-dom/client"
import { linked_parts, matching_commands } from "../shared/commands"
import type { Activity, AgentRun, ChatEntry, GateChoice, OmniHit, ShellCommand, ShellState, StopScreen } from "../shared/types"

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

// What you type in the address bar searches your own items once you pause this long.
const OMNIBOX_DELAY_MS = 200

function send(command: ShellCommand): void {
  window.shell.command(command)
}

function TopBar({ state }: { state: ShellState }) {
  const active_tab = state.active.kind === "tab" ? state.tabs.find((tab) => state.active.kind === "tab" && tab.tab_id === state.active.tab_id) : undefined
  const [address, set_address] = useState(state.address)
  const [typed, set_typed] = useState(false)
  useEffect(() => set_address(state.address), [state.address])
  // What you type searches your own items and views first, once you pause.
  useEffect(() => {
    if (!typed) return
    const timer = setTimeout(() => send({ type: "omnibox", text: address }), OMNIBOX_DELAY_MS)
    return () => clearTimeout(timer)
  }, [address, typed])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    set_typed(false)
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
        {state.relay.connected ? "Chrome connected" : state.relay.waiting_for_approval ? "Chrome waiting" : state.relay.unrecognized ? "Chrome: pair again" : "Chrome not connected"}
      </span>
      <form className="address" onSubmit={submit}>
        <input
          value={address}
          placeholder="Type a URL or search"
          onChange={(event) => {
            set_typed(true)
            set_address(event.target.value)
          }}
        />
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

const PLAN_STATUS: Record<AgentRun["status"], string> = {
  proposed: "Waiting for your approval",
  running: "Running",
  paused: "Waiting for your answer",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
  declined: "Not run",
}

function Linked({ text }: { text: string }) {
  return (
    <>
      {linked_parts(text).map((part, index) =>
        part.url ? (
          <a key={index} href={part.url} onClick={(event) => open_link(event, part.url ?? "")}>
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  )
}

// A plan an agent made: what it will do and its budget before it runs, its steps as they happen, then its result.
function PlanCard({ plan }: { plan: AgentRun }) {
  const [answer, set_answer] = useState("")
  const budget = `${plan.budget.max_steps} steps, ${plan.budget.max_seconds} s, $${plan.budget.max_cost_usd.toFixed(2)} at most; expires ${new Date(plan.expires_at).toLocaleString()}`
  return (
    <div className="plan">
      <div className="plan_summary">{plan.summary}</div>
      <div className="plan_status">
        {PLAN_STATUS[plan.status]}
        {plan.reason ? ` (${plan.reason})` : ""}
      </div>
      <ol className="plan_steps">
        {plan.steps.map((step, index) => {
          const done = plan.trace.find((entry) => entry.step === index + 1)
          return (
            <li key={index} className={done ? (done.ok ? "step done" : "step failed") : "step"}>
              <span className="step_tool">{step.tool.replaceAll("_", " ")}</span> <span className="step_why">{step.why}</span>
              {done && <span className="step_outcome"> : {done.outcome}</span>}
            </li>
          )
        })}
      </ol>
      <div className="plan_budget">{budget}</div>
      {plan.status === "paused" && (
        <form
          className="plan_answer"
          onSubmit={(event) => {
            event.preventDefault()
            if (answer.trim()) send({ type: "answer_plan", plan_id: plan.plan_id, answer: answer.trim() })
          }}
        >
          <label>
            {plan.question}
            <input value={answer} onChange={(event) => set_answer(event.target.value)} />
          </label>
          <button type="submit">Answer</button>
        </form>
      )}
      {plan.result && (
        <div className="plan_result">
          <div className="result_answer">
            <Linked text={plan.result.answer} />
          </div>
          {plan.result.citations.map((citation) => (
            <div key={citation.number} className="result_citation">
              <Linked text={`[${citation.number}] ${citation.title} ${citation.url}`} />
            </div>
          ))}
          {plan.result.shortlist.map((entry) => (
            <div key={entry.item_id} className="result_pick">
              <Linked text={`${entry.title}: ${entry.why} ${entry.url}`} />
            </div>
          ))}
        </div>
      )}
      <div className="plan_actions">
        {plan.status === "proposed" && (
          <>
            <button className="primary approve" onClick={() => send({ type: "approve_plan", plan_id: plan.plan_id })}>
              Approve and run
            </button>
            <button className="decline" onClick={() => send({ type: "decline_plan", plan_id: plan.plan_id })}>
              Cancel
            </button>
          </>
        )}
        {(plan.status === "running" || plan.status === "paused" || (plan.kind === "watch" && plan.status === "done" && plan.next_run_at)) && (
          <button className="stop" onClick={() => send({ type: "stop_plan", plan_id: plan.plan_id })}>
            Stop
          </button>
        )}
      </div>
    </div>
  )
}

function open_link(event: MouseEvent, url: string): void {
  event.preventDefault()
  send({ type: "open_link", url })
}

function ChatMessage({ entry }: { entry: ChatEntry }) {
  const proposal = entry.proposal
  return (
    <div className={`message ${entry.role}`}>
      <div className="message_text">
        {linked_parts(entry.text).map((part, index) =>
          part.url ? (
            <a key={index} href={part.url} onClick={(event) => open_link(event, part.url ?? "")}>
              {part.text}
            </a>
          ) : (
            part.text
          ),
        )}
      </div>
      {entry.plan && <PlanCard plan={entry.plan} />}
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
const MAX_VIEW_BYTES = 200_000
const MAX_EXPORT_BYTES = 20_000_000

// What a file dropped on the chat is: a view file (.md, .txt), a data export (.json, .csv) or nothing to take.
function dropped(event: DragEvent): { file: File; type: "import_view" | "import_history" } | null {
  const file = event.dataTransfer.files[0]
  if (file && file.size <= MAX_VIEW_BYTES && /\.(md|txt)$/i.test(file.name)) return { file, type: "import_view" }
  if (file && file.size <= MAX_EXPORT_BYTES && /\.(json|csv)$/i.test(file.name)) return { file, type: "import_history" }
  return null
}

function Chat({ state }: { state: ShellState }) {
  const [text, set_text] = useState("")
  const [dragging, set_dragging] = useState(false)
  const messages = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (messages.current) messages.current.scrollTop = messages.current.scrollHeight
  }, [state.chat.at(-1)?.entry_id, state.thinking])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim()) return
    send({ type: "chat_send", text: text.trim() })
    set_text("")
  }
  const drag_over = (event: DragEvent) => {
    event.preventDefault()
    set_dragging(true)
  }
  const drop = (event: DragEvent) => {
    event.preventDefault()
    set_dragging(false)
    const found = dropped(event)
    if (found) found.file.text().then((content) => send({ type: found.type, name: found.file.name, text: content }))
  }
  return (
    <section className={dragging ? "chat dragging" : "chat"} onDragOver={drag_over} onDragLeave={() => set_dragging(false)} onDrop={drop}>
      {dragging && <div className="drop_hint">Drop a view file, or a data export from Facebook or Amazon</div>}
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

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function choice_note(choice: GateChoice): string {
  const parts = []
  if (choice.visit_minutes) parts.push(`${choice.visit_minutes} minute visit`)
  if (choice.next_edition) parts.push(`next edition ${clock(choice.next_edition)}`)
  return parts.join(", ")
}

// "Why are you here?": opening openMoi starts from what you came for, not from a feed.
function Gate({ choices }: { choices: GateChoice[] }) {
  return (
    <main className="content gate">
      <h1>Why are you here?</h1>
      <div className="choices">
        {choices.map((choice) => (
          <button key={choice.view_id} type="button" className="choice" onClick={() => send({ type: "choose_view", view_id: choice.view_id })}>
            <span className="choice_title">{choice.title}</span>
            {choice_note(choice) && <span className="choice_note">{choice_note(choice)}</span>}
          </button>
        ))}
      </div>
    </main>
  )
}

// The end of a visit: what you read, and a choice to stop or take a few more minutes.
function Stop({ stop }: { stop: StopScreen }) {
  return (
    <main className="content stop">
      <h1>
        Your {stop.minutes} minute{stop.minutes === 1 ? "" : "s"} in {stop.title} {stop.minutes === 1 ? "is" : "are"} up.
      </h1>
      {stop.read.length ? (
        <div className="read">
          <p>You read:</p>
          <ul>
            {stop.read.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>You did not stop on anything this time.</p>
      )}
      {stop.next_edition && <p className="next">The next edition comes out at {clock(stop.next_edition)}.</p>}
      <div className="stop_actions">
        <button type="button" className="primary" onClick={() => send({ type: "end_visit" })}>
          Done
        </button>
        <button type="button" onClick={() => send({ type: "extend_visit" })}>
          5 more minutes
        </button>
      </div>
    </main>
  )
}

function OmniboxResults({ state }: { state: ShellState }) {
  const omnibox = state.omnibox
  if (!omnibox?.hits.length) return null
  const choose = (hit: OmniHit) => {
    send(hit.target.kind === "view" ? { type: "open_view", view_id: hit.target.view_id } : { type: "open_link", url: hit.target.url })
    send({ type: "omnibox", text: "" })
  }
  return (
    <section className="omnibox" aria-label={`Yours for ${omnibox.query}`}>
      <div className="omnibox_title">Yours for "{omnibox.query}"</div>
      {omnibox.hits.map((hit, index) => (
        <button key={index} className="omni_hit" onClick={() => choose(hit)}>
          <span className="omni_label">{hit.label}</span>
          <span className="omni_detail">{hit.detail}</span>
        </button>
      ))}
      <div className="omnibox_hint">Press Enter to search the web instead.</div>
    </section>
  )
}

// What an action will say and where, word for word, before it is done for you.
function ConfirmSheet({ state }: { state: ShellState }) {
  const decision = state.confirm
  if (!decision) return null
  return (
    <section className="confirm_sheet" aria-label={`Confirm: ${decision.label}`}>
      <div className="confirm_title">
        {decision.label} on {decision.site}, as you
      </div>
      <div className="confirm_target">{decision.title}</div>
      {decision.text && <blockquote className="confirm_text">{decision.text}</blockquote>}
      <div className="confirm_note">openMoi does this in a tab on the real page, where you can watch it.</div>
      <div className="confirm_actions">
        <button className="confirm primary" onClick={() => send({ type: "confirm_action", request_id: decision.request_id })}>
          {decision.label}
        </button>
        <button className="decline" onClick={() => send({ type: "decline_action", request_id: decision.request_id })}>
          Cancel
        </button>
      </div>
    </section>
  )
}

function PlayerBar({ state }: { state: ShellState }) {
  if (!state.player) return null
  return (
    <div className="player_bar">
      <span className="player_title">Playing: {state.player.title}</span>
      <button onClick={() => send({ type: "open_link", url: state.player?.url ?? "" })}>Open on YouTube</button>
      <button className="close_player" onClick={() => send({ type: "close_player" })}>
        Close
      </button>
    </div>
  )
}

function SidePanel({ state }: { state: ShellState }) {
  return (
    <aside className="side">
      <StatusLine activities={state.activities} />
      <ConfirmSheet state={state} />
      <OmniboxResults state={state} />
      <PlayerBar state={state} />
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
      {state.stop ? <Stop stop={state.stop} /> : state.gate && <Gate choices={state.gate} />}
      <SidePanel state={state} />
    </>
  )
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />)
