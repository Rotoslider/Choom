"""Where Glass Studio finds things.

Its workspace holds everything a Choom's glass is made from:
    clean/    her pictures: the clean start picture of each look (main, relaxed, outfits...)
    clips/    every rendered clip, named <choom>_[<outfit>-]<action>.mp4
    queue/    render queues for Wan2GP (<name>.zip) and their logs
    studio/   one project file per Choom (<id>.json), contact sheets and checks

And the tools it drives: Wan2GP (wgp.py and its venv) renders pictures and clips; Forge Neo's Python
has Depth Anything V2 and MediaPipe for make_alive.py. Settings are read from studio.json in the
hologram's config folder (~/.config/choom-hologram); anything not set there uses the defaults below.
"""
import json
import os
from pathlib import Path

HOLOGRAM = Path(__file__).resolve().parents[1]
CONFIG_DIR = Path(os.environ.get("HOLOGRAM_CONFIG", Path.home() / ".config" / "choom-hologram"))
CONFIG_FILE = CONFIG_DIR / "studio.json"

DEFAULTS = {
    "workspace": "~/choom-studio",
    "wan2gp": "~/pinokio/api/wan2gp/app",
    "forge_python": "~/pinokio/api/forge-neo/app/venv/bin/python",
    "video_model": "minimax_h3_fl2va_pdd",
    "picture_model": "flux2_klein_9b",
    "minutes_per_clip": 5.5,  # a five-second clip on an RTX PRO 6000 Blackwell; seven seconds take longer
    "port": 8767,
    "hologram_url": "http://127.0.0.1:8765",
    # A short Signal message through the Choom app when a scheduled render or build finishes or fails
    # (notify.py). Off until "url" (the Choom app) and "choom" (whose thread it comes in) are set;
    # what ends in the quiet hours waits until they're over. dry_run only logs it.
    "notify": {"url": "", "choom": "", "quiet": [22, 7], "dry_run": False},
}


def load():
    cfg = dict(DEFAULTS)
    if CONFIG_FILE.exists():
        cfg.update(json.loads(CONFIG_FILE.read_text()))
    return cfg


CFG = load()


def path(key):
    return Path(os.path.expanduser(CFG[key]))


WORKSPACE = path("workspace")
PICTURES = WORKSPACE / "clean"
CLIPS = WORKSPACE / "clips"
QUEUES = WORKSPACE / "queue"
PROJECTS = WORKSPACE / "studio"
SHEETS = PROJECTS / "sheets"
WAN2GP = path("wan2gp")
WAN2GP_PYTHON = WAN2GP / "venv" / "bin" / "python"
FORGE_PYTHON = path("forge_python")
# The glass's own folder; studio.json can point a test Studio elsewhere so it never writes a live
# Choom's closet or wishes.
PORTRAITS = path("portraits") if CFG.get("portraits") else HOLOGRAM / "portraits"
TOOLS = HOLOGRAM / "tools"  # imported from (clip_roles, closet)
# Run from (the build tools and the relaunch script): a test Studio points "tools" at stand-ins, so it
# never relaunches the real glass.
RUN_TOOLS = path("tools") if CFG.get("tools") else TOOLS


def ensure_workspace():
    for d in (PICTURES, CLIPS, QUEUES, PROJECTS, SHEETS):
        d.mkdir(parents=True, exist_ok=True)
