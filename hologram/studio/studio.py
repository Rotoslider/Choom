#!/usr/bin/env python3
"""Glass Studio: make and manage the clips that bring a Choom to life on the Looking Glass.

    python3 studio/studio.py serve                       the Studio page (http://127.0.0.1:8767)
    python3 studio/studio.py status [CHOOM]              clips per status, looks, what's on the glass
    python3 studio/studio.py packs CHOOM LOOK            the library's actions for a look
    python3 studio/studio.py plan CHOOM LOOK PACK [KEY ...]   plan clips (all of a pack, or some)
    python3 studio/studio.py render CHOOM [CHOOM ...] [--queue NAME]   queue her planned clips, render them
    python3 studio/studio.py collect                     rename finished renders, mark them rendered
    python3 studio/studio.py review CHOOM [CLIP ...]     contact sheets and checks (Wan2GP's Python)
    python3 studio/studio.py keep|drop CHOOM CLIP ...    decide on rendered clips
    python3 studio/studio.py place|remove CHOOM CLIP ... put kept clips on the glass, or take them off
    python3 studio/studio.py build CHOOM [--no-relaunch]   build her sequence and reload the glass
    python3 studio/studio.py import [CHOOM ...]          adopt clips made before the Studio

Settings: ~/.config/choom-hologram/studio.json (see config.py). The Studio page does all of this too.
"""
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402
import plan  # noqa: E402
import render  # noqa: E402
from config import WAN2GP_PYTHON  # noqa: E402
from project import Project, editing  # noqa: E402

HERE = Path(__file__).resolve().parent


def status(args):
    for cid in args or Project.ids():
        proj = Project.load(cid)
        s = proj.summary()
        counts = ", ".join(f"{v} {k}" for k, v in s["counts"].items() if v)
        print(f"{s['name']}: {counts}; {s['onGlass']} on the glass")
        for look, n in sorted(s["looks"].items()):
            print(f"    {look:22} {n:4} clips  ({proj.looks.get(look, {}).get('picture') or 'no picture'})")
        trouble = build.problems(proj)
        if trouble:
            print("    to fix before building: " + "; ".join(trouble))


def packs(args):
    proj = Project.load(args[0])
    for o in plan.options(proj, args[1]):
        have = f"  (has {', '.join(o['have'])})" if o["have"] else ""
        print(f"{o['pack']:12} {o['key']:14} {o['seconds']}s {'[hands] ' if o['hands'] else ''}{o['name']}{have}")


def plan_cmd(args):
    cid, look, pack, keys = args[0], args[1], args[2], set(args[3:])
    with editing(cid) as proj:
        if look not in proj.looks:
            raise SystemExit(f"{cid} has no {look} look (looks: {', '.join(proj.looks)})")
        lib = plan.library()["actions"]
        items = [a for a in lib if a["pack"] == pack and (not keys or a["key"] in keys)]
        if not keys:  # a whole pack: only what she doesn't have yet
            have = {o["key"] for o in plan.options(proj, look) if o["pack"] == pack and o["have"]}
            items = [a for a in items if a["key"] not in have]
        for name, message in plan.add(proj, look, items):
            print(f"{name or '-':40} {message}")


def render_cmd(args):
    chooms = [a for a in args if not a.startswith("--")]
    name = args[args.index("--queue") + 1] if "--queue" in args else time.strftime("studio_%Y%m%d-%H%M%S")
    chooms = [c for c in chooms if c != name]
    picks = [(cid, n) for cid in chooms for n, c in Project.load(cid).clips.items() if c["status"] == "planned"]
    if not picks:
        raise SystemExit("nothing planned")
    render.make_queue(name, picks)
    print(f"queue {name}: {len(picks)} clips, about {round(sum(render.minutes(Project.load(c).clips[n]['frames']) for c, n in picks))} minutes")
    proc = render.start(name)
    while proc.poll() is None:
        time.sleep(15)
        p = render.progress(name)
        for cid, n in render.collect():
            print(f"  rendered {n}")
        print(f"  {p['done']}/{p['total']} {p['step']}", end="\r")
    for cid, n in render.collect():
        print(f"  rendered {n}")
    render.unqueue(name)
    print(f"\nqueue {name} finished: {render.progress(name)}")


def decide(status_name, args):
    with editing(args[0]) as proj:
        for n in args[1:]:
            proj.set_status(n, status_name)


def place(on, args):
    with editing(args[0]) as proj:
        for n in args[1:]:
            proj.place(n, on)
    print(f"{len(Project.load(args[0]).sequence)} clips in her sequence (build to put them on the glass)")


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "serve":
        import server
        server.serve()
    elif cmd == "status":
        status(args)
    elif cmd == "packs":
        packs(args)
    elif cmd == "plan":
        plan_cmd(args)
    elif cmd == "render":
        render_cmd(args)
    elif cmd == "collect":
        for cid, n in render.collect():
            print(f"{cid}: {n}")
    elif cmd == "review":
        subprocess.run([str(WAN2GP_PYTHON), str(HERE / "review.py"), *args], check=True)
    elif cmd in ("keep", "drop"):
        decide({"keep": "kept", "drop": "dropped"}[cmd], args)
    elif cmd in ("place", "remove"):
        place(cmd == "place", args)
    elif cmd == "build":
        build.build(args[0], relaunch="--no-relaunch" not in args)
    elif cmd == "import":
        subprocess.run([sys.executable, str(HERE / "import_existing.py"), *args], check=True)
    else:
        raise SystemExit(f"unknown command {cmd}; see studio.py help")


if __name__ == "__main__":
    main()
