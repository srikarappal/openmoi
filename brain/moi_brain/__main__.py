"""Run the brain: python -m moi_brain --socket <path> (as the shell does) or --port 8765 (by hand).

On a socket, the brain answers only through a Unix socket in a folder only you can open, with the per launch token
the shell sets in MOI_TOKEN; requests name the host moi.brain."""

import argparse
import os
import secrets
import stat
import sys
from pathlib import Path

import uvicorn

from moi_brain.api import create_app
from moi_brain.backup import WipeRefused, wipe_if_marked
from moi_brain.brain import Brain
from moi_brain.config import (
    Paths,
    Settings,
    SettingsFileError,
    load_env_file,
    load_paths,
    load_settings,
)
from moi_brain.feeds import YOUTUBE_BASE
from moi_brain.relay import DEFAULT_PORT

SOCKET_HOST = "moi.brain"


def main() -> None:
    parser = argparse.ArgumentParser(description="openMoi brain")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--socket", help="a Unix socket to answer on instead of a port; its folder should be yours alone")
    args = parser.parse_args()
    paths = load_paths()
    token = os.environ.get("MOI_TOKEN") or new_token()
    if args.socket:
        check_socket_folder(Path(args.socket))
    wipe_problem = start_over_if_asked(paths)
    for env_file in (paths.assets / ".env", paths.home / ".env"):
        load_env_file(env_file)
    try:
        settings, problems = load_settings(paths), []
    except SettingsFileError as error:
        print(error, file=sys.stderr)
        settings, problems = Settings(), [str(error)]
    problems += [wipe_problem] if wipe_problem else []
    brain = Brain(paths, settings, youtube_base=os.environ.get("MOI_YOUTUBE_BASE", YOUTUBE_BASE), settings_problems=problems)
    try:
        brain.relay.start(int(os.environ.get("MOI_RELAY_PORT", DEFAULT_PORT)))
    except OSError as error:
        print(f"Chrome relay not started: {error}", file=sys.stderr)
    if args.socket:
        socket = Path(args.socket)
        # A socket left by a run that crashed would keep the new one from starting; anything else there is kept.
        if socket.is_socket():
            socket.unlink()
        uvicorn.run(create_app(brain, token, {SOCKET_HOST}), uds=str(socket), log_level="warning")
        return
    hosts = {f"127.0.0.1:{args.port}", f"localhost:{args.port}"}
    uvicorn.run(create_app(brain, token, hosts), host="127.0.0.1", port=args.port, log_level="warning")


def check_socket_folder(socket: Path) -> None:
    """The socket's folder must be yours alone (0700), so no other account on this Mac can reach the brain."""
    try:
        folder = socket.parent.lstat()
    except OSError as error:
        sys.exit(f"the brain's socket folder cannot be used: {error}")
    if not stat.S_ISDIR(folder.st_mode) or folder.st_uid != os.getuid() or folder.st_mode & 0o077:
        sys.exit(f"the brain's socket folder {socket.parent} must be a folder of yours that only you can open (0700)")


def start_over_if_asked(paths: Paths) -> str:
    """Deletes everything, before anything of the brain runs, when the last brain was asked to; a problem as text."""
    try:
        removed = wipe_if_marked(paths)
    except (WipeRefused, OSError) as error:
        print(f"delete everything failed: {error}", file=sys.stderr)
        return f"Deleting everything did not finish: {error}. Fix it and say /delete everything confirm again."
    if removed is not None:
        print(f"deleted everything: {', '.join(removed)}", file=sys.stderr)
    return ""


def new_token() -> str:
    """Run by hand without the shell: a token for this run, printed so you can send it as the x-moi-token header."""
    token = secrets.token_hex(16)
    print(f"MOI_TOKEN for this run: {token}", file=sys.stderr)
    return token


if __name__ == "__main__":
    main()
