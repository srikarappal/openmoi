"""HTTP API the shell calls. Thin on purpose: every handler delegates to the Brain."""

import hmac
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from moi_brain.brain import Brain, MineRequest, Overview, PageSource, ViewPage, ViewSchedule
from moi_brain.compile import BadInput, ViewInfo
from moi_brain.config import ModelChange, ModelInfo
from moi_brain.edits import EditScope, Proposal, StaleProposal
from moi_brain.extractors import ExtractorSpec
from moi_brain.items import Event, Item, ViewItem
from moi_brain.llm import LlmError, PrivacyBlocked
from moi_brain.rank import PAGE_SIZE
from moi_brain.relay import CALL_TIMEOUT_SECONDS, RelayError

router = APIRouter()
LensKind = Literal["feed", "article", "listing"]
MAX_SKELETON = 250_000
MAX_LENS_HTML = 400_000


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
    view_items: list[ViewItem] = Field(default_factory=list)
    lens_stale: bool = False
    layout_hash: str = ""


class LensGenerateRequest(BaseModel):
    view_id: str
    kind: LensKind = "feed"
    last_error: str | None = Field(default=None, max_length=2000)


class LensAcceptRequest(BaseModel):
    view_id: str
    kind: LensKind = "feed"
    html: str = Field(min_length=1, max_length=MAX_LENS_HTML)


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
    limit: int = PAGE_SIZE


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
        return IngestResponse(items=brain.ingest(body.source_id, body.records, body.page_url))
    items, view_items = brain.ingest_page(body.view_id, body.source_id, body.records, body.page_url)
    stale, layout_hash = brain.lens_state(body.view_id, body.kind)
    return IngestResponse(items=items, view_items=view_items, lens_stale=stale, layout_hash=layout_hash)


@router.post("/view/{view_id}")
def view_page(view_id: str, body: ViewRequest, brain: BrainDep) -> ViewPage:
    return brain.view_page(view_id, body.exclude_ids, body.limit)


@router.get("/schedule")
def schedule(brain: BrainDep) -> list[ViewSchedule]:
    return brain.schedules()


@router.post("/schedule/done")
def schedule_done(body: ScheduleDoneRequest, brain: BrainDep) -> dict[str, str]:
    brain.schedule_done(body.view_id, body.edition)
    return {"status": "done"}


@router.post("/events")
def events(body: EventsRequest, brain: BrainDep) -> dict[str, int]:
    brain.record_events(body.events)
    return {"recorded": len(body.events)}


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
    return {"html": brain.generate_lens(body.view_id, body.kind, body.last_error)}


@router.post("/lens/accept")
def accept_lens(body: LensAcceptRequest, brain: BrainDep) -> dict[str, int]:
    return {"version": brain.accept_lens(body.view_id, body.kind, body.html)}


@router.get("/extractor")
def find_extractor(url: str, brain: BrainDep) -> SpecResponse:
    return SpecResponse(spec=brain.extractors.for_url(url))


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
