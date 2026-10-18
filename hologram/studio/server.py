#!/usr/bin/env python3
"""Glass Studio's local server: the Studio page (web/) and its API over the Chooms' project files.
Started by `studio.py serve`; listens on 127.0.0.1:8767 unless studio.json says otherwise.
Standard library only, like the hologram's own server."""
import base64
import json
import mimetypes
import re
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import build
import housekeeping
import jobs
import pictures
import plan
import prompts
import render
from config import CFG, CLIPS, PICTURES, PORTRAITS, SHEETS, WORKSPACE, ensure_workspace
from project import STATUSES, LookHasDropped, Project, base_of, editing, next_seeds, outfit_of

WEB = Path(__file__).resolve().parent / "web"
NAME = re.compile(r"^[a-z0-9][a-z0-9_@\-]*$")
FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_@\-.]*$")


def built_clips(cid):
    """The clips her glass plays now: her alive.json, as the last build left it."""
    alive = PORTRAITS / cid / "alive.json"
    return [c["source"].removesuffix(".mp4") for c in json.loads(alive.read_text())["clips"]] if alive.exists() else []


def details(proj):
    """Her project plus what the page shows about it: per look, the clips on the glass and how many
    minutes of distinct quiet moments she has before one repeats."""
    looks = {}
    for look in proj.looks:
        on = [n for n in proj.sequence if proj.clips.get(n, {}).get("from") == look]
        quiet = [n for n in on if "idle" in proj.clips[n].get("moods", [])]
        seconds = sum(prompts.FRAMES_SECONDS.get(proj.clips[n].get("frames") or 124, 5) for n in quiet)
        looks[look] = {"onGlass": len(on), "quiet": len(quiet), "minutes": round(seconds / 60, 1)}
    planned = [c for c in proj.clips.values() if c["status"] == "planned"]
    # What the glass shows now (her alive.json) against her sequence: changes not built yet.
    built = built_clips(proj.id)
    glass = {"added": [n for n in proj.sequence if n not in built], "removed": [n for n in built if n not in proj.sequence]}
    closet = {look: proj.closet_words(look) for look in proj.looks if "@" in look}
    return {**proj.data, "stats": looks, "problems": build.problems(proj), "glass": glass, "inManifest": build.in_manifest(proj.id),
            "closet": closet, "wishes": wishes(proj.id), "wishesDone": wishes_done(proj.id), "readiness": proj.readiness(built),
            # Earlier takes of re-rolled clips still on disk: {clip: [[history index, file]]}.
            "takes": {n: t for n, c in proj.clips.items() if c.get("history") and (t := proj.takes(n))},
            "color": colors().get(proj.id) or proj.data.get("color"),
            "plannedMinutes": round(sum(render.minutes(c.get("frames") or 124) for c in planned))}


def wishes(cid):
    """What she asked the glass for and hasn't got (tools/closet.py writes them)."""
    try:
        return json.loads((PORTRAITS / cid / "wishes.json").read_text())
    except (OSError, ValueError):
        return []


def wishes_done(cid):
    """Her wishes that were made (Made it on the Plan page), newest last."""
    try:
        return json.loads((PORTRAITS / cid / "wishes_done.json").read_text())
    except (OSError, ValueError):
        return []


def write_json(path, data):
    """Written whole and swapped in: the glass's server adds wishes to the same file any moment (its own
    temporary name is wishes.part, so this one is different)."""
    part = path.with_name(path.name + ".studio-part")
    part.write_text(json.dumps(data, indent=1))
    part.replace(path)


def colors():
    manifest = PORTRAITS / "manifest.json"
    return {m["id"]: m.get("color") for m in json.loads(manifest.read_text())} if manifest.exists() else {}


CHOOM_ID = re.compile(r"^[a-z][a-z0-9]{0,31}$")


def choom_ok(cid):
    """A Choom id the Studio has a project for (never a path)."""
    return isinstance(cid, str) and bool(CHOOM_ID.match(cid)) and Project.file(cid).exists()


def active_queues():
    with jobs.lock:
        return [q for j in jobs.jobs if j["kind"] == "render" and j["status"] in jobs.ACTIVE
                for q in [j["args"]["queue"], *j["args"].get("earlier", [])]]


def active_runs():
    with jobs.lock:
        return [j["out"] for j in jobs.jobs if j["kind"] == "picture" and j["status"] in jobs.ACTIVE and j.get("out")]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    # --- replies -------------------------------------------------------------------------------
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, message, status=400):
        self.send_json({"error": message}, status)

    def send_file(self, path, cache=False):
        if not path.is_file():
            return self.send_error(404)
        size = path.stat().st_size
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start, end = int(m.group(1)), int(m.group(2) or size - 1)
            else:
                start = size - int(m.group(2))
            end = min(end, size - 1)
        self.send_response(206 if m else 200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if m:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "max-age=60" if cache else "no-store")
        self.end_headers()
        with path.open("rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    # --- GET -----------------------------------------------------------------------------------
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        parts = [urllib.parse.unquote(p) for p in url.path.strip("/").split("/") if p]
        if not parts:
            return self.send_file(WEB / "index.html")
        if parts[0] == "web" and len(parts) == 2 and FILE.match(parts[1]):
            return self.send_file(WEB / parts[1])
        if parts[0] == "media" and len(parts) == 3 and FILE.match(parts[2]):
            folder = {"clip": CLIPS, "take": CLIPS / "takes", "sheet": SHEETS, "picture": PICTURES, "draft": pictures.DRAFTS}.get(parts[1])
            return self.send_file(folder / parts[2], cache=parts[1] != "sheet") if folder else self.send_error(404)
        if parts[:2] == ["api", "chooms"]:
            tint = colors()
            chooms = [Project.load(c) for c in Project.ids()]
            return self.send_json({"chooms": [{**p.summary(), "onGlass": len(built_clips(p.id)), "color": tint.get(p.id) or p.data.get("color")} for p in chooms],
                                   "workspace": str(WORKSPACE), "minutesPerClip": CFG["minutes_per_clip"],
                                   "cleanPrompt": pictures.CLEAN_PROMPT})
        if parts[:2] == ["api", "choom"] and len(parts) == 3 and NAME.match(parts[2]):
            if not Project.file(parts[2]).exists():
                return self.fail("no such Choom", 404)
            return self.send_json(details(Project.load(parts[2])))
        if parts[:2] == ["api", "options"] and len(parts) == 4:
            if not choom_ok(parts[2]):
                return self.fail("no such Choom", 404)
            return self.send_json({"options": plan.options(Project.load(parts[2]), parts[3])})
        if parts[:2] == ["api", "packs"]:
            lib = plan.library()
            return self.send_json({"packs": lib["packs"], "actions": [{"pack": a["pack"], "key": a["key"], "text": a["text"],
                                                                        "seconds": a.get("seconds", 5)} for a in lib["actions"]]})
        if parts[:2] == ["api", "jobs"]:
            with jobs.lock:
                return self.send_json({"jobs": jobs.recent(40), "worklist": jobs.state()})
        if parts[:2] == ["api", "housekeeping"]:
            days = int(urllib.parse.parse_qs(url.query).get("takes_days", ["30"])[0])
            report = housekeeping.survey(days, active_queues(), active_runs())
            return self.send_json({k: ({kk: vv for kk, vv in v.items() if kk != "files"} if k in housekeeping.CATEGORIES else v)
                                   for k, v in report.items()})
        return self.send_error(404)

    # --- POST ----------------------------------------------------------------------------------
    def same_origin(self):
        """A request from the Studio page itself (or a tool on this machine), not from another web page
        open in the browser: any page could otherwise post here, cancel tonight's render say."""
        origin = self.headers.get("Origin")
        port = int(CFG["port"])
        if origin and origin not in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
            return False
        return self.headers.get("Sec-Fetch-Site", "same-origin") in ("same-origin", "none")

    def do_POST(self):
        parts = [p for p in urllib.parse.urlparse(self.path).path.strip("/").split("/") if p]
        if not self.same_origin():
            return self.fail("refused: this came from another web page", 403)
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.fail("send JSON, with Content-Type: application/json", 415)
        try:
            data = self.body()
        except json.JSONDecodeError:
            return self.fail("bad JSON")
        try:
            if not isinstance(data, dict):
                return self.fail("send a JSON object")
            for key in ("choom",):  # every route that names a Choom names one it has
                if key in data and not choom_ok(data[key]):
                    return self.fail(f"no Choom {data[key]}", 404)
            if parts[:2] == ["api", "choom"] and len(parts) == 4 and NAME.match(parts[2]):
                return self.choom_action(parts[2], parts[3], data)
            if parts == ["api", "render"]:
                return self.start_render(data)
            if parts == ["api", "plan-many"]:
                # Library actions for many looks at once: previewed first, then planned.
                targets = [(str(c), str(l)) for c, l in data.get("targets", [])]
                bad = [c for c, _ in targets if not NAME.match(c) or not Project.file(c).exists()]
                if bad:
                    return self.fail(f"no Choom {bad[0]}")
                picks = [(str(p), str(k)) for p, k in data.get("items", [])]
                if not targets or not picks:
                    return self.fail("pick at least one look and one action")
                return self.send_json(plan.many(targets, picks, preview=bool(data.get("preview", True))))
            if parts == ["api", "build"]:
                return self.start_build(data)
            if parts == ["api", "new-choom"]:
                return self.new_choom(data)
            if parts == ["api", "still"]:
                proj = Project.load(data["choom"])
                if not proj.looks.get("main", {}).get("picture"):
                    return self.fail("pick her main picture first (Looks)")
                color = data.get("color") or proj.data.get("color") or "#9fb4ff"
                return self.send_json({"job": jobs.add("still", {"choom": proj.id, "color": color, "style": data.get("style") or proj.data.get("style", "motes")})})
            if parts == ["api", "review"]:
                return self.send_json({"job": jobs.add("review", {"choom": data["choom"], "clips": data.get("clips", [])})})
            if parts[:2] == ["api", "jobs"] and len(parts) == 4 and parts[3] == "cancel":
                return self.send_json({"cancelled": jobs.cancel(int(parts[2]))})
            if parts == ["api", "jobs", "pause"]:
                return self.send_json({"worklist": jobs.pause()})
            if parts == ["api", "jobs", "resume"]:
                return self.send_json({"worklist": jobs.resume()})
            if parts == ["api", "housekeeping"]:
                cats = [str(c) for c in data.get("categories", [])]
                freed = housekeeping.clean(cats, int(data.get("takesDays", 30)), active_queues(), active_runs())
                return self.send_json({"freed": freed})
        except (KeyError, ValueError) as e:
            return self.fail(str(e))
        except Exception as e:  # anything else: said, logged, never a dropped connection
            traceback.print_exc()
            return self.fail(f"{type(e).__name__}: {e}", 500)
        return self.send_error(404)

    def choom_action(self, cid, action, data):
        names = data.get("names", [])
        with editing(cid) as proj:
            unknown = [n for n in names if n not in proj.clips]
            if unknown:
                return self.fail(f"no clip {unknown[0]}")
            if action == "status":
                if data["status"] not in STATUSES:
                    return self.fail("bad status")
                for n in names:
                    proj.set_status(n, data["status"], data.get("note"))
            elif action == "place":
                for n in names:
                    proj.place(n, bool(data.get("on", True)))
            elif action == "sequence":
                seq = data["sequence"]
                if not seq or (proj.sequence and seq[0] != proj.sequence[0]):
                    return self.fail("her main idle stays first")
                bad = [n for n in seq if proj.clips.get(n, {}).get("status") != "kept"]
                if bad:
                    return self.fail(f"{bad[0]} isn't kept")
                proj.data["sequence"] = list(dict.fromkeys(seq))
            elif action == "reroll":
                for n, seed in zip(names, next_seeds(len(names))):
                    proj.reroll(n, seed)
            elif action == "take":  # bring an earlier take back (its sheet is made again)
                status = proj.use_take(data["name"], int(data["index"]))
                jobs.add("review", {"choom": cid, "clips": [data["name"]]})
                return self.send_json({"status": status, "choom": details(proj)})
            elif action == "deletelook":  # a look out of her project (refused while clips use it)
                try:
                    gone = proj.delete_look(data["look"], bool(data.get("withDropped")))
                except LookHasDropped as e:  # only dropped clips use it: the page asks before they go too
                    return self.send_json({"error": str(e), "dropped": e.count}, 409)
                proj.write_closet()
                return self.send_json({"deleted": gone, "choom": details(proj)})
            elif action == "renameoutfit":  # an outfit, its looks, clips and files under a new name
                names = proj.rename_outfit(data["from"], data["to"], built_clips(cid))
                proj.write_closet()
                return self.send_json({"renamed": names, "choom": details(proj)})
            elif action == "plan":
                library = {(a["pack"], a["key"]): a for a in plan.library()["actions"]}
                items = [library[(i["pack"], i["key"])] if "pack" in i else i for i in data["items"]]
                results = plan.add(proj, data["look"], items)
                return self.send_json({"results": results, "choom": details(proj)})
            elif action == "change":  # a change of clothes on screen, from one look to another
                name, message = plan.add_change(proj, data["from"], data["to"], data.get("key"), data["text"], data.get("seconds", 5))
                if not name:
                    return self.fail(message)
                return self.send_json({"results": [(name, message)], "choom": details(proj)})
            elif action == "rewrite":
                warnings = plan.rewrite(proj, data["name"], data.get("text"), data.get("seconds"))
                return self.send_json({"warnings": warnings, "choom": details(proj)})
            elif action == "unplan":
                for n in names:
                    if proj.clips[n]["status"] == "planned":
                        proj.unplan(n)
            elif action == "outfit":
                # A new look (an outfit, her full body, her asleep) or a new picture for a look she
                # has. Klein makes a few versions from any look's picture (or one sent from his
                # computer, `upload`), and one is picked later; the look it starts from gives the new
                # look its description.
                base, kind = data["base"], data.get("kind", "outfit")
                if kind == "gone":
                    # The empty glass, for walking on and off: a black picture, made at once.
                    if "gone" in proj.looks:
                        return self.fail("she already has the empty glass (gone)")
                    pictures.gone(proj)
                    return self.send_json({"choom": details(proj)})
                if not proj.looks.get(base, {}).get("picture"):
                    return self.fail(f"no {base} picture to start from")
                if kind not in pictures.KINDS:
                    return self.fail("a new look is an outfit, full body, asleep, a place, the empty glass, or a new picture for a look she has")
                if kind not in ("redo", "place") and base_of(base) in ("full", "asleep"):
                    return self.fail("a new look starts from one of her waist-up looks")
                if kind == "outfit":
                    if data["when"] not in pictures.WHEN:
                        return self.fail("an outfit is for cold, hot, evening, day or night")
                    # From another outfit's picture too (Genesis's night look from her plain one), in its pose.
                    look_id = f"{base_of(base)}@{data['when']}{re.sub(r'[^a-z0-9]', '', data.get('name', '').lower())}"
                elif kind == "full":
                    look_id = f"full@{outfit_of(base)}" if outfit_of(base) else "full"  # an outfit's own full body
                elif kind == "asleep":
                    if outfit_of(base) and not outfit_of(base).startswith("night"):
                        return self.fail("she sleeps in her usual clothes or a night outfit")
                    look_id = f"asleep@{outfit_of(base)}" if outfit_of(base) else "asleep"
                elif kind == "place":
                    # A place she goes to and stays a while (sitting by her campfire), named by him.
                    look_id = re.sub(r"[^a-z0-9]", "", data.get("name", "").lower())
                    if not look_id or look_id in pictures.NOT_PLACES or look_id[0].isdigit():
                        return self.fail("give the place a name of its own: letters and digits (campfire, chair)")
                    if not proj.looks.get("full", {}).get("picture"):
                        return self.fail("a place needs her full body first: she sits down from it and gets up into it")
                    if not data.get("wearing", "").strip():
                        return self.fail("say where she is and how (sitting on the ground beside a small campfire ...)")
                else:
                    look_id = data.get("look", "")
                    if not proj.looks.get(look_id, {}).get("picture"):
                        return self.fail("choose the look that gets the new picture")
                if kind != "redo" and look_id in proj.looks and proj.looks[look_id].get("picture"):
                    return self.fail(f"she already has {look_id}" + ("; give it another name" if kind == "outfit" else ""))
                # Pictures sent from his computer: one to start from instead of the look's (`upload`),
                # and more for Klein to take things from (`refs`: a dress, shoes, her face close up).
                stamp = time.strftime("%Y%m%d-%H%M%S")
                sent = [("start", data["upload"])] if data.get("upload") else []
                sent += [(str(i + 2), r) for i, r in enumerate(data.get("refs") or [])]
                saved = {}
                for tag, url in sent:
                    raw = base64.b64decode(url.split(",", 1)[-1])
                    ext = ".jpg" if raw[:3] == b"\xff\xd8\xff" else ".png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else ".webp" if raw[8:12] == b"WEBP" else None
                    if not ext:
                        return self.fail("pictures should be PNG, JPEG or WebP")
                    saved[tag] = f"{cid}_ref_{stamp}_{tag}{ext}"
                    (PICTURES / saved[tag]).write_bytes(raw)
                source = saved.pop("start", proj.looks[base]["picture"])
                refs = list(saved.values())
                wearing = data.get("wearing", "").strip()
                keep = proj.looks[base].get("kleinKeep", "") or (proj.looks["main"].get("kleinKeep", "") if kind == "place" else "")
                default = {"outfit": lambda: pictures.outfit_prompt(wearing, keep), "full": lambda: pictures.full_prompt(keep, wearing),
                           "asleep": lambda: pictures.asleep_prompt(keep), "place": lambda: pictures.place_prompt(wearing, keep),
                           "redo": lambda: pictures.TRUE_COLOR_PROMPT}[kind]
                prompt = (data.get("prompt") or "").strip() or default()
                # The form as he filled it in (when, name, versions too): a discard puts it back to try again.
                proj.data.setdefault("drafts", {})[look_id] = {"base": base, "kind": kind, "wearing": wearing, "prompt": prompt,
                                                               "pictures": [], "status": "making", "count": int(data.get("count", 3)),
                                                               **({"when": data["when"], "name": data.get("name", "")} if kind == "outfit" else {}),
                                                               **({"name": look_id} if kind == "place" else {}),
                                                               **({"upload": True} if data.get("upload") else {}),
                                                               **({"replace": True} if kind == "redo" else {}),
                                                               **({"refs": refs} if refs else {})}
                jobs.add("picture", {"choom": cid, "look": look_id, "source": source, "refs": refs,
                                     "prompt": prompt, "count": int(data.get("count", 3))})
            elif action == "adopt":
                draft = proj.data.get("drafts", {}).get(data["look"])
                if not draft or data["picture"] not in draft["pictures"]:
                    return self.fail("no such draft picture")
                pictures.adopt(proj, data["look"], data["picture"], draft.get("wearing"), draft.get("prompt"), draft.get("base"),
                               bool(draft.get("replace")))
                if draft.get("replace"):  # its clips are planned again from the new picture
                    redo, left = plan.repicture(proj, data["look"])
                    return self.send_json({"replanned": redo, "left": left, "choom": details(proj)})
            elif action == "discard":
                draft = proj.data.get("drafts", {}).pop(data["look"], None)
                if draft and draft.get("clean") and data["look"] in proj.looks:
                    proj.looks[data["look"]]["klein"] = draft.get("prompt")  # a retry (reclean) starts from it
            elif action == "reclean":
                # A new Choom whose first pictures were all discarded has no main picture, and every other
                # way to make one starts from a picture she has: Klein cleans up her source picture again.
                look = proj.looks.get("main", {})
                if look.get("picture"):
                    return self.fail("she has her main picture: a new one comes from New look, “a new picture for a look”")
                found = sorted(PICTURES.glob(f"{cid}_source.*"))
                if not found:
                    return self.fail("her source picture is gone from the pictures folder; make her again with + New Choom")
                prompt = (data.get("prompt") or "").strip() or look.get("klein") or pictures.CLEAN_PROMPT
                proj.data.setdefault("drafts", {})["main"] = {"base": None, "prompt": prompt, "pictures": [], "status": "making",
                                                              "clean": True, "count": int(data.get("count", 3))}
                jobs.add("picture", {"choom": cid, "look": "main", "source": found[0].name, "prompt": prompt,
                                     "count": int(data.get("count", 3))})
            elif action == "look":
                if "picture" in data and not (FILE.match(str(data["picture"])) and (PICTURES / str(data["picture"])).is_file()):
                    return self.fail("a look's picture is a file in the pictures folder")
                look = proj.looks.setdefault(data["look"], {})
                # What she wears, changed on the card: the Subject's clothes follow it, unless the Subject
                # was edited too (then it says what he wrote). An outfit's full body made later builds on it.
                if "wearing" in data and data.get("subject", look.get("subject", "")) == look.get("subject", ""):
                    wearing = str(data["wearing"]).strip().rstrip(".")
                    if wearing:
                        data["subject"] = pictures.subject_for(look, wearing)
                    data["wearing"] = wearing
                for key in ("subject", "ending", "keep", "picture", "wardrobe", "kleinKeep", "wearing"):
                    if key in data:
                        look[key] = data[key]
                if any(k in data for k in ("subject", "ending", "keep")):
                    plan.refresh_prompts(proj, data["look"])  # its planned clips say it the new way
                if "tags" in data:  # closet words; empty goes back to the ones read from her clothes
                    tags = data["tags"] if isinstance(data["tags"], list) else str(data["tags"]).split(",")
                    tags = [w.strip().lower() for w in tags if w.strip()]
                    if tags:
                        look["tags"] = tags
                    else:
                        look.pop("tags", None)
                proj.write_closet()
            elif action == "wish":  # a wish made ("made": it goes on her done list), or let go (it won't be)
                which = lambda w: w["kind"] == data.get("kind") and w["what"] == data.get("what")  # noqa: E731
                gone = [w for w in wishes(cid) if which(w)]
                write_json(PORTRAITS / cid / "wishes.json", [w for w in wishes(cid) if not which(w)])
                if data.get("made") and gone:
                    write_json(PORTRAITS / cid / "wishes_done.json",
                               wishes_done(cid) + [{**gone[0], "made": time.strftime("%Y-%m-%dT%H:%M:%S")}])
            elif action == "home":
                # Her home pose: the one she falls asleep from, wakes into and changes clothes in (Aloy's
                # is relaxed, hand down). Clips planned from now on take it; built ones at the next build.
                pose = str(data.get("pose", ""))
                if pose not in ("main", "relaxed") or (pose != "main" and pose not in proj.looks):
                    return self.fail("her home pose is main, or relaxed if she has that look")
                proj.data["home"] = pose
            else:
                return self.fail("unknown action", 404)
        return self.send_json({"choom": details(Project.load(cid))})

    def new_choom(self, data):
        """A new Choom: her project, her picture, and either Klein clean-ups of it to pick her main
        picture from, or the picture itself as her main look."""
        cid = data.get("id", "").strip().lower()
        if not re.fullmatch(r"[a-z][a-z0-9]{1,23}", cid):
            return self.fail("her id is her name in lower case, letters and digits (as the Choom app calls her)")
        if Project.file(cid).exists():
            return self.fail(f"there is already a Choom called {cid}")
        raw = base64.b64decode(data["picture"].split(",", 1)[-1])
        ext = ".jpg" if raw[:3] == b"\xff\xd8\xff" else ".png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else ".webp" if raw[8:12] == b"WEBP" else None
        if not ext:
            return self.fail("the picture should be a PNG, JPEG or WebP")
        source = f"{cid}_source{ext}"
        (PICTURES / source).write_bytes(raw)
        who = data.get("who", "").strip().rstrip(".")
        proj = Project.new(cid, data.get("name") or cid.title())
        proj.data.update(color=data.get("color") or "#9fb4ff", style=data.get("style") or "motes")
        main = {"subject": f"{who}, glowing softly against a plain pure black background" if who else "",
                "ending": "She stays in the same place and ends exactly as she began, facing the viewer.",
                "wardrobe": f"{who.split(', wearing')[0]}, wearing {{wearing}}, glowing softly against a plain pure black background" if who else ""}
        if data.get("clean", True):
            prompt = data.get("prompt") or pictures.CLEAN_PROMPT
            proj.looks["main"] = {**main, "picture": None}
            proj.data["drafts"] = {"main": {"base": None, "prompt": prompt, "pictures": [], "status": "making", "clean": True}}
            jobs.add("picture", {"choom": cid, "look": "main", "source": source, "prompt": prompt, "count": int(data.get("count", 3))})
        else:
            proj.looks["main"] = {**main, "picture": source}
        proj.save()
        return self.send_json({"choom": details(proj)})

    def start_render(self, data):
        """Queue planned clips ([[choom, clip], ...], or every planned clip of the Chooms named) and
        start rendering now or at a time (epoch seconds)."""
        picks = [tuple(p) for p in data.get("picks", [])]
        for cid in data.get("chooms", []):
            proj = Project.load(cid)
            picks += [(cid, n) for n, c in proj.clips.items() if c["status"] == "planned"]
        if not picks:
            return self.fail("nothing planned to render")
        name = data.get("queue") or time.strftime("studio_%Y%m%d-%H%M%S")
        if not NAME.match(name):
            return self.fail("bad queue name")
        render.make_queue(name, picks)
        job = jobs.add("render", {"queue": name, "clips": len(picks)}, not_before=float(data.get("at", 0)))
        return self.send_json({"job": job, "ahead": self.ahead(job)})

    @staticmethod
    def ahead(job):
        """What a new GPU job waits behind: [kind, ...] of GPU jobs running or due before it, and
        whether the work list is paused."""
        with jobs.lock:
            before = [j["kind"] for j in jobs.jobs if j["id"] < job["id"] and jobs.LANES[j["kind"]] == "gpu"
                      and (j["status"] in jobs.BUSY or (j["status"] == "waiting" and j.get("not_before", 0) <= time.time()))]
            return {"jobs": before, "paused": jobs.worklist["paused"] or jobs.worklist["pausing"]}

    def start_build(self, data):
        """Build her sequence: now, at a time (`at`, epoch s), or after the render waiting or running
        (`after`: "render"). A build reads her sequence when it starts, so one already waiting covers
        this click too (its time changes to the new one, if one is given)."""
        proj = Project.load(data["choom"])
        trouble = build.problems(proj)
        if trouble:
            return self.fail("; ".join(trouble))
        at, after = float(data.get("at") or 0), None
        if data.get("after") == "render":
            with jobs.lock:
                renders = [j for j in jobs.jobs if j["kind"] == "render" and j["status"] in ("waiting", "running", "paused")]
            if not renders:
                return self.fail("no render is waiting or running to build after")
            after = renders[-1]["id"]
        with jobs.lock:
            waiting = next((j for j in jobs.jobs if j["kind"] == "build" and j["status"] == "waiting"
                            and j["args"]["choom"] == proj.id), None)
            if waiting:
                if "at" in data or "after" in data:
                    waiting["not_before"] = at
                    if after:
                        waiting["after"] = after
                    else:
                        waiting.pop("after", None)
                    jobs.save()
                return self.send_json({"job": waiting, "already": True, "ahead": self.ahead(waiting)})
        job = jobs.add("build", {"choom": proj.id, "relaunch": data.get("relaunch", True)}, not_before=at, after=after)
        return self.send_json({"job": job, "ahead": self.ahead(job)})


def serve():
    ensure_workspace()
    host, port = CFG.get("host", "127.0.0.1"), int(CFG["port"])
    httpd = ThreadingHTTPServer((host, port), Handler)  # first, so a second Studio stops here, before any work
    jobs.start_workers()
    print(f"Glass Studio on http://{host}:{port}  (workspace {WORKSPACE})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    serve()
