"""Putting a Choom's sequence on the glass: cut-outs, depth and the moving reliefs, then a relaunch
when she's quiet, then the old videos are cleared away.

    1. tools/make_alive_masks.py   U2-Net cut-outs (Wan2GP's Python), new clips only
    2. tools/make_alive.py         depth, mouth tracking, the relief videos and alive.json (Forge
                                   Neo's Python); only new or changed clips are encoded
    3. her closet                  closet.json, what she can ask the glass for
    4. a relaunch job (jobs.py)    tools/relaunch_when_quiet.sh once no Choom is talking, tried again
                                   until the glass is quiet; then make_alive.py --prune deletes videos
                                   and caches of clips that aren't hers any more

Each step runs in its own session and writes to studio/logs/build_<choom>.log rather than a pipe, so
a Studio restart neither kills it nor loses it: the job picks the step up again (jobs.py).
"""
import json
import os
import re
import subprocess
import time

from config import CLIPS, FORGE_PYTHON, HOLOGRAM, PICTURES, PORTRAITS, PROJECTS, RUN_TOOLS as TOOLS, WAN2GP, WAN2GP_PYTHON
from project import Project, base_of, editing

LOGS = PROJECTS / "logs"

# How far a step has got, from its log: a line for each clip it has done (cut-outs it skips print
# "already made" and aren't counted), and the reliefs' first line, how many clips it will encode.
STEP_WORDS = {"masks": "cut-outs", "reliefs": "reliefs"}
DONE_LINE = {"masks": re.compile(r"masks -> alive_masks_"), "reliefs": re.compile(r"^\s*wrote alive_\S+\.mp4")}
TOTAL_LINE = re.compile(r"^encoding (\d+) of \d+ clips")
# Seconds a clip takes in each step until a build has timed its own (Oct 25, a five-second clip:
# U2-Net about 10 s on the GPU, depth and the relief video about 37 s).
RATE_GUESS = {"masks": 10.0, "reliefs": 40.0}


def in_manifest(cid):
    manifest = PORTRAITS / "manifest.json"
    return manifest.exists() and any(m["id"] == cid for m in json.loads(manifest.read_text()))


def problems(proj):
    """Why her sequence can't be built yet, if anything."""
    out = [] if in_manifest(proj.id) else ["she isn't on the glass yet: make her still relief first (On the glass)"]
    if not proj.sequence:
        return out + ["her sequence is empty"]
    main = proj.clips.get(proj.sequence[0], {})
    if "talk" not in main.get("moods", []):
        out.append(f"{proj.sequence[0]} comes first but isn't a loop she can talk over (base)")
    missing = [n for n in proj.sequence if not (CLIPS / f"{n}.mp4").exists()]
    if missing:
        out.append(f"no clip file for {', '.join(missing[:5])}" + (" ..." if len(missing) > 5 else ""))
    looks = {proj.clips[n]["from"] for n in proj.sequence if n in proj.clips}
    talkers = {proj.clips[n]["from"] for n in proj.sequence if n in proj.clips and "talk" in proj.clips[n]["moods"]}
    for look in sorted(l for l in looks - talkers if base_of(l) not in ("full", "asleep", "gone")):  # a place needs one
        out.append(f"the {look} look has no clip she can talk over (its base loop)")
    return out


def home_of(proj):
    """The pose she falls asleep from, wakes into and changes clothes in (her project's "home")."""
    return proj.data.get("home") or "main"


def env():
    """What every tool run gets: unbuffered output, and the portraits folder the Studio uses (a test
    Studio's is elsewhere, so it never writes the real glass)."""
    return {**os.environ, "PYTHONUNBUFFERED": "1", "HOLOGRAM_PORTRAITS": str(PORTRAITS),
            "U2NET_HOME": str(WAN2GP / "ckpts" / "rembg")}


def steps(proj):
    """The build's tool runs, in order: (name, command, what its process's command line contains)."""
    sources = [str(CLIPS / f"{n}.mp4") for n in proj.sequence]
    return [("masks", [str(WAN2GP_PYTHON), str(TOOLS / "make_alive_masks.py"), proj.id, *sources], "make_alive_masks.py"),
            ("reliefs", [str(FORGE_PYTHON), str(TOOLS / "make_alive.py"), proj.id, "--home", home_of(proj), *sources],
             "make_alive.py")]


def masks_todo(proj):
    """The clips in her sequence that make_alive_masks.py cuts out (new, or remade since their cut-out),
    by its own rule; it skips the rest at once."""
    folder = PORTRAITS / proj.id
    out = []
    for n in proj.sequence:
        cut, src = folder / f"alive_masks_{n}.npz", CLIPS / f"{n}.mp4"
        if not (cut.exists() and src.exists() and cut.stat().st_mtime >= src.stat().st_mtime):
            out.append(n)
    return out


def log_file(cid):
    LOGS.mkdir(parents=True, exist_ok=True)
    return LOGS / f"build_{cid}.log"


def start(cmd, log_path):
    """A tool run in its own session (a Studio restart doesn't stop it), its output appended to log_path."""
    out = open(log_path, "a")
    out.write(f"\n$ {' '.join(os.path.basename(c) for c in cmd[:3])} ...\n")
    out.flush()
    try:
        return subprocess.Popen(cmd, cwd=HOLOGRAM, stdout=out, stderr=subprocess.STDOUT, env=env(), start_new_session=True)
    finally:
        out.close()


def finish(cid, clips, started):
    """After the tools: her closet from the project as it is now (closet words changed during the
    build count), and the build recorded."""
    with editing(cid) as p:
        p.write_closet()
        p.data["built"] = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "clips": clips,
                           "minutes": round((time.time() - started) / 60, 1)}


def keep_list(cid):
    """studio/logs/keep_<choom>.txt: the clips whose cut-out and depth caches a prune keeps (every
    clip of hers that isn't dropped), one name per line."""
    proj = Project.load(cid)
    LOGS.mkdir(parents=True, exist_ok=True)
    f = LOGS / f"keep_{cid}.txt"
    f.write_text("".join(f"{n}\n" for n in sorted(n for n, c in proj.clips.items() if c["status"] != "dropped")))
    return f


def prune_cmd(cid):
    return [str(FORGE_PYTHON), str(TOOLS / "make_alive.py"), cid, "--prune", "--keep-file", str(keep_list(cid))]


def run(cmd, log):
    """Run a tool to the end, passing its output to log(line); raises if it fails (the command line
    and still reliefs; the Studio's builds go through jobs.py)."""
    log("$ " + " ".join(os.path.basename(str(c)) for c in cmd[:3]) + (f" ... ({len(cmd) - 3} more)" if len(cmd) > 3 else ""))
    proc = subprocess.Popen([str(c) for c in cmd], cwd=HOLOGRAM, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, env=env(), start_new_session=True)
    for line in proc.stdout:
        log(line.rstrip())
    if proc.wait() != 0:
        name = os.path.basename(str(cmd[1] if len(cmd) > 1 else cmd[0]))  # the script, or a lone command
        raise RuntimeError(f"{name} failed (exit {proc.returncode})")


def still(cid, color, style="motes", log=print, relaunch=True):
    """A new Choom's still relief from her main picture (cut-out, depth, plate, mouth) and her entry
    in portraits/manifest.json, so the glass knows her; she shows it until her clips are built."""
    proj = Project.load(cid)
    picture = PICTURES / proj.looks["main"]["picture"]
    run([WAN2GP_PYTHON, TOOLS / "make_masks.py", cid, picture], log)
    run([FORGE_PYTHON, TOOLS / "make_depth.py", cid, picture, proj.data.get("name", cid.title()), color, style], log)
    run([FORGE_PYTHON, TOOLS / "make_landmarks.py", cid], log)
    if relaunch:
        relaunch_now(log)
    log(f"{cid} is on the glass (her still relief until her clips are built)")


def relaunch_now(log):
    """tools/relaunch_when_quiet.sh: True once the glass has reloaded, False if it stayed busy (it
    waits up to ten minutes for no Choom to be talking)."""
    proc = subprocess.run([str(TOOLS / "relaunch_when_quiet.sh")], cwd=HOLOGRAM, capture_output=True, text=True, env=env())
    for line in (proc.stdout + proc.stderr).strip().splitlines():
        log(line)
    return proc.returncode == 0


def build(cid, log=print, relaunch=True):
    """The whole build in one go, for the command line when the Studio isn't running (the Studio's
    build job runs the same steps, see jobs.py)."""
    proj = Project.load(cid)
    trouble = problems(proj)
    if trouble:
        raise RuntimeError("; ".join(trouble))
    started = time.time()
    for _, cmd, _ in steps(proj):
        run(cmd, log)
    finish(cid, len(proj.sequence), started)
    if relaunch:
        if relaunch_now(log):
            time.sleep(20)  # the page has asked for her new clips before the old videos go
            run(prune_cmd(cid), log)
        else:
            log("the glass stayed busy: it shows the new clips at its next relaunch (prune after that)")
    log(f"{cid}: {len(proj.sequence)} clips on the glass")
