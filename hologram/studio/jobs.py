"""The Studio's work list: renders and builds take turns on the GPU (Depth Anything beside a Wan2GP
queue runs ten times slower), checks run on the CPU beside them. Jobs are kept in
studio/jobs.json, so the page shows them after a reload and a render keeps going (and is picked up
again) if the Studio itself restarts.

A job: {id, kind: render|build|review, args, status: waiting|running|done|failed|cancelled,
        not_before (epoch s, for "tonight"), progress, log: [last lines], created, started, ended}
"""
import json
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

import build
import pictures
import render
from config import PROJECTS, WAN2GP_PYTHON
from project import editing

JOBS_FILE = PROJECTS / "jobs.json"
LANES = {"render": "gpu", "build": "gpu", "picture": "gpu", "still": "gpu", "review": "cpu"}
lock = threading.RLock()
jobs = []


def load():
    global jobs
    jobs = json.loads(JOBS_FILE.read_text()) if JOBS_FILE.exists() else []


def save():
    part = JOBS_FILE.with_suffix(".part")
    part.write_text(json.dumps(jobs[-200:], indent=1))
    os.replace(part, JOBS_FILE)


def add(kind, args, not_before=0):
    with lock:
        job = {"id": max([j["id"] for j in jobs], default=0) + 1, "kind": kind, "args": args, "status": "waiting",
               "not_before": not_before, "progress": {}, "log": [], "created": time.time()}
        jobs.append(job)
        save()
        return job


def find(job_id):
    return next((j for j in jobs if j["id"] == job_id), None)


def note(job, line):
    with lock:
        job["log"] = (job["log"] + [line])[-60:]
        save()


def cancel(job_id):
    with lock:
        job = find(job_id)
        if not job or job["status"] not in ("waiting", "running"):
            return False
        if job["status"] == "running" and job.get("pid"):
            try:
                os.killpg(job["pid"], signal.SIGTERM)  # its whole session; never SIGSTOP a queue
            except ProcessLookupError:
                pass
        job["status"] = "cancelled"
        job["ended"] = time.time()
        if job["kind"] == "render":
            render.unqueue(job["args"]["queue"])
        save()
        return True


def alive(pid):
    """Whether a job's process still runs. One the Studio started itself is reaped here when it ends
    (otherwise it lingers as a zombie, which still answers a signal); one started by an earlier
    Studio belongs to init and is only checked."""
    if not pid:
        return False
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
        return done == 0
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


# --- the work ------------------------------------------------------------------------------------
def do_render(job):
    """Run (or keep watching) a Wan2GP queue; finished clips are collected as they land, so they can
    be reviewed while the rest render, and each gets its sheet and checks."""
    name = job["args"]["queue"]
    if not (job.get("pid") and alive(job["pid"])):
        proc = render.start(name)
        with lock:
            job["pid"] = proc.pid
            save()
    while True:
        running = alive(job["pid"])
        with lock:
            if job["status"] == "cancelled":
                return
            job["progress"] = render.progress(name)
            save()
        landed = render.collect()
        for cid in sorted({cid for cid, _ in landed}):
            add("review", {"choom": cid, "clips": [n for c, n in landed if c == cid]})
        if not running:
            break
        time.sleep(10)
    time.sleep(35)  # the last clip settles before it's collected
    for cid, n in render.collect():
        add("review", {"choom": cid, "clips": [n]})
    missing = render.unqueue(name)  # anything that didn't render goes back to planned
    if missing:
        raise RuntimeError(f"{len(missing)} clips didn't render and are planned again: {', '.join(missing)} (see queue/{name}.log)")


def do_build(job):
    build.build(job["args"]["choom"], log=lambda line: note(job, line), relaunch=job["args"].get("relaunch", True))


def do_still(job):
    a = job["args"]
    build.still(a["choom"], a["color"], a.get("style", "motes"), log=lambda line: note(job, line))


def do_review(job):
    a = job["args"]
    proc = subprocess.run([str(WAN2GP_PYTHON), str(Path(__file__).resolve().parent / "review.py"), a["choom"], *a["clips"]],
                          capture_output=True, text=True)
    for line in (proc.stdout + proc.stderr).splitlines()[-40:]:
        note(job, line)
    if proc.returncode:
        raise RuntimeError("review.py failed")


def do_picture(job):
    """Klein versions of a new look; they wait in her project's drafts until one is chosen."""
    a = job["args"]
    try:
        names = pictures.run(a["choom"], a["look"], a["source"], a["prompt"], a.get("count", 3), log=lambda line: note(job, line))
    except Exception:
        with editing(a["choom"]) as proj:
            proj.data.get("drafts", {}).get(a["look"], {})["status"] = "failed"
        raise
    with editing(a["choom"]) as proj:
        draft = proj.data.setdefault("drafts", {}).setdefault(a["look"], {})
        draft["pictures"] = draft.get("pictures", []) + names
        draft["status"] = "ready"


WORK = {"render": do_render, "build": do_build, "picture": do_picture, "still": do_still, "review": do_review}


def worker(lane):
    while True:
        with lock:
            busy = any(j["status"] == "running" and LANES[j["kind"]] == lane for j in jobs)
            ready = [j for j in jobs if j["status"] == "waiting" and LANES[j["kind"]] == lane
                     and j.get("not_before", 0) <= time.time()]
            job = ready[0] if ready and not busy else None
            if job:
                job.update(status="running", started=time.time())
                save()
        if not job:
            time.sleep(3)
            continue
        run_job(job)


def run_job(job):
    try:
        WORK[job["kind"]](job)
        with lock:
            if job["status"] == "running":
                job["status"] = "done"
    except Exception as e:
        with lock:
            job["status"] = "failed"
            job["error"] = str(e)
        note(job, traceback.format_exc(limit=2))
    with lock:
        job["ended"] = time.time()
        save()


def start_workers():
    """Pick up where the Studio left off: a render still running is watched again; other jobs that
    were running when it stopped are failed (rerun them from the page)."""
    load()
    with lock:
        for j in jobs:
            if j["status"] == "running" and not (j["kind"] == "render" and alive(j.get("pid"))):
                status = "failed"
                if j["kind"] == "render":
                    # Its Wan2GP is gone too: keep what it finished, the rest goes back to planned.
                    for cid, n in render.collect():
                        add("review", {"choom": cid, "clips": [n]})
                    missing = render.unqueue(j["args"]["queue"])
                    if missing:
                        j["error"] = f"stopped while the Studio was down; planned again: {', '.join(missing)}"
                    else:
                        status = "done"
                else:
                    j["error"] = "the Studio stopped while this ran"
                j.update(status=status, ended=time.time())
        save()
    resumed = [j for j in jobs if j["status"] == "running"]
    for j in resumed:
        threading.Thread(target=run_job, args=(j,), daemon=True).start()
    for lane in ("gpu", "cpu"):
        threading.Thread(target=worker, args=(lane,), daemon=True).start()
