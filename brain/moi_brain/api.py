"""HTTP API the shell calls. Thin on purpose: every handler delegates to the Brain."""

import base64
import hmac
from datetime import datetime
from operator import attrgetter
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from moi_brain.apps import Capability
from moi_brain.brain import SEARCH_LIMIT, AppAccess, Brain, CollectionInfo, ContentWanted, LookupStart, MineRequest, MomentKind, Overview, PageSource, PeopleReply, SearchHit, ShopStart, ViewPage, ViewSchedule, WatchReport
from moi_brain.content import MAX_CONTENT
from moi_brain.watch import MAX_WATCH_TEXT
from moi_brain.mirror import Mirror
from moi_brain.compile import BadInput, ViewInfo
from moi_brain.config import ModelChange, ModelInfo
from moi_brain.edits import EditScope, Proposal, StaleProposal
from moi_brain.extractors import ExtractorSpec
from moi_brain.actions import ActionDecision, ActionRequest, ActionResult
from moi_brain.agents import AgentKind, AgentRun
from moi_brain.answers import Answer
from moi_brain.health import RunReport, Verdict
from moi_brain.lens_gen import LensVerdict
from moi_brain.items import Event, Item, ViewItem
from moi_brain.llm import LlmError, PrivacyBlocked
from moi_brain.rank import PAGE_SIZE
from moi_brain.relay import CALL_TIMEOUT_SECONDS, RelayError

router = APIRouter()
LensKind = Literal["feed", "article", "listing"]
MAX_SKELETON = 250_000
MAX_LENS_HTML = 400_000
MAX_SCREENSHOT = 12_000_000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def get_brain(request: Request) -> Brain:
    return request.app.state.brain


def check_token(request: Request, x_moi_token: Annotated[str | None, Header()] = None) -> None:
    """Every request carries the shell's token, compared in constant time and names this server as its host,
    so a web page that rebinds a domain name to 127.0.0.1 is turned away too."""
    if not hmac.compare_digest((x_moi_token or "").encode(), request.app.state.token.encode()):
        raise HTTPException(status_code=401, detail="bad token")
    allowed_hosts = request.app.state.allowed_hosts
    if allowed_hosts and request.headers.get("host") not in allowed_hosts:
        raise HTTPException(status_code=421, detail="wrong host")


BrainDep = Annotated[Brain, Depends(get_brain)]


class RefreshRequest(BaseModel):
    view_id: str
    force: bool = False


class RefreshResponse(BaseModel):
    page_sources: list[PageSource]


class IngestRequest(BaseModel):
    source_id: str
    records: list[dict[str, Any]]
    page_url: str | None = None
    view_id: str | None = None
    kind: LensKind = "listing"


class IngestResponse(BaseModel):
    items: list[Item]
    # Positions of records the source had stored before this call.
    already: list[int] = Field(default_factory=list)
    view_items: list[ViewItem] = Field(default_factory=list)
    lens_stale: bool = False
    layout_hash: str = ""


class FollowsRequest(BaseModel):
    list_url: str
    records: list[dict[str, Any]] = Field(max_length=5000)


class LensGenerateRequest(BaseModel):
    view_id: str
    kind: LensKind = "feed"
    last_error: str | None = Field(default=None, max_length=2000)


class LensAcceptRequest(BaseModel):
    view_id: str
    kind: LensKind = "feed"
    html: str = Field(min_length=1, max_length=MAX_LENS_HTML)
    # The Layout hash the lens was generated for; without it, the Layout's hash now.
    layout_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{8,64}$")


class LensJudgeRequest(BaseModel):
    view_id: str
    kind: LensKind = "feed"
    # A PNG screenshot of the lens with made up items, base64.
    screenshot: str = Field(min_length=1, max_length=MAX_SCREENSHOT)


class ExtractorGenerateRequest(BaseModel):
    url: str
    skeleton: str = Field(min_length=1, max_length=MAX_SKELETON)
    last_error: str | None = Field(default=None, max_length=2000)


class SpecResponse(BaseModel):
    spec: ExtractorSpec | None


class RelayCallRequest(BaseModel):
    op: Literal["open", "run", "close", "url"]
    args: dict[str, Any] = Field(default_factory=dict)
    timeout_s: float = Field(default=CALL_TIMEOUT_SECONDS, gt=0, le=120)


class RelayTrustRequest(BaseModel):
    extension_id: str = Field(pattern=r"^[a-z]{32}$")


class RelayPoll(BaseModel):
    status: dict[str, Any]
    events: list[MineRequest]


class ViewRequest(BaseModel):
    exclude_ids: list[str] = Field(default_factory=list)
    limit: int = Field(default=PAGE_SIZE, ge=1, le=500)


class EventsRequest(BaseModel):
    events: list[Event]


class EditRequest(BaseModel):
    view_id: str
    text: str = Field(min_length=1, max_length=2000)
    item_id: str | None = None
    scope: EditScope = "any"


class NewViewRequest(BaseModel):
    view_id: str = Field(min_length=1, max_length=60)
    title: str | None = Field(default=None, max_length=80)


class ProposalRequest(BaseModel):
    proposal_id: str


class ImportRequest(BaseModel):
    name: str = Field(default="", max_length=200)
    text: str | None = Field(default=None, max_length=200_000)
    url: str | None = Field(default=None, max_length=2000)


class HistoryRequest(BaseModel):
    name: str = Field(max_length=200)
    text: str = Field(max_length=20_000_000)


class ShareRequest(BaseModel):
    view_id: str


class ContentRequest(BaseModel):
    item_id: str
    purpose: Literal["summary", "note", "offline"]
    title: str = Field(default="", max_length=500)
    text: str = Field(default="", max_length=MAX_CONTENT * 2)
    caption_url: str | None = Field(default=None, max_length=2000)


class WatchReportRequest(BaseModel):
    url: str
    title: str = Field(default="", max_length=500)
    text: str = Field(max_length=MAX_WATCH_TEXT * 5)


class MomentRequest(BaseModel):
    view_id: str
    kind: MomentKind


class ScheduleDoneRequest(BaseModel):
    view_id: str
    edition: datetime


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/views")
def list_views(brain: BrainDep) -> list[ViewInfo]:
    return brain.compiler.view_infos()


@router.post("/views")
def create_view(body: NewViewRequest, brain: BrainDep) -> ViewInfo:
    return brain.create_view(body.view_id, body.title)


@router.get("/model")
def model_settings(brain: BrainDep) -> ModelInfo:
    return brain.model_settings()


@router.post("/model")
def update_model(body: ModelChange, brain: BrainDep) -> ModelInfo:
    return brain.update_model(body)


@router.get("/overview/{view_id}")
def overview(view_id: str, brain: BrainDep) -> Overview:
    return brain.overview(view_id)


@router.post("/refresh")
def refresh(body: RefreshRequest, brain: BrainDep) -> RefreshResponse:
    return RefreshResponse(page_sources=brain.start_refresh(body.view_id, body.force))


@router.post("/ingest")
def ingest(body: IngestRequest, brain: BrainDep) -> IngestResponse:
    if body.view_id is None:
        already = brain.already_stored(body.source_id, body.records, body.page_url)
        return IngestResponse(items=brain.ingest(body.source_id, body.records, body.page_url), already=already)
    items, view_items = brain.ingest_page(body.view_id, body.source_id, body.records, body.page_url)
    stale, layout_hash = brain.lens_state(body.view_id, body.kind)
    return IngestResponse(items=items, view_items=view_items, lens_stale=stale, layout_hash=layout_hash)


@router.post("/follows")
def follows(body: FollowsRequest, brain: BrainDep) -> dict[str, int]:
    return {"stored": brain.add_follows(body.list_url, body.records)}


@router.post("/view/{view_id}")
def view_page(view_id: str, body: ViewRequest, brain: BrainDep) -> ViewPage:
    return brain.view_page(view_id, body.exclude_ids, body.limit)


@router.post("/view/{view_id}/early")
def open_early(view_id: str, brain: BrainDep) -> dict[str, str]:
    brain.open_early(view_id)
    return {"status": "open"}


@router.post("/import")
def import_view(body: ImportRequest, brain: BrainDep) -> Proposal:
    return brain.import_view(body.name, body.text, body.url)


@router.post("/google/connect")
def google_connect(brain: BrainDep) -> dict[str, str]:
    return {"auth_url": brain.google_connect()}


@router.get("/google/status")
def google_status(brain: BrainDep) -> dict[str, Any]:
    return brain.google_status()


@router.post("/packs/update")
def update_packs(brain: BrainDep) -> dict[str, str]:
    return {"status": brain.update_packs()}


@router.post("/history")
def import_history(body: HistoryRequest, brain: BrainDep) -> dict[str, Any]:
    source_id, stored = brain.import_history(body.name, body.text)
    return {"source_id": source_id, "stored": stored}


@router.post("/share")
def share_view(body: ShareRequest, brain: BrainDep) -> dict[str, str]:
    return {"path": brain.share_view(body.view_id)}


@router.get("/content/wanted")
def content_wanted(brain: BrainDep, limit: int = 5) -> list[ContentWanted]:
    return brain.content_wanted(min(max(limit, 1), 20))


class ContentResponse(BaseModel):
    status: str
    # The item with its summary, so an open view can show it in place.
    item: Item | None = None


@router.post("/content")
def add_content(body: ContentRequest, brain: BrainDep) -> ContentResponse:
    status = brain.add_content(body.item_id, body.purpose, body.title, body.text, body.caption_url)
    return ContentResponse(status=status, item=brain.store.get_item(body.item_id) if status in ("summarized", "saved") else None)


class SaveRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    item_id: str = Field(min_length=1, max_length=200)
    saved: bool = True


class CollectionViewRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class ExportRequest(BaseModel):
    format: Literal["md", "json"] = "md"
    collection: str | None = Field(default=None, max_length=60)
    view_id: str | None = None


class HighlightRequest(BaseModel):
    item_id: str = Field(min_length=1, max_length=200)
    quote: str = Field(default="", max_length=5000)
    note: str = Field(default="", max_length=5000)


class AgentRequest(BaseModel):
    kind: AgentKind
    request: str = Field(min_length=1, max_length=2000)


class AgentAnswer(BaseModel):
    answer: str = Field(min_length=1, max_length=2000)


@router.post("/agents")
def plan_agent(body: AgentRequest, brain: BrainDep) -> AgentRun:
    return brain.plan_agent(body.kind, body.request)


@router.get("/agents")
def agent_runs(brain: BrainDep) -> list[AgentRun]:
    return sorted(brain.agent_runs.values(), key=attrgetter("created_at"), reverse=True)[:50]


@router.get("/agents/due")
def agents_due(brain: BrainDep) -> list[str]:
    return brain.agents_due()


@router.get("/agents/{plan_id}")
def agent_run(plan_id: str, brain: BrainDep) -> AgentRun:
    return brain.agent_run(plan_id)


@router.post("/agents/{plan_id}/approve")
def approve_agent(plan_id: str, brain: BrainDep) -> AgentRun:
    return brain.approve_agent(plan_id)


@router.post("/agents/{plan_id}/decline")
def decline_agent(plan_id: str, brain: BrainDep) -> AgentRun:
    return brain.decline_agent(plan_id)


@router.post("/agents/{plan_id}/stop")
def stop_agent(plan_id: str, brain: BrainDep) -> AgentRun:
    return brain.stop_agent(plan_id)


@router.post("/agents/{plan_id}/answer")
def answer_agent(plan_id: str, body: AgentAnswer, brain: BrainDep) -> AgentRun:
    return brain.answer_agent(plan_id, body.answer)


@router.get("/proposals/{proposal_id}")
def proposal(proposal_id: str, brain: BrainDep) -> Proposal:
    found = brain.editor.proposals.get(proposal_id)
    if found is None:
        raise HTTPException(status_code=404, detail="no such proposal")
    return found


@router.get("/actions/pending")
def pending_actions(brain: BrainDep) -> list[ActionDecision]:
    return brain.pending_plan_actions()


@router.post("/actions/check")
def check_action(body: ActionRequest, brain: BrainDep) -> ActionDecision:
    return brain.check_action(body)


@router.post("/actions/result")
def action_result(body: ActionResult, brain: BrainDep) -> dict[str, Any]:
    return {"recorded": True, "item": brain.action_result(body)}


@router.get("/actions/log")
def action_log(brain: BrainDep, limit: int = 50) -> list[dict[str, Any]]:
    return brain.audit.entries()[-min(max(limit, 1), 500):]


class ShopRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    view_id: str | None = None


@router.post("/shop")
def shop(body: ShopRequest, brain: BrainDep) -> ShopStart:
    return brain.shop(body.query, body.view_id)


class LookupRequest(BaseModel):
    view_id: str = Field(min_length=1, max_length=100)
    item_id: str = Field(min_length=1, max_length=100)
    entity: str = Field(min_length=1, max_length=100)


@router.post("/lookup")
def lookup(body: LookupRequest, brain: BrainDep) -> LookupStart:
    return brain.lookup(body.view_id, body.item_id, body.entity)


class AllowRequest(BaseModel):
    capability: Capability


@router.get("/apps")
def apps(brain: BrainDep) -> AppAccess:
    return brain.app_access()


@router.post("/apps/allow")
def allow_app(body: AllowRequest, brain: BrainDep) -> AppAccess:
    return brain.allow_app(body.capability)


@router.post("/people/suggest")
def people_suggest(brain: BrainDep) -> PeopleReply:
    return brain.people_reply()


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)


@router.post("/ask")
def ask(body: AskRequest, brain: BrainDep) -> Answer:
    return brain.ask(body.question)


@router.post("/collections")
def save_item(body: SaveRequest, brain: BrainDep) -> CollectionInfo:
    return brain.save_item(body.name, body.item_id, body.saved)


@router.post("/collections/view")
def collection_view(body: CollectionViewRequest, brain: BrainDep) -> ViewInfo:
    return brain.collection_view(body.name)


@router.get("/collections")
def collections(brain: BrainDep) -> list[CollectionInfo]:
    return brain.collections()


@router.post("/export")
def export(body: ExportRequest, brain: BrainDep) -> dict[str, str]:
    return {"path": str(brain.export(body.format, body.collection, body.view_id))}


@router.post("/highlight")
def highlight(body: HighlightRequest, brain: BrainDep) -> dict[str, str]:
    return {"line": brain.highlight(body.item_id, body.quote, body.note)}


@router.get("/watches/due")
def watches_due(brain: BrainDep) -> list[PageSource]:
    return brain.watches_due()


@router.post("/watches/report")
def watch_report(body: WatchReportRequest, brain: BrainDep) -> WatchReport:
    return brain.watch_report(body.url, body.title, body.text)


@router.post("/moments")
def moments(body: MomentRequest, brain: BrainDep) -> dict[str, str]:
    brain.add_moment(body.view_id, body.kind)
    return {"status": "recorded"}


@router.get("/mirror")
def mirror(brain: BrainDep, days: int = 7) -> Mirror:
    return brain.mirror(days)


@router.get("/mirror/weekly")
def weekly_mirror(brain: BrainDep) -> Mirror | None:
    return brain.weekly_mirror()


@router.get("/search")
def search(brain: BrainDep, q: str, limit: int = SEARCH_LIMIT) -> list[SearchHit]:
    return brain.search(q, limit)


@router.get("/schedule")
def schedule(brain: BrainDep) -> list[ViewSchedule]:
    return brain.schedules()


@router.post("/schedule/done")
def schedule_done(body: ScheduleDoneRequest, brain: BrainDep) -> dict[str, str]:
    brain.schedule_done(body.view_id, body.edition)
    return {"status": "done"}


@router.post("/events")
def events(body: EventsRequest, brain: BrainDep) -> dict[str, Any]:
    brain.record_events(body.events)
    return {"recorded": len(body.events), "notes": brain.notes_wanted(body.events)}


@router.post("/edit")
def edit(body: EditRequest, brain: BrainDep) -> Proposal:
    return brain.propose_edit(body.view_id, body.text, body.item_id, body.scope)


@router.post("/edit/apply")
def apply_edit(body: ProposalRequest, brain: BrainDep) -> Proposal:
    return brain.apply_edit(body.proposal_id)


@router.post("/edit/discard")
def discard_edit(body: ProposalRequest, brain: BrainDep) -> dict[str, str]:
    brain.editor.discard(body.proposal_id)
    return {"status": "discarded"}


@router.get("/lens/{view_id}", response_class=HTMLResponse)
def lens(view_id: str, brain: BrainDep, kind: LensKind = "feed") -> str:
    return brain.lens_html(view_id, kind)


@router.post("/lens/generate")
def generate_lens(body: LensGenerateRequest, brain: BrainDep) -> dict[str, str]:
    html, layout_hash = brain.generate_lens(body.view_id, body.kind, body.last_error)
    return {"html": html, "layout_hash": layout_hash}


@router.post("/lens/judge")
def judge_lens(body: LensJudgeRequest, brain: BrainDep) -> LensVerdict:
    try:
        screenshot = base64.b64decode(body.screenshot, validate=True)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="the screenshot is not base64") from error
    if not screenshot.startswith(PNG_SIGNATURE):
        raise HTTPException(status_code=422, detail="the screenshot is not a PNG")
    return brain.judge_lens(body.view_id, body.kind, screenshot)


@router.post("/lens/accept")
def accept_lens(body: LensAcceptRequest, brain: BrainDep) -> dict[str, int]:
    return {"version": brain.accept_lens(body.view_id, body.kind, body.html, body.layout_hash)}


@router.get("/extractor")
def find_extractor(url: str, brain: BrainDep) -> SpecResponse:
    return SpecResponse(spec=brain.best_spec(url))


@router.get("/extractor/previous")
def previous_extractors(url: str, version: int, brain: BrainDep) -> list[ExtractorSpec]:
    return brain.previous_specs(url, version)


@router.post("/extractor/health")
def extractor_health(report: RunReport, brain: BrainDep) -> Verdict:
    return brain.report_extractor(report)


@router.post("/extractor/generate")
def generate_extractor(body: ExtractorGenerateRequest, brain: BrainDep) -> SpecResponse:
    return SpecResponse(spec=brain.generate_extractor(body.url, body.skeleton, body.last_error))


@router.post("/extractor/accept")
def accept_extractor(spec: ExtractorSpec, brain: BrainDep) -> SpecResponse:
    return SpecResponse(spec=brain.extractors.save(spec))


@router.get("/relay/poll")
def relay_poll(brain: BrainDep) -> RelayPoll:
    return RelayPoll(status=brain.relay_status(), events=brain.take_relay_events())


@router.post("/relay/trust")
def relay_trust(body: RelayTrustRequest, brain: BrainDep) -> dict[str, Any]:
    brain.relay.trust(body.extension_id)
    return brain.relay_status()


@router.post("/relay/call")
def relay_call(body: RelayCallRequest, brain: BrainDep) -> dict[str, Any]:
    return {"result": brain.relay.call(body.op, body.args, body.timeout_s)}


@router.get("/debug")
def debug(brain: BrainDep) -> dict[str, Any]:
    return brain.debug()


def privacy_error(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(error), "kind": "privacy"})


def llm_error(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(error), "kind": "llm"})


def relay_error(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(error), "kind": "relay"})


def stale_proposal(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(error), "kind": "stale"})


def bad_input(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(error), "kind": "input"})


def create_app(brain: Brain, token: str, allowed_hosts: set[str] | None = None) -> FastAPI:
    if not token:
        raise ValueError("the brain needs a token; the shell sets MOI_TOKEN")
    app = FastAPI(title="moi_brain", dependencies=[Depends(check_token)])
    app.state.brain = brain
    app.state.token = token
    app.state.allowed_hosts = allowed_hosts
    app.include_router(router)
    app.add_exception_handler(PrivacyBlocked, privacy_error)
    app.add_exception_handler(LlmError, llm_error)
    app.add_exception_handler(BadInput, bad_input)
    app.add_exception_handler(StaleProposal, stale_proposal)
    app.add_exception_handler(RelayError, relay_error)
    return app
