"""A short Signal message when the night's work is done: once a scheduled render or build (or a run of
them, and the checks they bring) has finished or failed, through the Choom app's notification route,
in one Choom's Signal thread. What ends in the quiet hours waits until they're over, so it never
wakes anyone. Settings in studio.json:

    "notify": {"url": "http://donnys-mac-studio-3.local:3000",   the Choom app (empty: off)
               "choom": "Aloy",                                 whose thread it comes in (name or id)
               "quiet": [22, 7],                                held from 22:00 until 07:00 ("07:10" works too)
               "dry_run": false}                                only write it to studio.log

A run opens when a scheduled job (a time, or "after the render") starts, takes in every GPU job that
ends while it's open, and closes once nothing is running or due on the GPU or the checks lane.
State (the open run, finished runs held for the message, the last ones sent) is kept in studio/notify.json.
"""
import json
import threading
import time
import urllib.request

from config import CFG, DEFAULTS, PROJECTS
from project import Project

STATE_FILE = PROJECTS / "notify.json"
TRACKED = ("render", "build", "picture", "still")
_lock = threading.Lock()
state = {"run": None, "held": [], "sent": []}


def settings():
    return {**DEFAULTS["notify"], **(CFG.get("notify") or {})}


def load():
    global state
    try:
        state = {**state, **json.loads(STATE_FILE.read_text())}
    except (OSError, ValueError):
        pass


def save():
    part = STATE_FILE.with_suffix(".part")
    part.write_text(json.dumps(state, indent=1))
    part.replace(STATE_FILE)


def job_started(job):
    """A scheduled render or build starting opens a run."""
    if job["kind"] in ("render", "build") and (job.get("not_before") or job.get("after")):
        with _lock:
            if not state["run"]:
                state["run"] = {"opened": time.time(), "jobs": []}
                save()


def job_ended(job):
    with _lock:
        run = state["run"]
        if run and job["kind"] in TRACKED and job["status"] in ("done", "failed", "cancelled", "paused"):
            run["jobs"] = [j for j in run["jobs"] if j["id"] != job["id"]] + [{
                "id": job["id"], "kind": job["kind"], "status": job["status"], "args": job["args"],
                "error": (job.get("error") or "")[:200], "progress": job.get("progress") or {}}]
            save()


def minutes(when):
    """A time of day as minutes after midnight: 7, 7.5 or "07:10"."""
    if isinstance(when, str) and ":" in when:
        h, m = when.split(":", 1)
        return int(h) * 60 + int(m)
    return round(float(when) * 60)


def quiet(now=None, hours=None):
    """Inside the quiet hours: [22, 7] or ["22:00", "07:10"] (to land just after a 7 am briefing)."""
    start, end = (minutes(x) for x in (hours or settings()["quiet"]))
    t = time.localtime(now or time.time())
    m = t.tm_hour * 60 + t.tm_min
    return (m >= start or m < end) if start > end else start <= m < end


def to_review():
    """{choom name: (clips waiting for review, how many of them flagged)}."""
    out = {}
    for cid in Project.ids():
        proj = Project.load(cid)
        waiting = [c for c in proj.clips.values() if c["status"] == "rendered"]
        if waiting:
            out[proj.data.get("name", cid.title())] = (len(waiting), sum(1 for c in waiting if c.get("flags")))
    return out


def describe(j):
    a, p = j["args"], j.get("progress") or {}
    if j["kind"] == "render":
        total = p.get("total") or a.get("clips", "?")
        return f"Render: {p['done']} of {total} clips" if p.get("done") else f"Render of {total} clips"
    if j["kind"] == "build":
        return f"Build {str(a.get('choom', '?')).title()}"
    return f"{j['kind'].title()} {a.get('choom', '')}".strip()


def compose(run, more=False):
    """The message for a finished run; more: other work is still going when it's sent."""
    lines, failed = [], []
    for j in sorted(run["jobs"], key=lambda j: j["id"]):
        word = {"done": "done", "failed": "FAILED", "cancelled": "cancelled", "paused": "paused (work list paused)"}[j["status"]]
        lines.append(f"• {describe(j)}: {word}")
        if j["status"] == "failed" and j["error"]:
            failed.append(f"  {j['error'][:160]}")
    if any(j["status"] == "failed" for j in run["jobs"]):
        head = "Glass Studio: something failed."
    else:
        head = "Glass Studio: this run is done." if more else "Glass Studio: the work is done."
    return "\n".join([head] + lines + failed)


def still_going(jobs, now):
    """GPU work running, paused, waiting or scheduled as the message goes out: on 2026-10-17 the 7:10
    message said "the work is done" while the 5 am render was 50 clips into 73."""
    out = []
    for j in sorted(jobs, key=lambda j: j["id"]):
        if j["kind"] not in TRACKED or j["status"] not in ("running", "cancelling", "paused", "waiting"):
            continue
        if j["status"] in ("running", "cancelling"):
            when = "running"
        elif j["status"] == "paused":
            when = "paused"
        elif j.get("after"):
            first = next((x for x in jobs if x["id"] == j["after"]), None)
            when = f"after the {first['kind']} (job {j['after']})" if first else f"after job {j['after']}"
        elif j.get("not_before", 0) > now:
            when = "at " + time.strftime("%H:%M", time.localtime(j["not_before"]))
        else:
            when = "next in line"
        out.append(f"• {describe(j)}: {when}")
    return out


def message_for(held, jobs, now):
    """What goes out: each finished run, then what's still going, then what waits for review."""
    still = still_going(jobs, now)
    parts = [h.get("message") or compose(h["run"], more=bool(still)) for h in held]
    if still:
        parts.append("Still going:\n" + "\n".join(still))
    review = to_review()
    if review:
        parts.append("To review: " + ", ".join(f"{n} {k}" + (f" ({f} flagged)" if f else "") for n, (k, f) in sorted(review.items())))
    return "\n\n".join(parts)


def send(message):
    """Through the Choom app's notification route; True when it took it (or in a dry run)."""
    s = settings()
    if s.get("dry_run"):
        print(f"notify (dry run): {message!r}", flush=True)
        return True
    base = s["url"].rstrip("/")
    with urllib.request.urlopen(f"{base}/api/chooms", timeout=10) as r:
        chooms = json.load(r)
    chooms = chooms if isinstance(chooms, list) else chooms.get("chooms", [])
    who = str(s["choom"]).lower()
    choom = next((c for c in chooms if c.get("id") == s["choom"] or str(c.get("name", "")).lower() == who), None)
    if not choom:
        raise RuntimeError(f"no Choom called {s['choom']} in the Choom app")
    body = json.dumps({"choomId": choom["id"], "message": message, "includeAudio": False}).encode()
    req = urllib.request.Request(f"{base}/api/notifications", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return 200 <= r.status < 300


def tick(jobs, jobs_lock, now=None):
    """Close a finished run into a held message; send held messages outside the quiet hours."""
    now = now or time.time()
    s = settings()
    with jobs_lock:
        busy = any(j["status"] in ("running", "cancelling") or (j["status"] == "waiting" and j.get("not_before", 0) <= now
                   and j["kind"] in TRACKED + ("review",)) for j in jobs if j["kind"] != "relaunch")
        jobs = [dict(j) for j in jobs]
    with _lock:
        if state["run"] and state["run"]["jobs"] and not busy:
            # Held as the run itself: the message is written as it goes out, with what's going on then.
            state["held"] = (state["held"] + [{"at": now, "run": state["run"]}])[-10:]  # off, they'd pile up
            state["run"] = None
            save()
        elif state["run"] and not state["run"]["jobs"] and not busy and now - state["run"]["opened"] > 3600:
            state["run"] = None  # opened by a job that never ended here (the Studio restarted)
            save()
        if not state["held"] or quiet(now, s["quiet"]) or not (s.get("url") or s.get("dry_run")) or not s.get("choom"):
            return
        held = state["held"]
    message = message_for(held, jobs, now)
    try:
        ok = send(message)
    except Exception as e:  # the Mac asleep, the app restarting: try again next time
        print(f"notify: couldn't send ({e}); trying again later", flush=True)
        return
    if ok:
        with _lock:
            state["held"] = state["held"][len(held):]
            state["sent"] = (state["sent"] + [{"at": now, "message": message, "dry": bool(s.get("dry_run"))}])[-10:]
            save()


def loop(get_jobs, jobs_lock, every=30):
    load()
    while True:
        time.sleep(every)
        try:
            tick(get_jobs(), jobs_lock)
        except Exception as e:
            print(f"notify: {e}", flush=True)
