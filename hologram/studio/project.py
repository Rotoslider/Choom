"""A Choom's project file: everything her glass is made from, in one place.

    {
      "id": "aloy", "name": "Aloy", "version": 1,
      "looks": {                      # one per pose the page knows: main, relaxed, full, asleep, relaxed@evening...
        "relaxed": {"picture": "aloy_relaxed_1.png",          # her clean start picture (workspace clean/)
                    "subject": "A young woman with ... against a plain pure black background, her arms relaxed at her sides",
                    "ending": "She stays in the same place and ends exactly as she began, facing the viewer ..."}
      },
      "clips": {                      # every clip planned or made, by name (the file in clips/ without .mp4)
        "aloy_relaxed_glance": {"from": "relaxed", "to": "relaxed", "prompt": "...", "seed": 9321,
                                "frames": 124, "status": "kept", "queue": "poses3", "flags": [], "note": ""}
      },
      "sequence": ["aloy_base", ...]  # the clips on the glass, her main idle first (make_alive.py's list)
    }

A clip's status: planned (not yet queued), queued (in a render queue), rendered (made, not reviewed),
kept, or dropped. Only kept clips can be on the glass. Re-rolling a clip renders it again under the
same name with a new seed; the old take is remembered in its history.
"""
import contextlib
import fcntl
import json
import os
import re
import sys
import time

from config import CLIPS, PICTURES, PORTRAITS, PROJECTS, SHEETS, TOOLS

sys.path.insert(0, str(TOOLS))
import closet  # noqa: E402
from clip_roles import clip_role  # noqa: E402

STATUSES = ("planned", "queued", "rendered", "kept", "dropped")
NOT_CHOOMS = {"jobs", "worklist", "notify", "schedule"}  # json files in studio/ that aren't Choom projects
BUILD_MINUTES_PER_CLIP = 2.5  # masks, depth and relief of one new clip in a build (October 2026 builds)
TAKES = CLIPS / "takes"  # earlier takes of re-rolled clips (render.collect)
WHEN_WORDS = ("cold", "hot", "evening", "day", "night")  # an outfit's name starts with when she wears it


class LookHasDropped(ValueError):
    """A look that only dropped clips use: deleting it deletes them too, so the page asks first."""
    def __init__(self, count):
        super().__init__(f"{count} dropped clip{'s use' if count > 1 else ' uses'} this look; {'they' if count > 1 else 'it'}'d be deleted with it")
        self.count = count


def take_name(name, path):
    """The name render.collect gives a clip's file when a re-roll replaces it: <clip>_<its file time>.mp4."""
    return f"{name}_{time.strftime('%Y%m%d-%H%M%S', time.localtime(path.stat().st_mtime))}.mp4"


def outfit_of(pose):
    return pose.split("@", 1)[1] if "@" in pose else None


def base_of(pose):
    return pose.split("@", 1)[0]


def roles(cid, name):
    moods, start, end = clip_role(cid, f"{name}.mp4")
    return moods, start, end


class Project:
    def __init__(self, data):
        self.data = data

    # --- files -----------------------------------------------------------------------------
    @staticmethod
    def file(cid):
        return PROJECTS / f"{cid}.json"

    @classmethod
    def ids(cls):
        # The Studio's own files beside the projects (the work list) aren't Chooms.
        return sorted(p.stem for p in PROJECTS.glob("*.json") if p.stem not in NOT_CHOOMS)

    @classmethod
    def load(cls, cid):
        return cls(json.loads(cls.file(cid).read_text()))

    @classmethod
    def new(cls, cid, name):
        return cls({"id": cid, "name": name, "version": 1, "looks": {}, "clips": {}, "sequence": []})

    def save(self):
        """Written whole and swapped in, so the Studio page never reads half a file."""
        path = self.file(self.id)
        part = path.with_suffix(".part")
        part.write_text(json.dumps(self.data, indent=1))
        os.replace(part, path)

    # --- fields ----------------------------------------------------------------------------
    @property
    def id(self):
        return self.data["id"]

    @property
    def looks(self):
        return self.data["looks"]

    @property
    def clips(self):
        return self.data["clips"]

    @property
    def sequence(self):
        return self.data["sequence"]

    def clip_file(self, name):
        return CLIPS / f"{name}.mp4"

    def picture_file(self, look):
        pic = self.looks.get(look, {}).get("picture")
        return PICTURES / pic if pic else None

    def add_clip(self, name, **fields):
        moods, start, end = roles(self.id, name)
        clip = {"from": start, "to": end, "moods": moods, "status": "planned", "flags": [], "note": ""}
        clip.update(fields)
        self.clips[name] = clip
        return clip

    def set_status(self, name, status, note=None):
        assert status in STATUSES, status
        clip = self.clips[name]
        clip["status"] = status
        if note is not None:
            clip["note"] = note
        if status != "kept" and name in self.sequence and name != self.sequence[0]:
            self.sequence.remove(name)
        clip["changed"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    def reroll(self, name, seed):
        """Plan the clip again under the same name with a new seed; the old take goes in its history,
        with the name its file gets in clips/takes/ once the new one lands (render.collect names it
        from the file's time), so it can be brought back (use_take)."""
        clip = self.clips[name]
        old = {k: clip.get(k) for k in ("seed", "status", "note", "flags", "checks", "queue", "rendered")}
        old["onGlass"] = name in self.sequence
        if self.clip_file(name).exists():
            old["take"] = take_name(name, self.clip_file(name))
        clip.setdefault("history", []).append(old)
        clip.update({"seed": seed, "status": "planned", "flags": [], "note": "", "queue": None})
        clip.pop("checks", None)
        if name in self.sequence and name != self.sequence[0]:
            self.sequence.remove(name)

    def unplan(self, name):
        """Take a planned clip back out: a new one is forgotten, a re-roll goes back to its old take."""
        clip = self.clips[name]
        if not clip.get("history"):
            del self.clips[name]
            return
        old = clip["history"].pop()
        on_glass = old.pop("onGlass", False)
        old.pop("take", None)  # its file never moved: the re-roll hadn't rendered
        clip.update({k: v for k, v in old.items() if v is not None})
        if not clip["history"]:
            del clip["history"]
        if on_glass and clip["status"] == "kept" and name not in self.sequence:
            self.sequence.append(name)

    # --- earlier takes (a re-roll renders a clip again; render.collect moves the old file to takes/) ----
    def takes(self, name):
        """The earlier takes of a clip whose files are still in clips/takes/: [(history index, file)].
        A take re-rolled since this was added says its file name; an older one is found by time (its
        file is named from when it was written, shortly before it was collected as rendered)."""
        clip = self.clips.get(name, {})
        files = sorted(p.name for p in TAKES.glob(f"{name}_*.mp4")) if TAKES.is_dir() else []
        out = []
        for i, h in enumerate(clip.get("history", [])):
            if h.get("take") in files:
                out.append((i, h["take"]))
                continue
            try:
                rendered = time.mktime(time.strptime(h.get("rendered") or "", "%Y-%m-%dT%H:%M:%S"))
            except ValueError:
                continue
            near = []
            for f in files:
                try:
                    t = time.mktime(time.strptime(f[len(name) + 1:-4], "%Y%m%d-%H%M%S"))
                except ValueError:
                    continue
                if 0 <= rendered - t <= 900:
                    near.append((rendered - t, f))
            if near:
                out.append((i, min(near)[1]))
        return out

    def use_take(self, name, index):
        """Bring an earlier take back: its file becomes the clip again, with its seed, status and note,
        and the take it replaces goes to clips/takes/ in its place in the history. The clip's sheet is
        made again (its checks are dropped), and its file is marked new so the next build remakes its
        depth and cut-out. Returns the restored status."""
        clip = self.clips[name]
        if clip["status"] not in ("rendered", "kept", "dropped"):
            raise ValueError(f"{name} is {clip['status']}: keep the old take with Keep the old take (Plan & render)")
        found = dict(self.takes(name))
        if index not in found:
            raise ValueError("that take's file isn't in clips/takes any more")
        current, old = self.clip_file(name), TAKES / found[index]
        if not current.exists():
            raise ValueError(f"no file for {name}")
        h = clip["history"][index]
        now = {k: clip.get(k) for k in ("seed", "status", "note", "flags", "queue", "rendered")}
        now["onGlass"] = name in self.sequence
        now["take"] = take_name(name, current)
        if (TAKES / now["take"]).exists():  # two takes written in the same second
            now["take"] = now["take"][:-4] + "b.mp4"
        current.rename(TAKES / now["take"])
        old.rename(current)
        os.utime(current)  # newer than her depth and cut-out caches, so the build remakes them
        clip["history"][index] = now
        for k in ("seed", "status", "note", "flags", "queue", "rendered"):
            if h.get(k) is not None:
                clip[k] = h[k]
        clip.pop("checks", None)
        clip["changed"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        if clip["status"] != "kept" and name in self.sequence and name != self.sequence[0]:
            self.sequence.remove(name)
        elif clip["status"] == "kept" and h.get("onGlass") and name not in self.sequence:
            self.sequence.append(name)
        return clip["status"]

    # --- deleting and renaming looks ------------------------------------------------------------
    def delete_look(self, look_id, with_dropped=False):
        """Take a look out of her project; its picture stays in clean/. Never her main look, and not while
        clips that aren't dropped start or end in it. Clips all dropped go too, but only when asked
        (with_dropped), since their history goes with them. Returns the clips that went."""
        if look_id == "main":
            raise ValueError("her main look stays")
        if look_id not in self.looks:
            raise ValueError(f"she has no look {look_id}")
        users = [n for n, c in self.clips.items() if look_id in (c["from"], c["to"])]
        live = [n for n in users if self.clips[n]["status"] != "dropped"]
        if live:
            raise ValueError(f"{len(live)} clip{'s use' if len(live) > 1 else ' uses'} {look_id} "
                             f"({', '.join(live[:3])}{' …' if len(live) > 3 else ''}): drop them, or remove planned ones, first")
        if users and not with_dropped:
            raise LookHasDropped(len(users))
        for n in users:
            del self.clips[n]
        del self.looks[look_id]
        self.data.get("drafts", {}).pop(look_id, None)
        return users

    def rename_outfit(self, old, new, built=()):
        """Give an outfit a new name: all its looks (main@, relaxed@, full@, asleep@), its clips and
        their files (clips/, sheets, earlier takes) move to it, change-of-clothes clips into it too,
        since a clip's name says which look it's in. The name starts with when she wears it (cold, hot,
        evening, day, night), so renaming can change that. Not while any of its clips is queued, placed
        on the glass or built (the glass plays them by name): take them off and build first. Returns
        {old clip name: new}."""
        if not re.fullmatch(r"[a-z0-9]+", new or ""):
            raise ValueError("an outfit's name is lower-case letters and digits")
        if not new.startswith(WHEN_WORDS):
            raise ValueError(f"an outfit's name starts with when she wears it: {', '.join(WHEN_WORDS)}")
        looks = [lid for lid in self.looks if outfit_of(lid) == old]
        if not looks:
            raise ValueError(f"she has no outfit {old}")
        if new == old or any(outfit_of(lid) == new for lid in self.looks):
            raise ValueError(f"she already has an outfit called {new}")
        relook = lambda lid: f"{base_of(lid)}@{new}" if outfit_of(lid) == old else lid  # noqa: E731
        into = re.compile(rf"(?<=[-_])change_{re.escape(old)}(?=_|$)")
        names = {}
        for n in self.clips:
            m = f"{self.id}_{new}-" + n[len(f"{self.id}_{old}-"):] if n.startswith(f"{self.id}_{old}-") else n
            m = into.sub(f"change_{new}", m)
            if m != n:
                names[n] = m
        built = set(built)
        blocked = [n for n in names if self.clips[n]["status"] == "queued" or n in self.sequence or n in built]
        if blocked:
            raise ValueError(f"{len(blocked)} of its clips are queued, on the glass or built ({', '.join(blocked[:3])}"
                             f"{' …' if len(blocked) > 3 else ''}): take them off the glass and build first, or keep the name")
        clash = [m for m in names.values() if m in self.clips and m not in names]
        if clash:
            raise ValueError(f"she already has a clip called {clash[0]}")
        for n, m in names.items():
            _, start, end = roles(self.id, m)
            c = self.clips[n]
            if (start, end) != (relook(c["from"]), relook(c["to"])):
                raise ValueError(f"{m} would be read as {start} to {end}, not {relook(c['from'])} to {relook(c['to'])}")
        for n, m in names.items():
            for src, dst in ((CLIPS / f"{n}.mp4", CLIPS / f"{m}.mp4"), (SHEETS / f"{n}.jpg", SHEETS / f"{m}.jpg")):
                if src.exists():
                    src.rename(dst)
            if TAKES.is_dir():
                for t in TAKES.glob(f"{n}_*.mp4"):
                    if re.fullmatch(re.escape(n) + r"_\d{8}-\d{6}b?\.mp4", t.name):
                        t.rename(TAKES / (m + t.name[len(n):]))
            c = self.clips.pop(n)
            c["from"], c["to"] = relook(c["from"]), relook(c["to"])
            for h in c.get("history", []):
                if (h.get("take") or "").startswith(n + "_"):
                    h["take"] = m + h["take"][len(n):]
            self.clips[m] = c
        for lid in looks:
            self.looks[relook(lid)] = self.looks.pop(lid)
            drafts = self.data.get("drafts", {})
            if lid in drafts:
                drafts[relook(lid)] = drafts.pop(lid)
        return names

    def place(self, name, on=True):
        """Put a kept clip on the glass, or take it off (her main idle always stays, first)."""
        if on:
            if self.clips[name]["status"] != "kept":
                raise ValueError(f"{name} isn't kept yet")
            if name not in self.sequence:
                self.sequence.append(name)
        elif name in self.sequence and name != self.sequence[0]:
            self.sequence.remove(name)

    # --- her closet on the glass (tools/closet.py) ----------------------------------------------
    def closet_words(self, look_id):
        """The words she can ask for a look by: its own, or ones read from what she wears in it."""
        look = self.looks.get(look_id, {})
        return look.get("tags") or closet.default_tags(look_id, look.get("subject", ""),
                                                       self.looks.get("main", {}).get("subject", ""))

    def write_closet(self):
        """portraits/<id>/closet.json, which the glass answers her requests from: each outfit's closet
        words and what she wears in it, and words given to clips. Only for a Choom on the glass."""
        f = PORTRAITS / self.id / "closet.json"
        if not f.parent.is_dir():
            return
        looks, main = {}, self.looks.get("main", {}).get("subject", "")
        usual = closet.wearing(main)
        for lid in sorted(self.looks, key=lambda l: (base_of(l) != "main", l)):  # main@evening before relaxed@evening
            o, subject = outfit_of(lid), self.looks[lid].get("subject", "")
            if o and o not in looks and base_of(lid) != "full":  # the outfit, not its full body
                worn = closet.wearing(subject, main)
                looks[o] = {"tags": self.closet_words(lid),  # her usual clothes, changed some other way: say how
                            "wearing": closet.same_clothes(subject, main) if worn == usual else worn}
        data = {"usual": usual, "looks": looks,
                "moves": {n: c["tags"] for n, c in sorted(self.clips.items()) if c.get("tags")}}
        text = json.dumps(data, indent=1) + "\n"
        if not f.exists() or f.read_text() != text:
            part = f.with_suffix(".part")  # swapped in whole: the glass's server reads it any moment
            part.write_text(text)
            os.replace(part, f)

    # --- what the glass needs before it plays a look -----------------------------------------------
    def readiness(self, built=()):
        """Per look and per outfit, how far it is from the glass, and warnings for the two easy misses:
        a look whose kept clips were never put on the glass (Genesis's 49 shop close-ups), and an
        outfit's full body or asleep look on the glass while she can't wear the outfit. The glass plays
        full@X and asleep@X only while she wears X, and she wears X only with a loop she can talk over
        in main@X or relaxed@X on it. built: the clips her glass plays now (alive.json).
        Returns {"looks": {look: {kept, placed, unbuilt, talk}}, "outfits": {o: {...}}, "warnings": [...]}."""
        seq, built = set(self.sequence), set(built)
        looks = {lid: {"kept": 0, "placed": 0, "unbuilt": 0, "talk": False} for lid in self.looks}
        for name, c in self.clips.items():
            if c["status"] != "kept" or c["from"] not in looks:
                continue
            look = looks[c["from"]]
            look["kept"] += 1
            if name in seq:
                look["placed"] += 1
                look["unbuilt"] += name not in built
                look["talk"] |= c["from"] == c["to"] and "talk" in c.get("moods", [])
        warnings = [f"{lid}: {n['kept']} kept clip{'s' if n['kept'] > 1 else ''}, none on the glass yet"
                    for lid, n in looks.items() if n["kept"] and not n["placed"]]
        outfits = {}
        for o in sorted({outfit_of(lid) for lid in self.looks if outfit_of(lid)}):
            waist = [lid for lid in (f"main@{o}", f"relaxed@{o}") if lid in self.looks]
            extra = [lid for lid in (f"full@{o}", f"asleep@{o}") if lid in self.looks]
            mine = [looks[lid] for lid in waist + extra]
            talk = any(looks[lid]["talk"] for lid in waist)
            unbuilt = sum(n["unbuilt"] for n in mine)
            outfits[o] = {"looks": waist + extra, "talk": talk, "kept": sum(n["kept"] for n in mine),
                          "placed": sum(n["placed"] for n in mine), "unbuilt": unbuilt,
                          "buildMinutes": round(unbuilt * BUILD_MINUTES_PER_CLIP)}
            on = [lid for lid in extra if looks[lid]["placed"]]
            if on and not talk:
                warnings.append(f"{' and '.join(on)} {'are' if len(on) > 1 else 'is'} on the glass, but she can't wear {o} "
                                f"yet: {waist[0] if waist else f'main@{o}'} has no loop she can talk over on the glass "
                                f"(Essentials), so {'they never play' if len(on) > 1 else 'it never plays'}")
        return {"looks": looks, "outfits": outfits, "warnings": warnings}

    def summary(self):
        counts = {s: 0 for s in STATUSES}
        for c in self.clips.values():
            counts[c["status"]] += 1
        looks = {}
        for name in self.sequence:
            pose = self.clips.get(name, {}).get("from", "main")
            looks[pose] = looks.get(pose, 0) + 1
        return {"id": self.id, "name": self.data.get("name", self.id), "counts": counts,
                "onGlass": len(self.sequence), "looks": looks}


@contextlib.contextmanager
def editing(cid):
    """Load, change and save a project with every other editor kept out meanwhile (the Studio page,
    a render finishing, the command line), so no change is lost and no two clips get one seed."""
    PROJECTS.mkdir(parents=True, exist_ok=True)
    with open(PROJECTS / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        proj = Project.load(cid)
        yield proj
        proj.save()


def all_seeds():
    """Every seed in every project, so a new clip never repeats one (output files are found by seed)."""
    seeds = set()
    for cid in Project.ids():
        for c in Project.load(cid).clips.values():
            if c.get("seed"):
                seeds.add(c["seed"])
            seeds.update(h.get("seed") for h in c.get("history", []) if h.get("seed"))
    return seeds


def next_seeds(count):
    start = max(all_seeds(), default=20000) + 1
    return list(range(start, start + count))
