"""Run the brain on localhost: python -m moi_brain --port 8765"""

import argparse
import os

import uvicorn

from moi_brain.api import create_app
from moi_brain.brain import Brain
from moi_brain.config import load_paths, load_settings
from moi_brain.feeds import YOUTUBE_BASE


def main() -> None:
    parser = argparse.ArgumentParser(description="openMoi brain")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    paths = load_paths()
    brain = Brain(paths, load_settings(paths), youtube_base=os.environ.get("MOI_YOUTUBE_BASE", YOUTUBE_BASE))
    uvicorn.run(create_app(brain, os.environ.get("MOI_TOKEN")), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
