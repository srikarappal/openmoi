"""The brain as the shell runs it: on a Unix socket, answering only requests with this run's token that name its host."""

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import pytest

TOKEN = "socket-test-token"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def get(path: Path, route: str, token: str = TOKEN, host: str = "moi.brain") -> httpx.Response:
    with httpx.Client(transport=httpx.HTTPTransport(uds=str(path)), base_url=f"http://{host}") as client:
        return client.get(route, headers={"x-moi-token": token})


@pytest.fixture
def running():
    # A short folder, as the shell uses: macOS caps a socket's path near 104 characters.
    folder = Path(tempfile.mkdtemp(prefix="moi-"))
    path = folder / "b.sock"
    path.write_text("left by a crashed run")
    env = {**os.environ, "MOI_TOKEN": TOKEN, "MOI_HOME": str(folder / "home"), "MOI_RELAY_PORT": str(free_port())}
    process = subprocess.Popen([sys.executable, "-m", "moi_brain", "--socket", str(path)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            if get(path, "/health").status_code == 200:
                break
        except httpx.TransportError:
            time.sleep(0.2)
    yield path
    process.terminate()
    process.wait(timeout=10)
    shutil.rmtree(folder, ignore_errors=True)


def test_the_brain_answers_on_its_socket_only_with_the_token_and_its_host_name(running):
    assert get(running, "/health").json()["status"] == "ok"
    assert get(running, "/health", token="wrong").status_code == 401
    assert get(running, "/health", host="evil.example").status_code == 421
