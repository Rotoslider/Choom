"""Planning clips for a look from the library (packs.json) or from your own wording.

A planned clip gets its name from the clip roles (so the page knows what it's for), its prompt from
the look's subject line plus the action, its pictures from the looks it starts and ends in, and a
seed no other clip has used.
"""
import json
import re
from pathlib import Path

import prompts
from config import CFG
from project import Project, base_of, editing, next_seeds, outfit_of, roles

PACKS_FILE = Path(__file__).resolve().parent / "packs.json"
KIND_PREFIX = {
    "moment": {"main": "idle_", "relaxed": "relaxed_", "full": "full_", "place": "{place}_", "seat": "{place}_"},
    "talk": {"main": "talk_", "relaxed": "relaxedtalk_"},
    "listen": {"main": "listen_", "relaxed": "relaxedlisten_"},
    "oops": {"main": "oops_", "relaxed": "relaxedoops_"},
    "pose": {"main": "pose_", "relaxed": "relaxedpose_", "full": "fullpose_"},
    "windy": {"main": "windy_", "relaxed": "relaxedwindy_"},
}
TRANSITION_ENDING = "She stays in the same place, facing the viewer."


def library():
    return json.loads(PACKS_FILE.read_text())


POSES = ("main", "relaxed", "full", "asleep", "gone")  # clip_roles.POSES; any other look is a place
SEATS = ("circle", "circleside")  # her seats at the campfire circle (living.js SEAT_LOOKS): made like places


def look_kind(look_id):
    """Which packs suit a look: "outfit" for her waist-up looks in other clothes, "seat" for her seat
    at the campfire circle, "place" for one of her places (sitting by her campfire), else its pose (an
    outfit's full body, full@dayspandex, gets the full-body packs)."""
    base = base_of(look_id)
    if base in SEATS:
        return "seat"
    if base not in POSES:
        return "place"
    return "outfit" if outfit_of(look_id) and base != "full" else base


def action_name(action, look_id):
    """The clip's action part for this look (idle_glance, relaxedlisten, evening-idle_glance,
    to_campfire), or None if the action doesn't come in this pose."""
    base, outfit = base_of(look_id), outfit_of(look_id)
    pose = look_kind(look_id) if look_kind(look_id) in ("place", "seat") else base
    if "names" in action:
        name = action["names"].get(pose)
    else:
        prefix = KIND_PREFIX[action["kind"]].get(pose)
        name = prefix + action["key"] if prefix else None
    if not name:
        return None
    name = name.replace("{place}", base)
    return f"{outfit}-{name}" if outfit else name


def for_look(text, look):
    """An action's wording for a look: a place's actions say where she is ({does}: "sitting on the
    ground beside a small campfire ...")."""
    return text.replace("{does}", (look.get("does") or "where she is").rstrip(". "))


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
    naming the clip she already has for it (any status but dropped). A night outfit (she sleeps in
    it) also gets the Sleep pack. A pack that "needs" looks (Pose changes: her relaxed pose) is left
    out for a Choom without them: the Studio can't make a second pose, and Genesis's main look showed
    Aloy's hand-lowering clips."""
    lib, kind = library(), look_kind(look_id)
    kinds = {kind} | ({"night"} if kind == "outfit" and outfit_of(look_id).startswith("night") else set())
    packs = {p["id"]: p for p in lib["packs"]}
    out = []
    for a in lib["actions"]:
        pack = packs[a["pack"]]
        if (not kinds & set(pack["for"]) or not all(look in proj.looks for look in pack.get("needs", []))
                or (pack.get("usual") and outfit_of(look_id))):
            continue
        if a.get("looks") and base_of(look_id) not in a["looks"]:
            continue  # for one seat only (a facing seat listens left and right)
        part = action_name(a, look_id)
        if not part:
            continue
        name = f"{proj.id}_{part}"
        have = [n for n in proj.clips if (n == name or re.fullmatch(re.escape(name) + r"\d+", n))
                and proj.clips[n]["status"] != "dropped"]
        out.append({"pack": a["pack"], "key": a["key"], "text": for_look(a["text"], proj.looks[look_id]), "seconds": a.get("seconds", 5),
                    "hands": a.get("hands", False), "name": name, "have": have,
                    "numbered": "names" not in a, "ending": a.get("ending")})
    return out


def many(targets, picks, preview=True):
    """One plan for many looks at once (Expressions and Oops for every outfit): for each (choom, look)
    in targets, the picked library actions [(pack, key)] that come in that look and she has no clip
    for yet. A clip she already has is never planned again under a number. preview: what would be
    planned and how long it takes to render; otherwise plan it, one look at a time so every clip gets
    a seed of its own. Returns {"looks": [{choom, look, plan, have, blocked}], "clips", "minutes",
    "results"}."""
    picks = {(p, k) for p, k in picks}
    by_key = {(a["pack"], a["key"]): a for a in library()["actions"]}
    out, clips, minutes = [], 0, 0.0
    for cid, look_id in targets:
        proj = Project.load(cid)
        if look_id not in proj.looks:
            raise ValueError(f"{cid} has no look {look_id}")
        fresh, have, blocked = [], [], []
        for o in options(proj, look_id):
            if (o["pack"], o["key"]) not in picks:
                continue
            if o["have"]:
                have.append(o["name"])
                continue
            _, start, end = roles(cid, o["name"])
            missing = [p for p in (start, end) if not proj.looks.get(p, {}).get("picture")]
            if missing:
                blocked.append(f"{o['name']}: needs a picture for {' and '.join(missing)}")
                continue
            fresh.append(o)
        frames = [prompts.SECONDS[int(o["seconds"])][0] for o in fresh]
        clips += len(fresh)
        minutes += sum(CFG["minutes_per_clip"] * f / 124 for f in frames)
        out.append({"choom": cid, "look": look_id, "plan": [o["name"] for o in fresh], "have": have,
                    "blocked": blocked, "items": [(o["pack"], o["key"]) for o in fresh]})
    results = []
    if not preview:
        for entry in out:
            if entry["items"]:
                with editing(entry["choom"]) as proj:
                    results += [(entry["choom"], name, message)
                                for name, message in add(proj, entry["look"], [by_key[i] for i in entry["items"]])]
    for entry in out:
        del entry["items"]
    return {"looks": out, "clips": clips, "minutes": round(minutes), "results": results}


def prompt_for(proj, start, end, text, seconds, ending=None, refs=()):
    """A clip's prompt from its looks; `refs`, its own pictures (a mug she sips from), make it a prompt
    for H3's reference model."""
    # Walking on from the empty glass: she's described as she ends (the empty glass has no subject line).
    look = proj.looks[start] if proj.looks[start].get("subject") else proj.looks[end]
    if ending is None:
        ending = look.get("ending", "") if start == end else TRANSITION_ENDING
    # The look's keep line (Genesis's motes stay on her) only if the look she ends in keeps it too: on
    # the way to her plain or night look her motes go.
    keep = look.get("keep", "") if look.get("keep") == proj.looks.get(end, {}).get("keep") else ""
    if refs:
        return prompts.build_ref(look["subject"], text, seconds, ending, keep, len(refs))
    return prompts.build(look["subject"], text, seconds, ending, keep)


def add(proj, look_id, items):
    """Plan clips in a look. items: [{key, text, seconds, kind or names, ending}] (library actions
    or your own; your own can have `refs`, its own pictures in clean/). Returns [(name or None, message)]."""
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
        text = for_look(item["text"], proj.looks[look_id])
        refs = list(item.get("refs") or [])
        prompt = prompt_for(proj, start, end, text, seconds, item.get("ending"), refs)
        proj.add_clip(name, prompt=prompt, action=text, seconds=seconds, ending=item.get("ending"),
                      frames=prompts.SECONDS[seconds][0], seed=seed,
                      start=proj.looks[start]["picture"], end=proj.looks[end]["picture"], queue=None,
                      **({"refs": refs} if refs else {}))
        warnings = prompts.lint(prompt, loop=start == end, leaves="gone" in (start, end))
        if refs:
            warnings += prompts.lint_refs(text, len(refs))
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
    clip["prompt"] = prompt_for(proj, clip["from"], clip["to"], clip["action"], clip["seconds"], clip.get("ending"),
                                clip.get("refs", ()))
    warnings = prompts.lint(clip["prompt"], loop=clip["from"] == clip["to"], leaves="gone" in (clip["from"], clip["to"]))
    return warnings + (prompts.lint_refs(clip["action"], len(clip["refs"])) if clip.get("refs") else [])


def add_change(proj, start, end, key, text, seconds=5):
    """Plan a change of clothes on screen, from one of her waist-up looks to another in the same pose
    (the burgundy dress to her night look, her night look back to her usual clothes), or from one full
    body to another (a nightie slipping to the floor needs her feet in the frame). It's rendered from
    the first look's picture to the second's, and the glass plays it instead of a camera cut (a full-body
    one with a cut to her whole figure and back). Returns (name or None, message)."""
    if start == end or base_of(start) != base_of(end) or base_of(start) not in ("main", "relaxed", "full"):
        return None, "a change goes between two of her waist-up looks in the same pose, or two of her full bodies"
    key = re.sub(r"[^a-z0-9]", "", (key or "").lower()) or "swap"
    part = ((f"{outfit_of(start)}-" if outfit_of(start) else "") + ("full" if base_of(start) == "full" else "")
            + f"change_{outfit_of(end) or 'usual'}_{key}")
    name = unique_name(proj, f"{proj.id}_{part}", True)
    _, frm, to = roles(proj.id, name)
    if (frm, to) != (start, end):  # Aloy's outfits are all hand-down: a change from her finger-up look can't be named
        return None, f"the glass would read {name} as {frm} to {to}; choose looks in her home pose"
    missing = [p for p in (start, end) if not proj.looks.get(p, {}).get("picture")]
    if missing:
        return None, f"{name}: needs a picture for the {' and '.join(missing)} look first"
    seconds = int(seconds)
    prompt = prompt_for(proj, start, end, text, seconds)
    proj.add_clip(name, prompt=prompt, action=text, seconds=seconds, ending=None, frames=prompts.SECONDS[seconds][0],
                  seed=next_seeds(1)[0], start=proj.looks[start]["picture"], end=proj.looks[end]["picture"], queue=None)
    warnings = prompts.lint(prompt, loop=False)
    return name, "; ".join(f"{w}: {why}" for w, why in warnings) or "ok"


def refresh_prompts(proj, look_id):
    """Rewrite the prompts of the look's planned clips (its subject, keep line or ending changed)."""
    for c in proj.clips.values():
        if c["status"] == "planned" and look_id in (c["from"], c["to"]) and c.get("action"):
            c["prompt"] = prompt_for(proj, c["from"], c["to"], c["action"], c["seconds"], c.get("ending"), c.get("refs", ()))


def repicture(proj, look_id):
    """A look has a new picture: every clip that starts or ends in it is planned again from it, with a
    new seed and its pictures and prompt from the looks (the old takes stay in each clip's history, and
    a clip comes off the glass until its new take is kept). Returns (planned again, left alone)."""
    names = [n for n, c in proj.clips.items() if look_id in (c["from"], c["to"]) and c["status"] != "dropped"]
    redo = [n for n in names if proj.clips[n]["status"] != "queued" and proj.clips[n].get("action")]
    for n, seed in zip(redo, next_seeds(len(redo))):
        c = proj.clips[n]
        if c["status"] == "planned":
            c["seed"] = seed
        else:
            proj.reroll(n, seed)
        c["start"], c["end"] = proj.looks[c["from"]]["picture"], proj.looks[c["to"]]["picture"]
        c["prompt"] = prompt_for(proj, c["from"], c["to"], c["action"], c["seconds"], c.get("ending"), c.get("refs", ()))
    return redo, [n for n in names if n not in redo]
