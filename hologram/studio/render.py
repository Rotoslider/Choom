"""Rendering clips with Wan2GP: queue zips, the headless run, and collecting the finished clips.

A queue is queue/<name>.zip holding queue.json (one MiniMax H3 task per clip: its prompt, seed,
length and start/end pictures, and a clip's own pictures for the reference model) and the pictures; queue/<name>_plan.json maps each seed to its clip
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
    Returns the zip's path. Everything is checked and the zip written before any clip is marked, so a
    clip that isn't planned or a picture that's gone stops it with nothing left half queued."""
    template = json.loads(TEMPLATE.read_text())
    tasks, plan, pictures = [], {}, set()
    chooms = sorted({cid for cid, _ in picks})
    for cid in chooms:
        proj = Project.load(cid)
        for _, clip_name in [p for p in picks if p[0] == cid]:
            clip = proj.clips.get(clip_name)
            if not clip:
                raise ValueError(f"{cid} has no clip {clip_name}")
            if clip["status"] != "planned":
                raise ValueError(f"{clip_name} is {clip['status']}, not planned")
            refs = clip.get("refs") or []
            for pic in (clip["start"], clip["end"], *refs):
                if not (PICTURES / pic).is_file():
                    raise ValueError(f"{clip_name}: its picture {pic} is missing from {PICTURES}")
            params = dict(template, model_type=CFG["video_model"], prompt=clip["prompt"], seed=clip["seed"],
                          video_length=clip["frames"], image_start=clip["start"], image_end=clip["end"])
            if refs:  # its own pictures (a mug she sips from): picture 3 on in the reference model's prompt
                params.update(model_type=CFG["reference_model"], base_model_type=CFG["reference_model"],
                              video_prompt_type="I", image_refs=list(refs), image_refs_relative_size=100,
                              remove_background_images_ref=0)
            tasks.append({"id": 0, "params": params})
            plan[str(clip["seed"])] = clip_name
            pictures.update((clip["start"], clip["end"], *refs))
    # Clips with pictures last, so Wan2GP changes models once (loading one takes about a minute).
    tasks.sort(key=lambda t: t["params"]["model_type"] != CFG["video_model"])
    for i, t in enumerate(tasks):
        t["id"] = i + 1
    write_zip(name, tasks, plan, {pic: PICTURES / pic for pic in pictures})
    marked = []
    try:
        for cid in chooms:
            with editing(cid) as proj:
                for _, clip_name in [p for p in picks if p[0] == cid]:
                    clip = proj.clips[clip_name]
                    if clip["status"] != "planned":  # changed since the check above
                        raise ValueError(f"{clip_name} is {clip['status']}, not planned")
                    clip.update(status="queued", queue=name)
                    marked.append(clip_name)
    except Exception:
        unqueue(name)  # whatever was marked goes back to planned
        raise
    return QUEUES / f"{name}.zip"


def write_zip(name, tasks, plan, pictures):
    """queue/<name>.zip (its tasks and pictures) and queue/<name>_plan.json, written whole and swapped in."""
    QUEUES.mkdir(parents=True, exist_ok=True)
    out = QUEUES / f"{name}.zip"
    part = out.with_suffix(".part")
    with zipfile.ZipFile(part, "w") as z:
        z.writestr("queue.json", json.dumps(tasks, indent=1))
        for arc, src in sorted(pictures.items()):
            if isinstance(src, bytes):
                z.writestr(arc, src)
            else:
                z.write(src, arc)
    part.replace(out)
    (QUEUES / f"{name}_plan.json").write_text(json.dumps(plan, indent=1))


def requeue(name, new_name):
    """A paused render going on: queue <new_name> with the tasks of queue <name> whose clips are still
    queued there (the ones it didn't get to), those clips moved to it. Returns how many."""
    with zipfile.ZipFile(QUEUES / f"{name}.zip") as z:
        tasks = json.loads(z.read("queue.json"))
        pics = {n: z.read(n) for n in z.namelist() if n != "queue.json"}
    plan = json.loads((QUEUES / f"{name}_plan.json").read_text())
    left = set()
    for cid in Project.ids():
        for n, c in Project.load(cid).clips.items():
            if c["status"] == "queued" and c.get("queue") == name:
                left.add(n)
    keep = [t for t in tasks if plan.get(str(t["params"]["seed"])) in left]
    if not keep:
        return 0
    for i, t in enumerate(keep):
        t["id"] = i + 1
    used = {pic for t in keep for pic in (t["params"]["image_start"], t["params"]["image_end"], *(t["params"].get("image_refs") or []))}
    write_zip(new_name, keep, {str(t["params"]["seed"]): plan[str(t["params"]["seed"])] for t in keep},
              {n: b for n, b in pics.items() if n in used})
    for cid in Project.ids():
        with editing(cid) as proj:
            for n in left & set(proj.clips):
                if proj.clips[n]["status"] == "queued" and proj.clips[n].get("queue") == name:
                    proj.clips[n]["queue"] = new_name
    return len(keep)


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


_unmatched_seen = set()


def unmatched(since):
    """Videos Wan2GP wrote into clips/ since `since` (epoch s) that match no clip: if its output
    naming ever changes, every clip would look unrendered and go back to planned, so this is said
    out loud instead (the files are left where they are)."""
    out = []
    for f in CLIPS.glob("*.mp4"):
        if f.stat().st_mtime < since or f.stem.endswith("_tmp"):
            continue
        m = OUTPUT.match(f.name)
        if m or re.match(r"^\d{4}-\d\d-\d\d", f.name):  # a Wan2GP name collect() didn't take (no clip has its seed)
            out.append(f.name)
    return sorted(out)


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
        if f.stem.endswith("_tmp") or time.time() - f.stat().st_mtime < 30:
            continue
        if not m or int(m.group(1)) not in seeds:
            if re.match(r"^\d{4}-\d\d-\d\d", f.name) and f.name not in _unmatched_seen:
                _unmatched_seen.add(f.name)
                print(f"render: {f.name} in clips/ matches no queued clip (Wan2GP's naming changed?)", flush=True)
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
