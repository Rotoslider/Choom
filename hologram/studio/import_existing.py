#!/usr/bin/env python3
"""Adopt a Choom's clips made before Glass Studio into her project file.

Reads the render queues in the workspace (queue/<name>.zip, each with queue/<name>_plan.json mapping
seed -> clip name) for every clip's prompt, seed and pictures, the clips in clips/, and her
alive.json on the glass for what is on it now. Clips on the glass become kept and stay in her
sequence; other rendered clips become dropped (they can be kept again on the review page). A clip
rendered more than once keeps its latest take, the earlier ones go in its history.

    python3 studio/import_existing.py aloy optic genesis eve [--force]
"""
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from config import CLIPS, PORTRAITS, QUEUES, ensure_workspace  # noqa: E402
from project import Project, roles  # noqa: E402
import prompts  # noqa: E402


def queued_takes():
    """{clip name: [take, ...]} oldest first, a take being {queue, seed, prompt, frames, start, end}."""
    takes = defaultdict(list)
    for z in sorted(QUEUES.glob("*.zip"), key=lambda z: z.stat().st_mtime):
        plan_file = QUEUES / f"{z.stem}_plan.json"
        if not plan_file.exists():
            continue
        plan = json.loads(plan_file.read_text())
        for task in json.loads(zipfile.ZipFile(z).read("queue.json")):
            p = task["params"]
            name = plan.get(str(p["seed"]))
            if name:
                takes[name].append({"queue": z.stem, "seed": p["seed"], "prompt": p["prompt"],
                                    "frames": p["video_length"], "start": p.get("image_start"),
                                    "end": p.get("image_end") or p.get("image_start")})
    return takes


def wardrobe_hints(proj):
    """For each look her outfits were made from: the subject line with the clothes left open
    ("... wearing {wearing}, glows softly against ..."), from what her outfits' lines share, and what
    the Klein edits kept unchanged ("her face, expression, freckles, ..."), from their settings."""
    from collections import defaultdict
    from config import PICTURES
    import os
    by_base = defaultdict(list)
    for look_id, look in proj.looks.items():
        # Her outfits (the names the glass knows: cold, hot, evening, day...), not her other looks
        # (Genesis plain, Optic without her heart), which change more than her clothes.
        if re.match(r"\w+@(cold|hot|evening|day)", look_id) and look.get("subject"):
            by_base[look_id.split("@")[0]].append(look["subject"])
    for base, subjects in by_base.items():
        if len(subjects) < 2 or base not in proj.looks:
            continue
        head = os.path.commonprefix(subjects)
        tail = os.path.commonprefix([s[::-1] for s in subjects])[::-1]
        cut = max(head.rfind("wearing "), head.rfind(" and "))
        if cut < 0:
            continue
        head = head[:cut] + ("wearing " if head[cut:].startswith("wearing ") else " and ")
        comma = tail.find(", ")
        if comma < 0:
            continue
        proj.looks[base]["wardrobe"] = head + "{wearing}" + tail[comma:]
    for f in sorted(PICTURES.glob(f"{proj.id}_*.json")):
        try:
            settings = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        prompt = settings.get("prompt", "")
        m = re.match(r"Change her clothes: .*? Keep everything else exactly the same: (.*?),? (?:the (?:warm studio )?lighting)", prompt)
        refs = [os.path.basename(r) for r in settings.get("image_refs", [])]
        for look in proj.looks.values():
            if m and refs and look.get("picture") == refs[0]:
                look["kleinKeep"] = m.group(1)


def import_choom(cid, takes, names):
    alive_file = PORTRAITS / cid / "alive.json"
    on_glass = [c["source"].removesuffix(".mp4") for c in json.loads(alive_file.read_text())["clips"]] if alive_file.exists() else []
    proj = Project.new(cid, names.get(cid, cid.title()))
    files = sorted(f.stem for f in CLIPS.glob(f"{cid}_*.mp4"))
    for name in files:
        mine = takes.get(name, [])
        last = mine[-1] if mine else {}
        status = "kept" if name in on_glass else "dropped"
        clip = proj.add_clip(name, prompt=last.get("prompt", ""), seed=last.get("seed"), frames=last.get("frames"),
                             start=last.get("start"), end=last.get("end"), queue=last.get("queue"), status=status,
                             note="" if status == "kept" else "not on the glass when the Studio started")
        if len(mine) > 1:
            clip["history"] = [{"seed": t["seed"], "queue": t["queue"], "status": "dropped", "note": "re-rolled"} for t in mine[:-1]]
    proj.data["sequence"] = [n for n in on_glass if n in proj.clips]

    # Her looks, from her clips: each pose's picture, subject line and loop ending, by majority
    # (preferring wording with the current lessons in it).
    by_pose = defaultdict(lambda: {"pictures": Counter(), "subjects": Counter(), "endings": Counter(),
                                   "firsts": []})
    for name, c in proj.clips.items():
        parts = prompts.split(c["prompt"]) if c["prompt"] else None
        look = by_pose[c["from"]]
        if c["from"] == c["to"] and c.get("start"):
            look["pictures"][c["start"]] += 1
        if parts:
            look["subjects"][parts[1]] += 1
            look["firsts"].append((c.get("seed") or 0, parts[2].split(". ", 1)[0].rstrip(".") + "."))
            if c["from"] == c["to"] and "ends exactly as she began" in parts[3]:
                look["endings"][parts[3]] += 1
    for pose, seen in sorted(by_pose.items()):
        best = lambda counter, want: next((t for t, _ in counter.most_common() if want in t), None) or \
            (counter.most_common(1)[0][0] if counter else "")
        proj.looks[pose] = {"picture": seen["pictures"].most_common(1)[0][0] if seen["pictures"] else None,
                            "subject": best(seen["subjects"], "plain pure black background"),
                            "ending": best(seen["endings"], "facing the viewer")}
        # A line most of the look's latest clips open with is the look's own (Genesis: her motes stay on her).
        recent = Counter(line for _, line in sorted(seen["firsts"])[-12:])
        first, count = recent.most_common(1)[0] if recent else ("", 0)
        if count >= 3 and count >= 0.5 * sum(recent.values()):
            proj.looks[pose]["keep"] = first
    for c in proj.clips.values():
        parts = prompts.split(c["prompt"]) if c["prompt"] else None
        if parts:
            keep = proj.looks.get(c["from"], {}).get("keep", "")
            c["action"] = parts[2].removeprefix(keep).strip() if keep else parts[2]
            c["seconds"] = prompts.FRAMES_SECONDS.get(c["frames"], 5)
    wardrobe_hints(proj)
    return proj


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    ensure_workspace()
    manifest = json.loads((PORTRAITS / "manifest.json").read_text())
    names = {m["id"]: m["name"] for m in manifest}
    takes = queued_takes()
    for cid in args or list(names):
        if Project.file(cid).exists() and not force:
            print(f"{cid}: already has a project file (--force to import again)")
            continue
        proj = import_choom(cid, takes, names)
        proj.save()
        s = proj.summary()
        no_prompt = [n for n, c in proj.clips.items() if not c["prompt"]]
        print(f"{cid}: {len(proj.clips)} clips ({s['counts']['kept']} kept, {s['counts']['dropped']} dropped), "
              f"{len(proj.sequence)} on the glass, {len(proj.looks)} looks"
              + (f"; no prompt found for {', '.join(no_prompt)}" if no_prompt else ""))


if __name__ == "__main__":
    main()
