"""The Studio's work list: renders, builds and Klein pictures take turns on the GPU (Depth Anything
beside a Wan2GP queue runs ten times slower), checks run on the CPU beside them, and reloading the
glass after a build waits for a quiet moment in a lane of its own. Jobs are kept in studio/jobs.json,
and every tool runs in its own session with its process id kept in its job, so the page shows them
after a reload, and a render, build or picture keeps going (and is picked up again) if the Studio
itself restarts.

A job: {id, kind: render|build|picture|still|review|relaunch, args,
        status: waiting|running|paused|cancelling|done|failed|cancelled,
        not_before (epoch s: "tonight"), after (a job id it waits for: "after tonight's render"),
        pid (its tool's process, which is also its session), tag (what that process's command line
        contains, so a reused pid is never taken for it), progress, log: [last lines], error,
        created, started, ended}

The work list can be paused (studio/worklist.json): what's on the GPU finishes (a render, the clip
it's on) and nothing more starts there until it's resumed. A render paused that way keeps its
remaining clips queued and goes on from them, after anything queued while it was paused.
"""
import json
import os
import signal
import subprocess
import threading
import time
import traceback
from pathlib import Path

import build
import notify
import pictures
import render
from config import CFG, PROJECTS, WAN2GP_PYTHON
from project import Project, editing

JOBS_FILE = PROJECTS / "jobs.json"
WORKLIST_FILE = PROJECTS / "worklist.json"
LANES = {"render": "gpu", "build": "gpu", "picture": "gpu", "still": "gpu", "review": "cpu", "relaunch": "glass"}
ACTIVE = ("waiting", "running", "paused", "cancelling")
BUSY = ("running", "cancelling")  # a lane stays taken until its tool has really stopped
RELAUNCH_RETRY_S = float(CFG.get("relaunch_retry_s", 300))  # a relaunch that found the glass busy tries again
STOP_GRACE_S = 30
lock = threading.RLock()
jobs = []
procs = {}  # job id -> the Popen of a tool this Studio started (for its exit code)
worklist = {"paused": False, "pausing": False}


def load():
    global jobs, worklist
    jobs = json.loads(JOBS_FILE.read_text()) if JOBS_FILE.exists() else []
    if WORKLIST_FILE.exists():
        worklist = {**worklist, **json.loads(WORKLIST_FILE.read_text())}


def recent(n):
    """The last n jobs, and every job not finished however far back it is: a long render lands a
    review job per clip, which pushed it (and the renders waiting for tonight) out of the last 40
    the page asks for, and would have dropped them from the file."""
    last = {j["id"] for j in jobs[-n:]}
    return [j for j in jobs if j["id"] in last or j["status"] in ACTIVE]


def save():
    part = JOBS_FILE.with_suffix(".part")
    part.write_text(json.dumps(recent(200), indent=1))
    os.replace(part, JOBS_FILE)
    part = WORKLIST_FILE.with_suffix(".part")
    part.write_text(json.dumps(worklist))
    os.replace(part, WORKLIST_FILE)


def add(kind, args, not_before=0, after=None):
    with lock:
        job = {"id": max([j["id"] for j in jobs], default=0) + 1, "kind": kind, "args": args, "status": "waiting",
               "not_before": not_before, "progress": {}, "log": [], "created": time.time()}
        if after:
            job["after"] = after
        jobs.append(job)
        save()
        return job


def find(job_id):
    return next((j for j in jobs if j["id"] == job_id), None)


def note(job, line):
    with lock:
        job["log"] = (job["log"] + [line])[-60:]
        save()


# --- processes -----------------------------------------------------------------------------------
def alive(pid):
    """Whether a process still runs. One this Studio started is reaped when it ends (else it lingers
    as a zombie, which still answers a signal); one an earlier Studio started is only checked."""
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
    except PermissionError:
        return True


def running(job):
    """Whether the job's tool still runs: its process is alive and really is that tool (after a
    restart, a pid can belong to something else by now)."""
    proc = procs.get(job["id"])
    if proc is not None and proc.pid == job.get("pid"):
        return proc.poll() is None
    pid = job.get("pid")
    # Renders started before jobs kept a tag are known by their queue file.
    tag = job.get("tag") or (str(render.QUEUES / f"{job['args']['queue']}.zip") if job["kind"] == "render" else None)
    if not tag or not alive(pid):
        return False
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        return False
    return tag in cmd


def attach(job, proc, tag):
    """Remember the tool a job just started."""
    with lock:
        procs[job["id"]] = proc
        job["pid"], job["tag"] = proc.pid, tag
        save()


def stop_group(pid):
    """Stop a tool's whole session: SIGTERM, then SIGKILL if it hasn't gone after STOP_GRACE_S. Never
    SIGSTOP (a stopped Wan2GP queue dies)."""
    for sig, wait in ((signal.SIGTERM, STOP_GRACE_S), (signal.SIGKILL, 10)):
        try:
            os.killpg(pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        end = time.time() + wait
        while time.time() < end:
            if not alive(pid):
                return
            time.sleep(0.5)


# --- cancel, pause -------------------------------------------------------------------------------
# Lock order: a project's file lock (project.editing) first, then this module's lock; never the other
# way round. So nothing that takes a project lock runs while `lock` is held.
def cancel(job_id):
    """Cancel a job. One running has its tool stopped first; its lane stays taken until it's gone.
    Clips of a render that didn't render go back to planned."""
    with lock:
        job = find(job_id)
        if not job or job["status"] not in ("waiting", "running", "paused"):
            return False
        stopping = job["status"] == "running" and bool(job.get("pid"))
        job["status"] = "cancelling" if stopping else "cancelled"
        if not stopping:
            job["ended"] = time.time()
        save()
    if stopping:
        threading.Thread(target=finish_cancel, args=(job,), daemon=True).start()
    else:
        after_cancel(job)
    return True


def finish_cancel(job):
    stop_group(job["pid"])
    after_cancel(job)
    with lock:
        job.update(status="cancelled", ended=time.time())
        save()
    settle_pause()


def after_cancel(job):
    if job["kind"] == "render":
        render.collect()  # a clip that finished just before is kept
        render.unqueue(job["args"]["queue"])
    elif job["kind"] == "picture":
        mark_draft(job, "failed")


def mark_draft(job, status):
    a = job["args"]
    if not Project.file(a["choom"]).exists():
        return
    with editing(a["choom"]) as proj:
        draft = proj.data.get("drafts", {}).get(a["look"])
        if draft is not None and draft.get("status") == "making":
            draft["status"] = status


def gpu_busy():
    return any(LANES[j["kind"]] == "gpu" and j["status"] in BUSY for j in jobs)


def state():
    with lock:
        return dict(worklist)


def pause():
    """Pause the work list: what's running on the GPU finishes (a render, the clip it's on), then
    nothing more starts there until resume()."""
    with lock:
        if not worklist["paused"]:
            worklist["pausing"] = gpu_busy()
            worklist["paused"] = not worklist["pausing"]
            worklist["since"] = time.time()
            save()
        return dict(worklist)


def resume():
    """Resume the work list: a render paused partway goes on from the clips it hadn't rendered, after
    what was queued while it was paused (paused to test something: the test goes first)."""
    with lock:
        since = worklist.get("since", 0)
        worklist.update(paused=False, pausing=False)
        held = [j for j in jobs if j["status"] == "paused"]
        # The work list runs in list order: what waited from before the pause moves behind what was queued during it.
        jobs.sort(key=lambda j: j["status"] in ("waiting", "paused") and j.get("created", 0) < since)
        save()
    for j in held:
        old = j["args"]["queue"]
        first = j["args"].get("first", old)
        new = f"{first}-r{2 + len(j['args'].get('earlier', []))}"
        left = render.requeue(old, new)
        with lock:
            if left:
                j["args"].update(queue=new, first=first, earlier=j["args"].get("earlier", []) + [old])
                j.update(status="waiting", progress={}, pid=None)
                j["log"] = (j["log"] + [f"resumed: {left} clips left, in queue {new}"])[-60:]
            else:
                j.update(status="done", ended=time.time())
            save()
    return state()


def settle_pause():
    """Pausing becomes paused once nothing runs on the GPU any more."""
    with lock:
        if worklist["pausing"] and not gpu_busy():
            worklist.update(pausing=False, paused=True)
            save()


# --- the work ------------------------------------------------------------------------------------
def do_render(job):
    """Run (or keep watching) a Wan2GP queue; finished clips are collected as they land, so they can
    be reviewed while the rest render, and each gets its sheet and checks. Pausing the work list
    stops Wan2GP once the clip it's on has landed; the rest stay queued for resume()."""
    name = job["args"]["queue"]
    since = job["started"]
    if not running(job):
        attach(job, render.start(name), str(render.QUEUES / f"{name}.zip"))
        with lock:
            job["queueStarted"] = time.time()  # a render resumed after a pause starts a new queue
    began = job.get("queueStarted") or since
    pause_from = None  # clips collected by the time the pause was asked for
    collected = 0
    while True:
        alive_now = running(job)
        with lock:
            if job["status"] != "running":  # cancelling: finish_cancel stops it
                return
            p = job["progress"] = render.progress(name)
            # The clip it's on counts by its denoising steps, so the estimate moves between clips too.
            p["left"] = time_left(p["done"] + int(p["step"].rstrip("%") or 0) / 100 if p["step"] else p["done"],
                                  p["total"], began)
            save()
        landed = render.collect()
        collected += len(landed)
        for cid in sorted({cid for cid, _ in landed}):
            add("review", {"choom": cid, "clips": [n for c, n in landed if c == cid]})
        if worklist["pausing"] and alive_now:
            if pause_from is None:
                pause_from = collected
                note(job, "pausing: Wan2GP stops once the clip it's on has landed")
            elif collected > pause_from:
                stop_group(job["pid"])
                for cid, n in render.collect():
                    add("review", {"choom": cid, "clips": [n]})
                with lock:
                    p = job["progress"]
                    job.update(status="paused", pid=None)
                    job["log"] = (job["log"] + [f"paused after {p.get('done', '?')} of {p.get('total', '?')} clips"])[-60:]
                    save()
                settle_pause()
                return
        if not alive_now:
            break
        time.sleep(10)
    time.sleep(35)  # the last clip settles before it's collected
    for cid, n in render.collect():
        add("review", {"choom": cid, "clips": [n]})
    stray = render.unmatched(since)
    missing = render.unqueue(name)  # anything that didn't render goes back to planned
    if stray:
        raise RuntimeError(f"Wan2GP wrote {len(stray)} videos that match no clip ({', '.join(stray[:4])}"
                           f"{' ...' if len(stray) > 4 else ''}): has its output naming changed? They're left in clips/."
                           + (f" {len(missing)} clips went back to planned." if missing else ""))
    if missing:
        raise RuntimeError(f"{len(missing)} clips didn't render and are planned again: {', '.join(missing)} (see queue/{name}.log)")


def time_left(done, total, began):
    """Seconds left at the pace so far (None until something is done)."""
    if done <= 0 or not total:
        return None
    return round(max(total - done, 0) * (time.time() - began) / done)


def tail(job, path, start):
    """Lines a tool wrote to its log since byte `start` go into the job's log; returns the new end
    and the lines."""
    try:
        with open(path, "rb") as f:
            f.seek(start)
            chunk = f.read()
    except OSError:
        return start, []
    lines = [l for l in chunk.decode(errors="replace").replace("\r", "\n").split("\n") if l.strip()]
    if lines:
        with lock:
            job["log"] = (job["log"] + lines)[-60:]
            save()
    return start + len(chunk), lines


def last_rates():
    """Seconds a clip took in each build step, from the latest builds that timed them."""
    rates = {}
    with lock:
        for j in reversed(jobs):
            for step, rate in (j.get("rates") or {}).items() if j["kind"] == "build" else ():
                rates.setdefault(step, rate)
    return {**build.RATE_GUESS, **rates}


def do_build(job):
    """Her build, a step at a time. A step still running when the Studio restarted is waited for and
    then run once more (it only redoes what didn't get done)."""
    cid = job["args"]["choom"]
    proj = Project.load(cid)
    trouble = build.problems(proj)
    if trouble:
        raise RuntimeError("; ".join(trouble))
    log_path = Path(job.get("logfile") or build.log_file(cid))
    with lock:
        job["logfile"] = str(log_path)
        job.setdefault("builtFrom", time.time())
        save()
    pos = log_path.stat().st_size if log_path.exists() else 0
    if running(job):  # picked up after a restart: let that run end, then run its step again
        note(job, f"waiting for the {job.get('stepName', 'build')} step an earlier Studio started")
        while running(job):
            pos = tail(job, log_path, pos)[0]
            time.sleep(2)
    plan = build.steps(proj)
    # Progress, as a render shows it: the clips this step works on (cut-outs only for new clips; the
    # reliefs say how many they encode, and until they do, the new clips are the guess), how many are
    # done, and the time left at this build's pace (the last build's before a clip is done), with
    # the reliefs still to come counted in while the cut-outs run.
    rates = last_rates()
    new = len(build.masks_todo(proj))
    for i, (step, cmd, tag) in enumerate(plan):
        if i < job.get("step", 0):
            continue
        total, done, began = new if step in ("masks", "reliefs") else 0, 0, time.time()

        def progress():
            rate = (time.time() - began) / done if done else rates.get(step, 0)
            later = sum(new * rates.get(s, 0) for s, _, _ in plan[i + 1:])
            job["progress"] = {"done": done, "total": total, "step": build.STEP_WORDS.get(step, step),
                               "stage": f"{i + 1}/{len(plan)}", "left": round(max(total - done, 0) * rate + later)}

        with lock:
            if job["status"] != "running":
                return
            job.update(step=i, stepName=step)
            progress()
            save()
        proc = build.start(cmd, log_path)
        attach(job, proc, tag)
        while True:
            ended = proc.poll() is not None
            pos, lines = tail(job, log_path, pos)
            for line in lines:
                if build.TOTAL_LINE.match(line):
                    total = int(build.TOTAL_LINE.match(line).group(1))
                elif build.DONE_LINE.get(step) and build.DONE_LINE[step].search(line):
                    done += 1
            with lock:
                progress()
                save()
            if ended:
                break
            time.sleep(2)
        with lock:
            if done:
                job.setdefault("rates", {})[step] = round((time.time() - began) / done, 1)
            if job["status"] != "running":  # cancelled meanwhile
                return
        if proc.returncode:
            raise RuntimeError(f"{os.path.basename(cmd[1])} failed (exit {proc.returncode}); see {log_path}")
    with lock:
        job.update(step=len(plan), pid=None)
        save()
    build.finish(cid, len(proj.sequence), job["builtFrom"])
    if job["args"].get("relaunch", True):
        relaunch_later(cid)
        note(job, f"{cid}: {len(proj.sequence)} clips built; the glass reloads at its next quiet moment")
    else:
        note(job, f"{cid}: {len(proj.sequence)} clips built")


def relaunch_later(cid):
    """One waiting relaunch job reloads the glass for every Choom built since, then prunes."""
    with lock:
        waiting = next((j for j in jobs if j["kind"] == "relaunch" and j["status"] == "waiting"), None)
        if waiting:
            if cid not in waiting["args"]["chooms"]:
                waiting["args"]["chooms"].append(cid)
            save()
            return waiting
    return add("relaunch", {"chooms": [cid]})


def do_relaunch(job):
    """Reload the glass once no Choom is talking (relaunch_when_quiet.sh waits up to ten minutes);
    if it stayed busy, try again in a few minutes. After a real reload, the videos and caches of
    clips that aren't hers any more are deleted."""
    log = lambda line: note(job, line)
    if not build.relaunch_now(log):
        when = time.time() + RELAUNCH_RETRY_S
        with lock:
            job.update(status="waiting", not_before=when, tries=job.get("tries", 0) + 1)
            job["log"] = (job["log"] + [f"the glass is busy; trying again at {time.strftime('%H:%M', time.localtime(when))}"])[-60:]
            save()
        return
    time.sleep(20)  # the page has asked for the new clips before the old videos go
    for cid in job["args"]["chooms"]:
        build.run(build.prune_cmd(cid), log)


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
    """Klein versions of a new look; they wait in her project's drafts until one is chosen. A Klein
    still running when the Studio restarted is waited for, and its pictures taken as usual."""
    a = job["args"]
    try:
        if not job.get("out"):
            proc, out = pictures.start_klein(a["choom"], a["look"], a["source"], a["prompt"], a.get("count", 3),
                                             refs=a.get("refs", ()))
            with lock:
                job["out"] = str(out)
            attach(job, proc, str(out / "settings.json"))
            code = proc.wait()
        else:
            while running(job):
                time.sleep(2)
            code = 0  # an earlier Studio's Klein: its exit code is gone; its pictures tell
        with lock:
            if job["status"] != "running":
                return
        names = pictures.finish_klein(a["choom"], a["look"], job["out"], code, log=lambda line: note(job, line))
    except Exception:
        mark_draft(job, "failed")
        raise
    with editing(a["choom"]) as proj:
        draft = proj.data.setdefault("drafts", {}).setdefault(a["look"], {})
        draft["pictures"] = draft.get("pictures", []) + names
        draft["status"] = "ready"


WORK = {"render": do_render, "build": do_build, "picture": do_picture, "still": do_still, "review": do_review,
        "relaunch": do_relaunch}


def ready(j, now):
    if j["status"] != "waiting" or j.get("not_before", 0) > now:
        return False
    first = find(j["after"]) if j.get("after") else None
    return not (first and first["status"] in ACTIVE)


def worker(lane):
    while True:
        job = None
        with lock:
            busy = any(j["status"] in BUSY and LANES[j["kind"]] == lane for j in jobs)
            held = lane == "gpu" and (worklist["paused"] or worklist["pausing"])
            if not busy and not held:
                job = next((j for j in jobs if LANES[j["kind"]] == lane and ready(j, time.time())), None)
            if job:
                job["status"] = "running"
                job.setdefault("started", time.time())
                job["started"] = job["started"] or time.time()
                save()
        if lane == "gpu":
            settle_pause()
        if not job:
            time.sleep(3)
            continue
        notify.job_started(job)
        run_job(job)


def run_job(job):
    try:
        WORK[job["kind"]](job)
        with lock:
            if job["status"] == "running":
                job["status"] = "done"
    except Exception as e:
        with lock:
            if job["status"] == "running":  # a cancelled job's tool exiting isn't a failure
                job["status"] = "failed"
                job["error"] = str(e)
        note(job, traceback.format_exc(limit=2))
    with lock:
        procs.pop(job["id"], None)
        if job["status"] in ("done", "failed", "cancelled"):
            job["ended"] = time.time()
        save()
    notify.job_ended(job)


def start_workers():
    """Pick up where the Studio left off. A render, build or picture whose tool still runs is watched
    again; a render whose Wan2GP is gone keeps what it finished (the rest go back to planned, or stay
    queued if the work list was pausing); a picture keeps any versions Klein finished; a build runs
    its step again; checks and relaunches run again; a job being cancelled is stopped."""
    load()
    later, gone, failed_pictures = [], [], []
    with lock:
        for j in jobs:
            if j["status"] == "cancelling":
                if running(j):
                    later.append((finish_cancel, j))
                else:
                    j.update(status="cancelled", ended=time.time())
                    gone.append((j, "cancelled"))
                continue
            if j["status"] != "running":
                continue
            kind = j["kind"]
            if kind == "render" and not running(j):
                if worklist["pausing"]:
                    j.update(status="paused", pid=None)
                    gone.append((j, "paused"))
                else:
                    gone.append((j, "gone"))
            elif kind == "picture" and not running(j) and not j.get("out"):
                j.update(status="failed", error="the Studio stopped before Klein started", ended=time.time())
                failed_pictures.append(j)
            elif kind == "still":
                j.update(status="failed", error="the Studio stopped while this ran", ended=time.time())
            elif kind in ("review", "relaunch"):
                j["status"] = "waiting"  # run again; they only redo what isn't done
            else:
                later.append((run_job, j))
        save()
    # Outside the jobs lock: these take project locks.
    for j, why in gone:
        if j["kind"] != "render":
            continue
        for cid, n in render.collect():
            add("review", {"choom": cid, "clips": [n]})
        if why == "gone":
            missing = render.unqueue(j["args"]["queue"])
            with lock:
                j.update(status="failed" if missing else "done", ended=time.time())
                if missing:
                    j["error"] = f"stopped while the Studio was down; planned again: {', '.join(missing)}"
                save()
        elif why == "cancelled":
            render.unqueue(j["args"]["queue"])
    for j in failed_pictures:
        mark_draft(j, "failed")
    for target, j in later:
        threading.Thread(target=target, args=(j,), daemon=True).start()
    for lane in ("gpu", "cpu", "glass"):
        threading.Thread(target=worker, args=(lane,), daemon=True).start()
    threading.Thread(target=notify.loop, args=(lambda: jobs, lock), daemon=True).start()
