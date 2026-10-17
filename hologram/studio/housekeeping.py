"""Housekeeping: what the Studio leaves behind that nothing uses any more, and how much room it takes.

    dropped   videos of dropped clips (clips/<name>.mp4), and their old takes
    takes     old takes in clips/takes/ older than N days (a re-roll moves the take it replaced there)
    drafts    Klein versions in clean/drafts/ that no look is waiting on, and Klein's run folders
    queues    render queues in queue/ that no clip or job uses any more (the zips; logs and plans stay)
    caches    cut-out and depth caches (portraits/<id>/alive_masks_*.npz, alive_depth_*.npy) of clips
              she no longer has, or has dropped

Never touched: anything a kept, planned, queued or rendered clip uses, a look's picture, a draft a
look is waiting on, a queue a waiting, running or paused job uses.
"""
import json
import shutil
import time
from pathlib import Path

from config import CLIPS, PICTURES, PORTRAITS, QUEUES, WORKSPACE
from project import Project

CATEGORIES = ("dropped", "takes", "drafts", "queues", "caches")
LIVE = ("planned", "queued", "rendered", "kept")


def _size(path):
    if path.is_dir():
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return path.stat().st_size if path.exists() else 0


def du(path):
    try:
        return _size(path)
    except OSError:
        return 0


def survey(takes_days=30, active_queues=(), active_runs=()):
    """{category: {"files": [paths], "bytes": n}} of what could go, and disk use."""
    projects = [Project.load(cid) for cid in Project.ids()]
    clips = {n: c for p in projects for n, c in p.clips.items()}
    live = {n for n, c in clips.items() if c["status"] in LIVE}
    dropped = {n for n, c in clips.items() if c["status"] == "dropped"}
    out = {k: [] for k in CATEGORIES}
    for n in dropped:
        f = CLIPS / f"{n}.mp4"
        if f.exists():
            out["dropped"].append(f)
    takes = CLIPS / "takes"
    if takes.is_dir():
        cutoff = time.time() - takes_days * 86400
        for f in takes.glob("*.mp4"):
            owner = f.stem.rsplit("_", 1)[0]  # <clip name>_<when>
            if owner in dropped or f.stat().st_mtime < cutoff:
                out["takes"].append(f)
    waiting = {pic for p in projects for d in p.data.get("drafts", {}).values() for pic in d.get("pictures", [])}
    looks = {l.get("picture") for p in projects for l in p.looks.values()}
    drafts = PICTURES / "drafts"
    if drafts.is_dir():
        for f in drafts.iterdir():
            rel = f"drafts/{f.name}"
            if f.is_file() and rel not in waiting and f.name not in looks:
                out["drafts"].append(f)
            elif f.is_dir() and f.name.startswith("run_") and str(f) not in set(active_runs) and time.time() - f.stat().st_mtime > 3600:
                out["drafts"].append(f)
    used = {c.get("queue") for n, c in clips.items() if c["status"] == "queued"} | set(active_queues)
    for f in QUEUES.glob("*.zip"):
        if f.stem not in used:
            out["queues"].append(f)
    for p in projects:
        folder = PORTRAITS / p.id
        if not folder.is_dir():
            continue
        mine = {n for n in p.clips if n in live}
        try:  # and whatever her glass plays now, whatever the project says
            mine |= {c["source"].removesuffix(".mp4") for c in json.loads((folder / "alive.json").read_text())["clips"]}
        except (OSError, ValueError, KeyError):
            pass
        for pattern, prefix in (("alive_masks_*.npz", "alive_masks_"), ("alive_depth_*.npy", "alive_depth_")):
            for f in folder.glob(pattern):
                if f.stem.removeprefix(prefix) not in mine:
                    out["caches"].append(f)
    report = {k: {"files": sorted(str(f) for f in v), "count": len(v), "bytes": sum(du(f) for f in v)} for k, v in out.items()}
    free = shutil.disk_usage(WORKSPACE)
    report["disk"] = {"workspace": du(WORKSPACE), "portraits": du(PORTRAITS), "free": free.free, "total": free.total}
    return report


def clean(categories, takes_days=30, active_queues=(), active_runs=()):
    """Delete what survey() lists for these categories; returns {category: bytes freed}."""
    report = survey(takes_days, active_queues, active_runs)
    freed = {}
    for k in categories:
        if k not in CATEGORIES:
            raise ValueError(f"unknown category {k}")
        total = 0
        for name in report[k]["files"]:
            path = Path(name)
            size = du(path)
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            elif path.exists():
                path.unlink()
            total += size
        freed[k] = total
    return freed
