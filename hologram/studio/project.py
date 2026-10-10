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
import sys
import time

from config import CLIPS, PICTURES, PORTRAITS, PROJECTS, TOOLS

sys.path.insert(0, str(TOOLS))
import closet  # noqa: E402
from clip_roles import clip_role  # noqa: E402

STATUSES = ("planned", "queued", "rendered", "kept", "dropped")


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
        return sorted(p.stem for p in PROJECTS.glob("*.json") if p.stem != "jobs")  # jobs.json is the work list

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
        """Plan the clip again under the same name with a new seed; the old take goes in its history."""
        clip = self.clips[name]
        old = {k: clip.get(k) for k in ("seed", "status", "note", "flags", "checks", "queue", "rendered")}
        old["onGlass"] = name in self.sequence
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
        clip.update({k: v for k, v in old.items() if v is not None})
        if not clip["history"]:
            del clip["history"]
        if on_glass and clip["status"] == "kept" and name not in self.sequence:
            self.sequence.append(name)

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
            if o and o not in looks:
                worn = closet.wearing(subject, main)
                looks[o] = {"tags": self.closet_words(lid),  # her usual clothes, changed some other way: say how
                            "wearing": closet.changes(subject, main) if worn == usual else worn}
        data = {"usual": usual, "looks": looks,
                "moves": {n: c["tags"] for n, c in sorted(self.clips.items()) if c.get("tags")}}
        text = json.dumps(data, indent=1) + "\n"
        if not f.exists() or f.read_text() != text:
            f.write_text(text)

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
