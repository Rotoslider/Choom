"""Planning clips for a look from the library (packs.json) or from your own wording.

A planned clip gets its name from the clip roles (so the page knows what it's for), its prompt from
the look's subject line plus the action, its pictures from the looks it starts and ends in, and a
seed no other clip has used.
"""
import json
import re
from pathlib import Path

import prompts
from project import base_of, next_seeds, outfit_of, roles

PACKS_FILE = Path(__file__).resolve().parent / "packs.json"
KIND_PREFIX = {
    "moment": {"main": "idle_", "relaxed": "relaxed_", "full": "full_"},
    "talk": {"main": "talk_", "relaxed": "relaxedtalk_"},
    "listen": {"main": "listen_", "relaxed": "relaxedlisten_"},
    "oops": {"main": "oops_", "relaxed": "relaxedoops_"},
    "pose": {"main": "pose_", "relaxed": "relaxedpose_", "full": "fullpose_"},
}
TRANSITION_ENDING = "She stays in the same place, facing the viewer."


def library():
    return json.loads(PACKS_FILE.read_text())


def look_kind(look_id):
    """Which packs suit a look: "outfit" for any look in other clothes, else its pose."""
    return "outfit" if outfit_of(look_id) else base_of(look_id)


def action_name(action, look_id):
    """The clip's action part for this look (idle_glance, relaxedlisten, evening-idle_glance), or None
    if the action doesn't come in this pose."""
    base, outfit = base_of(look_id), outfit_of(look_id)
    if "names" in action:
        name = action["names"].get(base)
    else:
        prefix = KIND_PREFIX[action["kind"]].get(base)
        name = prefix + action["key"] if prefix else None
    if not name:
        return None
    return f"{outfit}-{name}" if outfit else name


def unique_name(proj, name, numbered):
    """A free clip name: a kind-named clip gets a number (idle_glance2); a role-named one can't
    (listen2 wouldn't be a listening clip), so None if it's taken."""
    if name not in proj.clips:
        return name
    if not numbered:
        return None
    n = 2
    while f"{name}{n}" in proj.clips:
        n += 1
    return f"{name}{n}"


def options(proj, look_id):
    """The library's actions for a look: [{pack, key, text, seconds, hands, name, have}], `have`
    naming the clip she already has for it (any status but dropped)."""
    lib, kind = library(), look_kind(look_id)
    packs = {p["id"]: p for p in lib["packs"]}
    out = []
    for a in lib["actions"]:
        if kind not in packs[a["pack"]]["for"]:
            continue
        part = action_name(a, look_id)
        if not part:
            continue
        name = f"{proj.id}_{part}"
        have = [n for n in proj.clips if (n == name or re.fullmatch(re.escape(name) + r"\d+", n))
                and proj.clips[n]["status"] != "dropped"]
        out.append({"pack": a["pack"], "key": a["key"], "text": a["text"], "seconds": a.get("seconds", 5),
                    "hands": a.get("hands", False), "name": name, "have": have,
                    "numbered": "names" not in a, "ending": a.get("ending")})
    return out


def prompt_for(proj, start, end, text, seconds, ending=None):
    look = proj.looks[start]
    if ending is None:
        ending = look.get("ending", "") if start == end else TRANSITION_ENDING
    return prompts.build(look["subject"], text, seconds, ending, look.get("keep", ""))


def add(proj, look_id, items):
    """Plan clips in a look. items: [{key, text, seconds, kind or names, ending}] (library actions
    or your own). Returns [(name or None, message)]."""
    results, wanted = [], []
    for item in items:
        part = action_name(item, look_id)
        if not part:
            results.append((None, f"{item['key']}: doesn't come in the {look_id} look"))
            continue
        name = unique_name(proj, f"{proj.id}_{part}", "names" not in item)
        if not name:
            results.append((None, f"{item['key']}: she already has {proj.id}_{part} (re-roll it instead)"))
            continue
        _, start, end = roles(proj.id, name)
        missing = [p for p in (start, end) if not proj.looks.get(p, {}).get("picture")]
        if missing:
            results.append((None, f"{name}: needs a picture for the {' and '.join(missing)} look first"))
            continue
        wanted.append((name, start, end, item))
    for (name, start, end, item), seed in zip(wanted, next_seeds(len(wanted))):
        seconds = int(item.get("seconds", 5))
        prompt = prompt_for(proj, start, end, item["text"], seconds, item.get("ending"))
        proj.add_clip(name, prompt=prompt, action=item["text"], seconds=seconds, ending=item.get("ending"),
                      frames=prompts.SECONDS[seconds][0], seed=seed,
                      start=proj.looks[start]["picture"], end=proj.looks[end]["picture"], queue=None)
        warnings = prompts.lint(prompt, loop=start == end)
        results.append((name, "; ".join(f"{w}: {why}" for w, why in warnings) or "ok"))
    return results


def rewrite(proj, name, text=None, seconds=None):
    """Change a planned clip's action or length (its prompt is rebuilt from its look)."""
    clip = proj.clips[name]
    if clip["status"] not in ("planned",):
        raise ValueError(f"{name} is {clip['status']}; re-roll it to plan it again")
    if text is not None:
        clip["action"] = text
    if seconds is not None:
        clip["seconds"] = int(seconds)
        clip["frames"] = prompts.SECONDS[int(seconds)][0]
    clip["prompt"] = prompt_for(proj, clip["from"], clip["to"], clip["action"], clip["seconds"], clip.get("ending"))
    return prompts.lint(clip["prompt"], loop=clip["from"] == clip["to"])
