"""Planning clips for a look from the library (packs.json) or from your own wording.

A planned clip gets its name from the clip roles (so the page knows what it's for), its prompt from
the look's subject line plus the action, its pictures from the looks it starts and ends in, and a
seed no other clip has used.
"""
import json
import re
import time
from pathlib import Path

import prompts
from config import CFG
from project import Project, base_of, editing, next_seeds, outfit_of, roles

PACKS_FILE = Path(__file__).resolve().parent / "packs.json"
ACTIVITIES_FILE = Path(__file__).resolve().parent / "activities.json"  # New look > An activity or place: ready-made ideas
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


def activities():
    """The ready-made activities and places (activities.json): Eve's dumbbells, Genesis on the patio."""
    return json.loads(ACTIVITIES_FILE.read_text())["presets"]


ACTIVITY_PACK = {"id": "activity", "title": "This activity's own clips",
                 "about": "Made for this activity when it was started from one of the ready-made ideas: its loop, how she gets "
                          "there and back, and what she does there. They take the place of the place pack's clips by the same name."}


def look_actions(look):
    """The library's actions, plus the clips of the activity a place look was made from (its own loop,
    getting there and back, what she does there), which stand in for the place pack's by the same key."""
    actions = library()["actions"]
    preset = next((a for a in activities() if a["id"] == look.get("activity")), None) if look.get("activity") else None
    if not preset:
        return actions
    places = {a["key"]: a for a in actions if a["pack"] == "places"}
    own = []
    for c in preset["clips"]:
        like = places.get(c["key"], {})
        own.append({"pack": "activity", **({"names": like["names"]} if "names" in like else {"kind": "moment"}),
                    **({"ending": like["ending"]} if like.get("ending") else {}), **c})
    keys = {c["key"] for c in own}
    return own + [a for a in actions if not (a["pack"] == "places" and a["key"] in keys)]


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
    if outfit and pose == "place" and re.match(r"(to|from)_", name):
        return None  # clothes she wears only at a place: she changes into them there (add_change), not on the way
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


# Moves written by hand (Write your own clip, or planned through the API: Genesis's whisper, Eve's goodnight
# kiss) are clips, not library actions, so Plan & render never offered them again: not in another of her
# looks, not even in the look they were made in (Donny, 2026-11-09). These packs list them in every look
# they fit: hers as "Her own moves", her sisters' as "Her sisters' moves".
OWN_PACKS = {
    "own": {"id": "own", "title": "Her own moves",
            "about": "Moves written for her by hand (Write your own clip), offered in every look they fit. The wording "
                     "is the one from her usual clothes; this look's own lines go in front of it, as for any clip."},
    "sisters": {"id": "sisters", "title": "Her sisters' moves",
                "about": "Moves written by hand for the other Chooms, to borrow. Words about something only that sister "
                         "has (glasses, a heart, crossed arms) are marked: change them with Edit once it's planned."},
}
OWN_KINDS = ("moment", "pose", "talk", "oops", "windy", "listen")  # what a clip of your own can be
HANDS = re.compile(r"\b(hands?|fingers?|palms?|arms?|wrists?)\b", re.I)
STOP = set("a an and the of her his she he with in on to at as is it its from into over for by or up down out "
           "made skin body long against plain pure black background young woman wearing whole time stay stays "
           "softly glows glowing soft light eyes hair face head shoulder shoulders lips cheeks neck chin arms "
           "hands thigh legs knees feet open side sides".split())


def _prefixes():
    """(prefix, kind, family) of the clip names a clip of her own gets, longest first (relaxedpose_ before
    relaxed_), family "full" for her full bodies and "waist" for her waist-up looks."""
    out = [(prefix, kind, "full" if pose == "full" else "waist")
           for kind, poses in KIND_PREFIX.items() for pose, prefix in poses.items() if "{" not in prefix]
    return sorted(out, key=lambda t: -len(t[0]))


def _library_parts():
    """Every name part the library makes in her usual looks ({"waist": {idle_glance, listen, ...}, "full": ...})."""
    parts = {"waist": set(), "full": set()}
    for a in library()["actions"]:
        for pose in ("main", "relaxed", "full"):
            name = action_name(a, pose)
            if name:
                parts["full" if pose == "full" else "waist"].add(name)
    return parts


def own_moves(proj):
    """The moves written for her by hand: her loops in a waist-up look or a full body (started and ended on
    the same picture) whose name the library doesn't make. One per move, with its wording from the best
    take: her usual clothes before an outfit, kept before rendered before planned, the newest.
    [{key, kind, family, text, seconds, ending, refs, look (the take's), looks, when, choom, hands}]"""
    lib, rank, found = _library_parts(), {"kept": 0, "rendered": 1, "queued": 2, "planned": 3}, {}
    for name, c in proj.clips.items():
        look = c.get("from")
        if c.get("status") not in rank or look != c.get("to") or not c.get("action") or not look:
            continue
        base, outfit = base_of(look), outfit_of(look)
        if base not in ("main", "relaxed", "full"):
            continue
        part = name.removeprefix(f"{proj.id}_")
        if outfit:
            if not part.startswith(f"{outfit}-"):
                continue
            part = part[len(outfit) + 1:]
        family = "full" if base == "full" else "waist"
        if part in lib[family] or re.sub(r"\d+$", "", part) in lib[family]:
            continue
        hit = next(((kind, part[len(prefix):]) for prefix, kind, fam in _prefixes()
                    if fam == family and kind in OWN_KINDS and part.startswith(prefix) and len(part) > len(prefix)), None)
        if not hit:
            continue
        kind, key = hit
        entry = found.setdefault((family, kind, key), {"key": key, "kind": kind, "family": family, "looks": [],
                                                       "choom": proj.id, "score": None})
        entry["looks"].append(look)
        when = c.get("rendered") or c.get("changed") or ""  # when the take was made (a keep later changes "changed")
        best = (1 if outfit else 0, rank[c["status"]], -(time.mktime(time.strptime(when[:19], "%Y-%m-%dT%H:%M:%S")) if when else 0))
        if entry["score"] is None or best < entry["score"]:
            entry.update(score=best, text=c["action"], seconds=int(c.get("seconds", 5)), ending=c.get("ending"),
                         refs=list(c.get("refs") or []), hands=bool(HANDS.search(c["action"])), look=look)
        entry["when"] = max(entry.get("when", ""), when[:10])
    out = sorted(found.values(), key=lambda m: (m["family"], m["kind"], m["key"]))
    for m in out:
        del m["score"]
        m["looks"] = sorted(set(m["looks"]), key=lambda l: (outfit_of(l) is not None, l))
    return out


def _look_words(proj, look_id):
    """The words of a look's lines: who she is there and what she wears (Genesis: glasses, motes, violet;
    Optic: heart, headphones; Aloy's cold look: coat, collar)."""
    m = proj.looks.get(look_id) or proj.looks.get("main", {})
    text = " ".join(str(m.get(k) or "") for k in ("subject", "keep", "kleinKeep", "wearing"))
    return {w for w in re.findall(r"[a-z]+", text.lower()) if len(w) > 3 and w not in STOP}


def borrowed_words(src, src_look, proj, look_id, text):
    """Words in a move about something the look it goes to doesn't have: in the lines of the look it was
    made in (a sister's glasses, an outfit's coat) but not in this look's."""
    only_there = _look_words(src, src_look) - _look_words(proj, look_id)
    words = re.findall(r"[a-z]+", text.lower())
    return sorted({w for w in words if w in only_there or w.rstrip("s") in only_there})


def own_options(proj, look_id):
    """Her own moves and her sisters' for a look, as options() lists them; a sister's move she has one of
    her own by that name is left out."""
    kind = look_kind(look_id)
    if kind not in ("main", "relaxed", "outfit", "full"):
        return []
    family, out, mine = "full" if kind == "full" else "waist", [], set()
    for cid in [proj.id] + [c for c in Project.ids() if c != proj.id]:
        src = proj if cid == proj.id else Project.load(cid)
        for m in own_moves(src):
            part = m["family"] == family and action_name(m, look_id)
            if not part:
                continue
            name = f"{proj.id}_{part}"
            if cid != proj.id and name in mine:
                continue  # one of her own by that name (two sisters' kisses are both listed: their wording differs)
            if cid == proj.id:
                mine.add(name)
            have = [n for n in proj.clips if n == name and proj.clips[n]["status"] != "dropped"]
            out.append({"pack": "own" if cid == proj.id else "sisters", "key": m["key"], "from": cid,
                        "pick": ["own", f"{cid}:{m['key']}"], "kind": m["kind"], "text": m["text"],
                        "seconds": m["seconds"], "ending": m["ending"], "refs": m["refs"], "hands": m["hands"],
                        "name": name, "have": have, "numbered": False, "looks": m["looks"], "when": m["when"],
                        "check": [] if have or m["look"] == look_id else borrowed_words(src, m["look"], proj, look_id, m["text"])})
    out.sort(key=lambda o: o["when"], reverse=True)  # the newest first, hers before her sisters'
    return sorted(out, key=lambda o: (o["pack"] != "own", o["from"]))


# The clips she has in her other looks in the same frame, to make again in a new one (Donny, 2026-11-09:
# a change of clothes "would also need to be able to select moves for the new outfits"): Genesis's patio
# in her cardigan gets what her patio has (the stars, her wish, the night chill), a new outfit what her
# usual waist-up look has, an outfit's full body what her full body has.
SAME_PACK = {"id": "same", "title": "Same clips as her other looks",
             "about": "The clips she has in her other looks in this frame, to make again in this one with their wording as it "
                      "was and where she is here put in. At a place: everything she has there in her other clothes. For an "
                      "outfit or a full body: the ones the packs below don't offer (her first clips, re-worded ones). Words "
                      "about the clothes they were made in are marked: change them with Edit once they're planned."}
MADE_PACKS = (*OWN_PACKS, "same")  # clips made before, offered again: their wording and pictures come from the clip


def siblings(proj, look_id):
    """Her other looks in the same frame as this one, with a picture: the place and its other clothes for
    clothes at a place, her other waist-up looks in this pose for an outfit, her other full bodies for a
    full body. None for asleep (its clips go in and out of it), the empty glass, or a seat at the circle."""
    base = base_of(look_id)
    if base in ("asleep", "gone") or base in SEATS:
        return []
    return [l for l in proj.looks if l != look_id and base_of(l) == base and proj.looks[l].get("picture")
            and not (outfit_of(l) or "").startswith("chosenbare")]  # Donny's own: never offered to her other looks


def same_options(proj, look_id):
    """The clips of her other looks in this frame (siblings) as options for this look: each loop she has
    there (kept, or rendered and waiting for review), named for this look, its wording with where she is
    here in place of where she was (a new pose at a place: the blanket held at her chest)."""
    out, own, look = [], outfit_of(look_id), proj.looks.get(look_id, {})
    now = (look.get("does") or "").strip().rstrip(".")
    for sib in sorted(siblings(proj, look_id), key=lambda l: (outfit_of(l) is not None, l)):
        theirs, was = outfit_of(sib), (proj.looks[sib].get("does") or "").strip().rstrip(".")
        for name, c in sorted(proj.clips.items()):
            if c.get("from") != sib or c.get("to") != sib or c.get("status") not in ("kept", "rendered") or not c.get("action"):
                continue
            part = name.removeprefix(f"{proj.id}_")
            if theirs:
                if not part.startswith(f"{theirs}-"):
                    continue
                part = part[len(theirs) + 1:]
            mine = f"{own}-{part}" if own else part
            new = f"{proj.id}_{mine}"
            if roles(proj.id, new)[1:] != (look_id, look_id):
                continue  # the glass would read the name as another look's
            text = c["action"].replace(was, now) if was and now and was != now else c["action"]
            have = [n for n in proj.clips if n == new and proj.clips[n]["status"] != "dropped"]
            out.append({"pack": "same", "key": part, "from": sib, "pick": ["same", f"{sib}:{part}"], "part": mine,
                        "kind": "moment", "text": text, "seconds": int(c.get("seconds", 5)), "ending": c.get("ending"),
                        "refs": list(c.get("refs") or []), "hands": bool(HANDS.search(text)), "name": new, "have": have,
                        "numbered": False, "looks": [sib], "when": (c.get("rendered") or c.get("changed") or "")[:10],
                        "check": [] if have else borrowed_words(proj, sib, proj, look_id, text)})
    return out


def options(proj, look_id):
    """The library's actions for a look: [{pack, key, text, seconds, hands, name, have}], `have`
    naming the clip she already has for it (any status but dropped). A night or chosen outfit (she
    can sleep in it) also gets the Sleep pack. A pack that "needs" looks (Pose changes: her relaxed pose) is left
    out for a Choom without them: the Studio can't make a second pose, and Genesis's main look showed
    Aloy's hand-lowering clips."""
    lib, kind = {**library(), "actions": look_actions(proj.looks[look_id])}, look_kind(look_id)
    kinds = {kind} | ({"night"} if kind == "outfit" and outfit_of(look_id).startswith(("night", "chosen")) else set())
    packs = {p["id"]: p for p in lib["packs"]} | {"activity": {**ACTIVITY_PACK, "for": ["place"]}}
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
        out.append({"pack": a["pack"], "key": a["key"], "pick": [a["pack"], a["key"]],
                    "text": for_look(a["text"], proj.looks[look_id]), "seconds": a.get("seconds", 5),
                    "hands": a.get("hands", False), "name": name, "have": have,
                    "numbered": "names" not in a, "ending": a.get("ending")})
    own, same = own_options(proj, look_id), same_options(proj, look_id)
    if look_kind(look_id) != "place":
        # An outfit or a full body: only what the packs here don't offer (her first clips, re-worded ones);
        # the rest of her usual look's hundreds are the packs' own. At a place, all of them: a few, and
        # "Pick the ones she doesn't have" makes the place in new clothes in one step.
        offered = {o["name"] for o in own + out}
        same = [o for o in same if o["name"] not in offered and re.sub(r"\d+$", "", o["name"]) not in offered]
    return own + same + out


def many(targets, picks, preview=True):
    """One plan for many looks at once (Expressions and Oops for every outfit): for each (choom, look)
    in targets, the picked library actions [(pack, key)] that come in that look and she has no clip
    for yet. A clip she already has is never planned again under a number. preview: what would be
    planned and how long it takes to render; otherwise plan it, one look at a time so every clip gets
    a seed of its own. Returns {"looks": [{choom, look, plan, have, blocked}], "clips", "minutes",
    "results"}."""
    picks = {(p, k) for p, k in picks}  # a move written by hand: ("own", "<choom>:<key>"), whoever's look it goes to
    by_key = {(a["pack"], a["key"]): a for a in library()["actions"]}
    out, clips, minutes = [], 0, 0.0
    for cid, look_id in targets:
        proj = Project.load(cid)
        if look_id not in proj.looks:
            raise ValueError(f"{cid} has no look {look_id}")
        fresh, have, blocked = [], [], []
        for o in options(proj, look_id):
            if tuple(o["pick"]) not in picks:
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
                    "blocked": blocked, "items": [o if o["pack"] in OWN_PACKS else
                                                  {(a["pack"], a["key"]): a for a in look_actions(proj.looks[look_id])}[(o["pack"], o["key"])]
                                                  for o in fresh]})
    results = []
    if not preview:
        for entry in out:
            if entry["items"]:
                with editing(entry["choom"]) as proj:
                    results += [(entry["choom"], name, message)
                                for name, message in add(proj, entry["look"], entry["items"])]
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
    results, wanted, seen = [], [], set()
    for item in items:
        part = item.get("part") or action_name(item, look_id)  # a clip made again from another look: its own name
        if not part:
            results.append((None, f"{item['key']}: doesn't come in the {look_id} look"))
            continue
        if part in seen:  # ticked twice (Same clips as her other looks, and the pack it came from): planned once
            results.append((None, f"{item['key']}: ticked twice, planned once"))
            continue
        seen.add(part)
        name = unique_name(proj, f"{proj.id}_{part}", item.get("numbered", "names" not in item))
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
    # At one of her places, into clothes she wears only there and back (her sundress to her long cardigan
    # on the patio): <place>change_, the place and its setting staying as they are.
    place = base_of(start) not in POSES and base_of(start) not in SEATS
    if start == end or base_of(start) != base_of(end) or (base_of(start) not in ("main", "relaxed", "full") and not place):
        return None, ("a change goes between two of her waist-up looks in the same pose, two of her full bodies, "
                      "or her clothes at one of her places")
    key = re.sub(r"[^a-z0-9]", "", (key or "").lower()) or "swap"
    frame = "full" if base_of(start) == "full" else base_of(start) if place else ""
    part = (f"{outfit_of(start)}-" if outfit_of(start) else "") + f"{frame}change_{outfit_of(end) or 'usual'}_{key}"
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
