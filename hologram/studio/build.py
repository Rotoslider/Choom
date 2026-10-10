"""Putting a Choom's sequence on the glass: cut-outs, depth and the moving reliefs, then a relaunch
when she's quiet, then the old videos are cleared away.

    1. tools/make_alive_masks.py   U2-Net cut-outs (Wan2GP's Python), new clips only
    2. tools/make_alive.py         depth, mouth tracking, the relief videos and alive.json (Forge
                                   Neo's Python); only new or changed clips are encoded
    3. tools/relaunch_when_quiet.sh   the page reloads her clips once no Choom is talking
    4. make_alive.py --prune       deletes videos of clips no longer in her sequence
"""
import os
import subprocess
import time

import json

from config import CLIPS, FORGE_PYTHON, HOLOGRAM, PICTURES, PORTRAITS, TOOLS, WAN2GP, WAN2GP_PYTHON
from project import Project, editing


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
    for look in sorted(looks - talkers - {"full", "asleep"}):
        out.append(f"the {look} look has no clip she can talk over (its base loop)")
    return out


def run(cmd, log, env=None):
    """Run a step, passing its output to log(line); raises if it fails."""
    log("$ " + " ".join(str(c) for c in cmd[:3]) + (f" ... ({len(cmd) - 3} more)" if len(cmd) > 3 else ""))
    proc = subprocess.Popen([str(c) for c in cmd], cwd=HOLOGRAM, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, env={**os.environ, "PYTHONUNBUFFERED": "1", **(env or {})},
                            start_new_session=True)  # unbuffered: each clip's line shows as it's written
    for line in proc.stdout:
        log(line.rstrip())
    if proc.wait() != 0:
        raise RuntimeError(f"{cmd[1]} failed (exit {proc.returncode})")


def still(cid, color, style="motes", log=print, relaunch=True):
    """A new Choom's still relief from her main picture (cut-out, depth, plate, mouth) and her entry
    in portraits/manifest.json, so the glass knows her; she shows it until her clips are built."""
    proj = Project.load(cid)
    picture = PICTURES / proj.looks["main"]["picture"]
    run([WAN2GP_PYTHON, TOOLS / "make_masks.py", cid, picture], log, env={"U2NET_HOME": str(WAN2GP / "ckpts" / "rembg")})
    run([FORGE_PYTHON, TOOLS / "make_depth.py", cid, picture, proj.data.get("name", cid.title()), color, style], log)
    run([FORGE_PYTHON, TOOLS / "make_landmarks.py", cid], log)
    if relaunch:
        run([TOOLS / "relaunch_when_quiet.sh"], log)
    log(f"{cid} is on the glass (her still relief until her clips are built)")


def build(cid, log=print, relaunch=True):
    proj = Project.load(cid)
    trouble = problems(proj)
    if trouble:
        raise RuntimeError("; ".join(trouble))
    sources = [CLIPS / f"{n}.mp4" for n in proj.sequence]
    started = time.time()
    run([WAN2GP_PYTHON, TOOLS / "make_alive_masks.py", cid, *sources], log,
        env={"U2NET_HOME": str(WAN2GP / "ckpts" / "rembg")})
    run([FORGE_PYTHON, TOOLS / "make_alive.py", cid, *sources], log)
    with editing(cid) as p:
        p.data["built"] = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "clips": len(sources),
                           "minutes": round((time.time() - started) / 60, 1)}
    if relaunch:
        run([TOOLS / "relaunch_when_quiet.sh"], log)
        time.sleep(20)  # the page has asked for her new clips before the old videos go
        run([FORGE_PYTHON, TOOLS / "make_alive.py", cid, "--prune"], log)
    log(f"{cid}: {len(sources)} clips on the glass")
