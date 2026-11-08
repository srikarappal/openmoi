"""Shared fixtures: a running fake world, a fresh openMoi home and a brain wired to both."""

import os
import time
from collections.abc import Iterator

import pytest
from fake_services import FakeServices
from fastapi.testclient import TestClient

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import REPO_DIR, Paths, Settings, Slot

TOKEN = "test_token"
FIXTURE_VIEWS = REPO_DIR / "fixtures" / "views"


def fixture_view(name: str, base_url: str) -> str:
    """A view file from fixtures/views with the fake services address filled in."""
    return (FIXTURE_VIEWS / f"{name}.md").read_text().replace("{base_url}", base_url)


def wait_until_refreshed(client: TestClient, view_id: str = "feed", timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        page = client.post(f"/view/{view_id}", json={}).json()
        if not page["refreshing"] or time.monotonic() > deadline:
            return page
        time.sleep(0.05)


def set_time_zone(zone: str | None) -> None:
    """The process's local time zone; None goes back to the system's."""
    if zone is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = zone
    time.tzset()


@pytest.fixture(autouse=True)
def utc_clock() -> Iterator[None]:
    """Every test runs on a UTC clock, so "per day" means the same thing on every machine."""
    previous = os.environ.get("TZ")
    set_time_zone("UTC")
    yield
    set_time_zone(previous)


@pytest.fixture(scope="session")
def services() -> Iterator[FakeServices]:
    running = FakeServices().start()
    yield running
    running.stop()


@pytest.fixture(autouse=True)
def clean_services(services: FakeServices) -> None:
    services.clear()


@pytest.fixture
def paths(tmp_path, services: FakeServices) -> Paths:
    home = tmp_path / "home"
    (home / "views").mkdir(parents=True)
    (home / "views" / "feed.md").write_text(fixture_view("feed", services.base_url))
    return Paths(home=home, assets=REPO_DIR)


@pytest.fixture
def settings(services: FakeServices) -> Settings:
    slot = Slot(base_url=f"{services.base_url}/llm/v1", model="fake")
    return Settings(fast=slot, smart=slot.model_copy())


@pytest.fixture
def brain(paths: Paths, settings: Settings, services: FakeServices) -> Iterator[Brain]:
    created = Brain(paths, settings, youtube_base=services.base_url)
    yield created
    created.http.close()


@pytest.fixture
def client(brain: Brain) -> TestClient:
    return TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
