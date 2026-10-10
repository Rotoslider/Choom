"""Rendering clips with Wan2GP: queue zips, the headless run, and collecting the finished clips.

A queue is queue/<name>.zip holding queue.json (one MiniMax H3 task per clip: its prompt, seed,
length and start/end pictures) and the pictures; queue/<name>_plan.json maps each seed to its clip
name. Wan2GP names its outputs by date, seed and prompt; collect() renames them <clip name>.mp4.
"""
import json
import re
import subprocess
import time
import zipfile
from pathlib import Path

from config import CFG, CLIPS, PICTURES, QUEUES, WAN2GP, WAN2GP_PYTHON
from project import Project, editing

TEMPLATE = Path(__file__).resolve().parent / "templates" / "h3_task.json"
OUTPUT = re.compile(r"^\d{4}-\d\d-\d\d-.*_seed(\d+)_.*\.mp4$")


def minutes(frames):
    return CFG["minutes_per_clip"] * frames / 124


def make_queue(name, picks):
    """Write queue <name> for picks [(choom id, clip name)] of planned clips; marks them queued.
    Returns the zip's path."""
    template = json.loads(TEMPLATE.read_text())
    tasks, plan, pictures = [], {}, set()
    for cid in sorted({cid for cid, _ in picks}):
        with editing(cid) as proj:
            for _, clip_name in [p for p in picks if p[0] == cid]:
                clip = proj.clips[clip_name]
                if clip["status"] != "planned":
                    raise ValueError(f"{clip_name} is {clip['status']}, not planned")
                params = dict(template, model_type=CFG["video_model"], prompt=clip["prompt"], seed=clip["seed"],
                              video_length=clip["frames"], image_start=clip["start"], image_end=clip["end"])
                tasks.append({"id": len(tasks) + 1, "params": params})
                plan[str(clip["seed"])] = clip_name
                pictures.update((clip["start"], clip["end"]))
                clip.update(status="queued", queue=name)
    QUEUES.mkdir(parents=True, exist_ok=True)
    out = QUEUES / f"{name}.zip"
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("queue.json", json.dumps(tasks, indent=1))
        for pic in sorted(pictures):
            z.write(PICTURES / pic, pic)
    (QUEUES / f"{name}_plan.json").write_text(json.dumps(plan, indent=1))
    return out


def unqueue(name):
    """Put a queue's clips that didn't render back to planned (a queue cancelled or failed); returns them."""
    plan = json.loads((QUEUES / f"{name}_plan.json").read_text())
    names, back = set(plan.values()), []
    for cid in Project.ids():
        with editing(cid) as proj:
            for n in names & set(proj.clips):
                if proj.clips[n]["status"] == "queued" and proj.clips[n].get("queue") == name:
                    proj.clips[n]["status"] = "planned"
                    back.append(n)
    return back


def start(name):
    """Start Wan2GP on queue <name> in its own session (so closing the Studio or a terminal never
    stops it). Returns the process; its output goes to queue/<name>.log."""
    log = open(QUEUES / f"{name}.log", "w")
    return subprocess.Popen([str(WAN2GP_PYTHON), "wgp.py", "--process", str(QUEUES / f"{name}.zip"),
                             "--output-dir", str(CLIPS)], cwd=WAN2GP, stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True)


def progress(name):
    """{total, done, finished, step} from queue <name>'s log."""
    log = QUEUES / f"{name}.log"
    if not log.exists():
        return {"total": 0, "done": 0, "finished": False, "step": ""}
    text = log.read_text(errors="replace")
    total = max([int(t) for t in re.findall(r"Task \d+/(\d+) ready", text)] or [0])
    done = len(re.findall(r"Task \d+ completed", text))
    # The clip it's on ("Prompt 3/6"): those before it are done, even one whose last step failed.
    current = max([int(k) for k in re.findall(r"Prompt (\d+)/\d+", text)] or [0])
    done = max(done, current - 1)
    steps = re.findall(r"(\d+)%\|", text[-4000:])
    return {"total": total, "done": done, "finished": "Queue completed" in text,
            "step": f"{steps[-1]}%" if steps else ""}


def collect():
    """Rename finished Wan2GP outputs in clips/ to their clip names and mark them rendered. A clip
    rendered again (a re-roll) moves its old take to clips/takes/ first. Returns the names collected."""
    seeds = {}
    for cid in Project.ids():
        for n, c in Project.load(cid).clips.items():
            if c["status"] in ("queued", "planned") and c.get("seed"):
                seeds[c["seed"]] = (cid, n)
    done = []
    for f in sorted(CLIPS.glob("*.mp4")):
        m = OUTPUT.match(f.name)
        # Wan2GP writes the video as <name>_tmp.mp4, then adds the sound track into <name>.mp4: leave
        # its temporary file alone, and anything still being written.
        if not m or int(m.group(1)) not in seeds or f.stem.endswith("_tmp") or time.time() - f.stat().st_mtime < 30:
            continue
        cid, n = seeds[int(m.group(1))]
        target = CLIPS / f"{n}.mp4"
        if target.exists():
            takes = CLIPS / "takes"
            takes.mkdir(exist_ok=True)
            target.rename(takes / f"{n}_{time.strftime('%Y%m%d-%H%M%S', time.localtime(target.stat().st_mtime))}.mp4")
        f.rename(target)
        with editing(cid) as proj:
            proj.clips[n]["status"] = "rendered"
            proj.clips[n]["rendered"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        done.append((cid, n))
    return done
