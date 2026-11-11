#!/usr/bin/env python3
"""
Weekly restart of the Choom dev server: Next.js and the memory server, launchd com.choom.dev.

Why: `next dev` grows for as long as it runs. After 17 days in October it held 90 GB and paused for
garbage collection about once a minute, which spun the Mac's fans (2026-10-26). Five days after a
restart it was at 13.9 GB (2026-11-11). Donny asked for a restart once a week "between their
followups and cron jobs so it does not scramble anything", at 1:30 am.

launchd (com.choom.weekly-restart) starts this on Sunday at 1:30. It waits for a quiet moment:
  - no Choom turn under way: GET /api/turns says open 0. A turn older than STALE_TURN_MIN counts as
    stuck, not open.
  - no self-followup due from FOLLOWUP_BEFORE_MIN ago to FOLLOWUP_AFTER_MIN ahead
    (data/self_followups/*/pending/*.json), so none fires while the server is down.
  - no bridge task (bridge-config.json tasks with a time) due within TASK_MARGIN_MIN.
  - all of that on two checks in a row, CHECK_EVERY_S apart.
It gives up at GIVE_UP_AT (clear of Aloy's 2:20 watch), which waits a week. Then `launchctl
kickstart -k` restarts the agent, and the script waits for the app and the memory server to answer.
If they don't within READY_WAIT_S, it kicks once more. Everything goes to
data/logs/weekly-restart.log.

The bridge's quiet hours (21:00-06:00) hold back its health alerts, so the minute the app is down
sends nobody a message. If it stayed down, the bridge's first health check after 6:00 tells Donny.

By hand: python3 scripts/weekly-restart.py --dry-run   (says what it would do, restarts nothing)
         python3 scripts/weekly-restart.py --now       (any hour; still waits for a quiet moment)
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = "http://127.0.0.1:3000"
MEMORY = "http://127.0.0.1:8100/"
LABEL = "com.choom.dev"
LOG = os.path.join(APP_ROOT, "data", "logs", "weekly-restart.log")

START_AFTER = (1, 25)       # launchd starts it at 1:30; a late start (the Mac was off) is skipped
GIVE_UP_AT = (2, 5)
CHECK_EVERY_S = 30
STALE_TURN_MIN = 45
FOLLOWUP_BEFORE_MIN = 5
FOLLOWUP_AFTER_MIN = 15
TASK_MARGIN_MIN = 15
READY_WAIT_S = 240


def log(text):
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {text}"
    print(line, flush=True)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def get(url, timeout=10):
    """(status, body); status 0 means nothing answered."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except (urllib.error.URLError, OSError):
        return 0, ""


def turns_busy():
    """Why it isn't quiet in the app, or None. 'down' when nothing answers."""
    status, body = get(f"{APP}/api/turns")
    if status == 0:
        return "down"
    if status != 200:
        return f"GET /api/turns answered {status}"
    turns = json.loads(body).get("turns", [])
    live = [t for t in turns if t.get("seconds", 0) < STALE_TURN_MIN * 60]
    for t in turns:
        if t not in live:
            log(f"  ignoring a turn open {t['seconds'] // 60} min (stuck?): {t['who']} ({t['kind']})")
    if live:
        return "turns under way: " + ", ".join(f"{t['who']} ({t['kind']})" for t in live)
    return None


def followups_due(now_utc):
    """Self-followups due close to now (any Choom)."""
    near = []
    for path in glob.glob(os.path.join(APP_ROOT, "data", "self_followups", "*", "pending", "*.json")):
        try:
            with open(path) as f:
                entry = json.load(f)
            when = datetime.fromisoformat(entry["trigger_at"].replace("Z", "+00:00"))
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        if now_utc - timedelta(minutes=FOLLOWUP_BEFORE_MIN) <= when <= now_utc + timedelta(minutes=FOLLOWUP_AFTER_MIN):
            near.append(f"{entry.get('choom_name', '?')} at {when.astimezone().strftime('%H:%M')}")
    return near


def tasks_due(now_local):
    """Bridge tasks with a clock time close to now (backup, music download, briefing...)."""
    try:
        with open(os.path.join(APP_ROOT, "services", "signal-bridge", "bridge-config.json")) as f:
            tasks = json.load(f).get("tasks", {})
    except (OSError, ValueError):
        return []
    near = []
    for name, task in tasks.items():
        if not isinstance(task, dict) or not task.get("enabled") or not task.get("time"):
            continue
        try:
            h, m = (int(x) for x in str(task["time"]).split(":")[:2])
        except ValueError:
            continue
        at = now_local.replace(hour=h, minute=m, second=0, microsecond=0)
        if abs((at - now_local).total_seconds()) <= TASK_MARGIN_MIN * 60:
            near.append(f"{name} at {task['time']}")
    return near


def not_quiet():
    """Why now isn't a good moment, or None. 'down' when the app doesn't answer at all."""
    busy = turns_busy()
    if busy == "down":
        return "down"
    reasons = [busy] if busy else []
    due = followups_due(datetime.now(timezone.utc))
    if due:
        reasons.append("followups due: " + ", ".join(due))
    tasks = tasks_due(datetime.now())
    if tasks:
        reasons.append("bridge tasks due: " + ", ".join(tasks))
    return "; ".join(reasons) or None


def sizes():
    """How big the server processes are, for the log (MB)."""
    try:
        out = subprocess.run(["ps", "-axo", "rss=,command="], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return "?"
    parts = []
    for line in out.splitlines():
        rss, _, cmd = line.strip().partition(" ")
        if cmd.startswith("next-server"):
            parts.append(f"next-server {int(rss) // 1024} MB")
        elif cmd.rstrip().endswith("Python run.py"):  # the memory server (its sh -c parent doesn't count)
            parts.append(f"memory {int(rss) // 1024} MB")
    return ", ".join(parts) or "no server processes found"


def ready():
    return get(f"{APP}/api/turns")[0] == 200 and get(MEMORY)[0] == 200


def kick():
    target = f"gui/{os.getuid()}/{LABEL}"
    result = subprocess.run(["launchctl", "kickstart", "-k", target], capture_output=True, text=True)
    if result.returncode != 0:
        log(f"  launchctl kickstart failed ({result.returncode}): {result.stderr.strip()}")
    deadline = time.time() + READY_WAIT_S
    while time.time() < deadline:
        time.sleep(5)
        if ready():
            return True
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--now", action="store_true", help="run at any hour (still waits for a quiet moment)")
    parser.add_argument("--dry-run", action="store_true", help="say what it would do; restart nothing")
    args = parser.parse_args()

    now = datetime.now()
    if not args.now and not args.dry_run and not (START_AFTER <= (now.hour, now.minute) < GIVE_UP_AT):
        log(f"started at {now:%H:%M}, outside {START_AFTER[0]}:{START_AFTER[1]:02d}-{GIVE_UP_AT[0]}:{GIVE_UP_AT[1]:02d}; skipped until next week")
        return 0

    if args.dry_run:
        why = not_quiet()
        print(f"{sizes()}\n" + (f"would wait: {why}" if why else "quiet: would restart after one more quiet check"))
        return 0

    log(f"weekly restart: {sizes()}")
    give_up = now.replace(hour=GIVE_UP_AT[0], minute=GIVE_UP_AT[1], second=0, microsecond=0)
    if args.now or give_up <= now:
        give_up = now + timedelta(minutes=40)
    quiet_checks = 0
    said = None
    while True:
        why = not_quiet()
        if why == "down":
            log("  the app isn't answering; restarting it now")
            break
        if why:
            quiet_checks = 0
            if why != said:  # each new reason once, not every check
                log(f"  waiting: {why}")
                said = why
        else:
            quiet_checks += 1
            if quiet_checks >= 2:
                break
        if datetime.now() >= give_up:
            log(f"  no quiet moment by {give_up:%H:%M}; not restarted this week")
            return 0
        time.sleep(CHECK_EVERY_S)

    log("  quiet: restarting " + LABEL)
    started = time.time()
    if kick():
        log(f"  back in {time.time() - started:.0f} s: {sizes()}")
        get(f"{APP}/", timeout=120)  # dev mode builds the page on its first visit; do it now
        return 0
    log(f"  not answering after {READY_WAIT_S} s; kicking once more")
    if kick():
        log(f"  back after the second kick: {sizes()}")
        return 0
    log("  STILL DOWN: the app or the memory server isn't answering. Check data/logs/choom-dev.log")
    return 1


if __name__ == "__main__":
    sys.exit(main())
