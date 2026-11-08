"""Starting the brain: paths from the environment, config.json that is missing or broken, the relay and the server."""

import json
import sys

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient

from moi_brain import __main__ as entry
from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import REPO_DIR, Settings, SettingsFileError, ensure_home, load_paths, load_settings
from moi_brain.relay import RelayHub


class ServerRecorder:
    """Stands in for uvicorn.run and keeps what the brain would serve."""

    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, app, host: str, port: int, log_level: str) -> None:
        self.calls.append({"app": app, "host": host, "port": port, "log_level": log_level})


def refuse_port(hub: RelayHub, port: int) -> int:
    raise OSError(f"port {port} is taken")


@pytest.fixture
def started(tmp_path, monkeypatch):
    """Runs main() against a throwaway home with the server stubbed; yields the recorder."""
    monkeypatch.setenv("MOI_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("MOI_ASSETS_DIR", str(REPO_DIR))
    monkeypatch.setenv("MOI_RELAY_PORT", "0")
    monkeypatch.setenv("MOI_TOKEN", TOKEN)
    monkeypatch.setattr(sys, "argv", ["moi_brain", "--port", "8799"])
    recorder = ServerRecorder()
    monkeypatch.setattr(entry.uvicorn, "run", recorder)
    yield recorder
    for call in recorder.calls:
        call["app"].state.brain.relay.stop()
        call["app"].state.brain.http.close()


def test_load_paths_reads_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("MOI_HOME", str(tmp_path / "mine"))
    monkeypatch.setenv("MOI_ASSETS_DIR", str(tmp_path / "assets"))
    paths = load_paths()
    assert (paths.home, paths.assets) == (tmp_path / "mine", tmp_path / "assets")


def test_missing_config_is_created_with_defaults(paths):
    paths.state.mkdir(parents=True, exist_ok=True)
    settings = load_settings(paths)
    assert settings == Settings()
    assert json.loads(paths.settings_file.read_text())["allow_content_to_hosted"] is False
    assert load_settings(paths) == settings


@pytest.mark.parametrize("broken", ["{not json", '{"fast": {"base_url": "x"}}', "[]"])
def test_a_broken_config_names_the_file_and_the_way_out(paths, broken):
    paths.state.mkdir(parents=True, exist_ok=True)
    paths.settings_file.write_text(broken)
    with pytest.raises(SettingsFileError, match=r"\.moi/config\.json could not be read .*run /model"):
        load_settings(paths)
    assert paths.settings_file.read_text() == broken


def test_the_config_problem_shows_until_model_saves_valid_settings(paths, settings, services):
    brain = Brain(paths, settings, youtube_base=services.base_url, settings_problems=["config.json could not be read"])
    client = TestClient(create_app(brain, TOKEN), headers={"x-moi-token": TOKEN})
    try:
        assert "config.json could not be read" in client.post("/view/feed", json={}).json()["warnings"]
        client.post("/model", json={"allow_content_to_hosted": False})
        assert "config.json could not be read" not in client.post("/view/feed", json={}).json()["warnings"]
    finally:
        brain.http.close()


def test_main_serves_on_localhost_with_the_token_and_starts_the_relay(started):
    entry.main()
    [call] = started.calls
    assert (call["host"], call["port"], call["log_level"]) == ("127.0.0.1", 8799, "warning")
    brain = call["app"].state.brain
    assert call["app"].state.token == TOKEN
    assert brain.relay.server is not None
    assert brain.settings_problems == []


def test_main_runs_on_defaults_when_config_is_broken(started, tmp_path, capsys):
    (tmp_path / "home" / ".moi").mkdir(parents=True)
    (tmp_path / "home" / ".moi" / "config.json").write_text("{oops")
    entry.main()
    brain = started.calls[0]["app"].state.brain
    assert brain.gateway.settings == Settings()
    assert brain.settings_problems and "config.json could not be read" in brain.settings_problems[0]
    assert "config.json could not be read" in capsys.readouterr().err
    assert (tmp_path / "home" / ".moi" / "config.json").read_text() == "{oops"


def test_main_keeps_serving_when_the_relay_port_is_taken(started, monkeypatch, capsys):
    monkeypatch.setattr(RelayHub, "start", refuse_port)
    entry.main()
    assert len(started.calls) == 1
    assert "Chrome relay not started: port 0 is taken" in capsys.readouterr().err


def test_ensure_home_seeds_starters_but_never_overwrites_your_files(paths):
    paths.memory.mkdir(parents=True, exist_ok=True)
    (paths.memory / "likes.md").write_text("# likes\n\n* sourdough\n")
    ensure_home(paths)
    assert (paths.memory / "likes.md").read_text() == "# likes\n\n* sourdough\n"
    assert (paths.memory / "dislikes.md").exists()
    assert [path.name for path in paths.views.glob("*.md")] == ["feed.md"]

