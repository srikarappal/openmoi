"""HTTP API the shell calls. Thin on purpose: every handler delegates to the Brain."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from moi_brain.brain import Brain, PageSource, ViewPage
from moi_brain.compile import BadInput, ViewInfo
from moi_brain.edits import Proposal
from moi_brain.items import Event, Item
from moi_brain.llm import LlmError, PrivacyBlocked
from moi_brain.rank import PAGE_SIZE

router = APIRouter()


def get_brain(request: Request) -> Brain:
    return request.app.state.brain


def check_token(request: Request, x_moi_token: Annotated[str | None, Header()] = None) -> None:
    expected = request.app.state.token
    if expected and x_moi_token != expected:
        raise HTTPException(status_code=401, detail="bad token")


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


class IngestResponse(BaseModel):
    items: list[Item]


class ViewRequest(BaseModel):
    exclude_ids: list[str] = Field(default_factory=list)
    limit: int = PAGE_SIZE


class EventsRequest(BaseModel):
    events: list[Event]


class EditRequest(BaseModel):
    view_id: str
    text: str = Field(min_length=1, max_length=2000)
    item_id: str | None = None


class ProposalRequest(BaseModel):
    proposal_id: str


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/views")
def list_views(brain: BrainDep) -> list[ViewInfo]:
    return brain.compiler.view_infos()


@router.post("/refresh")
def refresh(body: RefreshRequest, brain: BrainDep) -> RefreshResponse:
    return RefreshResponse(page_sources=brain.start_refresh(body.view_id, body.force))


@router.post("/ingest")
def ingest(body: IngestRequest, brain: BrainDep) -> IngestResponse:
    return IngestResponse(items=brain.ingest(body.source_id, body.records, body.page_url))


@router.post("/view/{view_id}")
def view_page(view_id: str, body: ViewRequest, brain: BrainDep) -> ViewPage:
    return brain.view_page(view_id, body.exclude_ids, body.limit)


@router.post("/events")
def events(body: EventsRequest, brain: BrainDep) -> dict[str, int]:
    brain.record_events(body.events)
    return {"recorded": len(body.events)}


@router.post("/edit")
def edit(body: EditRequest, brain: BrainDep) -> Proposal:
    return brain.propose_edit(body.view_id, body.text, body.item_id)


@router.post("/edit/apply")
def apply_edit(body: ProposalRequest, brain: BrainDep) -> Proposal:
    return brain.apply_edit(body.proposal_id)


@router.post("/edit/discard")
def discard_edit(body: ProposalRequest, brain: BrainDep) -> dict[str, str]:
    brain.editor.discard(body.proposal_id)
    return {"status": "discarded"}


@router.get("/lens/{view_id}", response_class=HTMLResponse)
def lens(view_id: str, brain: BrainDep, kind: Literal["feed", "article", "listing"] = "feed") -> str:
    return brain.lens_html(view_id, kind)


@router.get("/debug")
def debug(brain: BrainDep) -> dict[str, Any]:
    return brain.debug()


def privacy_error(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(error), "kind": "privacy"})


def llm_error(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(error), "kind": "llm"})


def bad_input(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(error), "kind": "input"})


def create_app(brain: Brain, token: str | None = None) -> FastAPI:
    app = FastAPI(title="moi_brain", dependencies=[Depends(check_token)])
    app.state.brain = brain
    app.state.token = token
    app.include_router(router)
    app.add_exception_handler(PrivacyBlocked, privacy_error)
    app.add_exception_handler(LlmError, llm_error)
    app.add_exception_handler(BadInput, bad_input)
    return app
