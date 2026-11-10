"""Housekeeping: what the Studio leaves behind that nothing uses any more, and how much room it takes.

    dropped   videos of dropped clips (clips/<name>.mp4), and their old takes
    takes     old takes in clips/takes/ older than N days (a re-roll moves the take it replaced there)
    drafts    Klein versions in clean/drafts/ that no look is waiting on, and Klein's run folders
    queues    render queues in queue/ that no clip or job uses any more (the zips; logs and plans stay)
    caches    cut-out and depth caches (portraits/<id>/alive_masks_*.npz, alive_depth_*.npy) of clips
              she no longer has, or has dropped
    depth     depth caches of clips already built onto the glass from the video they have now, except
              her main clip's: about 300 MB a clip, 826 GB in all on 2026-11-09. The glass never reads
              them; a build that has to make a clip again (a new build version, her main clip changed)
              makes its depth again in about 20 s. Builds drop them themselves from 2026-11-09 on
              (make_alive.py --drop-depth), so this is for the ones made before.

Never touched: anything a kept, planned, queued or rendered clip uses, a look's picture, a draft a
look is waiting on, a queue a waiting, running or paused job uses, the depth of a Choom being built.
"""
import json
import shutil
import time
from pathlib import Path

from config import CLIPS, PICTURES, PORTRAITS, QUEUES, WORKSPACE
from project import Project

CATEGORIES = ("dropped", "takes", "drafts", "queues", "caches", "depth")
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


def built_depth(folder):
    """Her depth caches the glass's build no longer needs: clips in alive.json built from the video they
    have now (so a build counts them unchanged, see make_alive.stamp), except her main clip's."""
    try:
        meta = json.loads((folder / "alive.json").read_text())
    except (OSError, ValueError):
        return []
    main = Path((meta.get("rangeFrom") or [""])[0]).stem
    out = []
    for c in meta.get("clips", []):
        stem, built = Path(c.get("source", "")).stem, c.get("built") or []
        f, src = folder / f"alive_depth_{stem}.npy", CLIPS / c.get("source", "")
        if not stem or stem == main or not f.exists() or not src.exists():
            continue
        if len(built) > 4 and isinstance(built[4], list) and built[4][:1] == [round(src.stat().st_mtime)]:
            out.append(f)
    return out


def survey(takes_days=30, active_queues=(), active_runs=(), building=()):
    """{category: {"files": [paths], "bytes": n, "oldest", "newest"}} of what could go, and disk use.
    building: Chooms whose build is running (their depth caches stay)."""
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
        if p.id not in building:
            out["depth"] += [f for f in built_depth(folder) if f not in out["caches"]]
    report = {}
    for k, v in out.items():
        times = [f.stat().st_mtime for f in v if f.exists()]
        report[k] = {"files": sorted(str(f) for f in v), "count": len(v), "bytes": sum(du(f) for f in v),
                     "oldest": min(times, default=None), "newest": max(times, default=None)}
    report["drafts"]["folders"] = sum(1 for f in out["drafts"] if f.is_dir())
    report["drafts"]["by"] = {cid: sum(1 for f in out["drafts"] if f.is_file() and f.name.startswith(cid + "_")) for cid in Project.ids()}
    report["depth"]["by"] = {cid: sum(du(f) for f in out["depth"] if f.parent.name == cid) for cid in Project.ids()}
    free = shutil.disk_usage(WORKSPACE)
    report["disk"] = {"workspace": du(WORKSPACE), "portraits": du(PORTRAITS), "free": free.free, "total": free.total}
    return report


def clean(categories, takes_days=30, active_queues=(), active_runs=(), building=()):
    """Delete what survey() lists for these categories; returns {category: bytes freed}."""
    report = survey(takes_days, active_queues, active_runs, building)
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
