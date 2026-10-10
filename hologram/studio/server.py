#!/usr/bin/env python3
"""Glass Studio's local server: the Studio page (web/) and its API over the Chooms' project files.
Started by `studio.py serve`; listens on 127.0.0.1:8767 unless studio.json says otherwise.
Standard library only, like the hologram's own server."""
import json
import mimetypes
import re
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import build
import jobs
import pictures
import plan
import prompts
import render
from config import CFG, CLIPS, PICTURES, PORTRAITS, SHEETS, WORKSPACE, ensure_workspace
from project import STATUSES, Project, editing, next_seeds

WEB = Path(__file__).resolve().parent / "web"
NAME = re.compile(r"^[a-z0-9][a-z0-9_@\-]*$")
FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_@\-.]*$")


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
    alive = PORTRAITS / proj.id / "alive.json"
    built = [c["source"].removesuffix(".mp4") for c in json.loads(alive.read_text())["clips"]] if alive.exists() else []
    glass = {"added": [n for n in proj.sequence if n not in built], "removed": [n for n in built if n not in proj.sequence]}
    return {**proj.data, "stats": looks, "problems": build.problems(proj), "glass": glass, "color": colors().get(proj.id),
            "plannedMinutes": round(sum(render.minutes(c.get("frames") or 124) for c in planned))}


def colors():
    manifest = PORTRAITS / "manifest.json"
    return {m["id"]: m.get("color") for m in json.loads(manifest.read_text())} if manifest.exists() else {}


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
            folder = {"clip": CLIPS, "sheet": SHEETS, "picture": PICTURES, "draft": pictures.DRAFTS}.get(parts[1])
            return self.send_file(folder / parts[2], cache=parts[1] != "sheet") if folder else self.send_error(404)
        if parts[:2] == ["api", "chooms"]:
            tint = colors()
            return self.send_json({"chooms": [{**Project.load(c).summary(), "color": tint.get(c)} for c in Project.ids()],
                                   "workspace": str(WORKSPACE), "minutesPerClip": CFG["minutes_per_clip"]})
        if parts[:2] == ["api", "choom"] and len(parts) == 3 and NAME.match(parts[2]):
            if not Project.file(parts[2]).exists():
                return self.fail("no such Choom", 404)
            return self.send_json(details(Project.load(parts[2])))
        if parts[:2] == ["api", "options"] and len(parts) == 4:
            return self.send_json({"options": plan.options(Project.load(parts[2]), parts[3])})
        if parts[:2] == ["api", "packs"]:
            return self.send_json({"packs": plan.library()["packs"]})
        if parts[:2] == ["api", "jobs"]:
            with jobs.lock:
                return self.send_json({"jobs": jobs.jobs[-40:]})
        return self.send_error(404)

    # --- POST ----------------------------------------------------------------------------------
    def do_POST(self):
        parts = [p for p in urllib.parse.urlparse(self.path).path.strip("/").split("/") if p]
        try:
            data = self.body()
        except json.JSONDecodeError:
            return self.fail("bad JSON")
        try:
            if parts[:2] == ["api", "choom"] and len(parts) == 4 and NAME.match(parts[2]):
                return self.choom_action(parts[2], parts[3], data)
            if parts == ["api", "render"]:
                return self.start_render(data)
            if parts == ["api", "build"]:
                proj = Project.load(data["choom"])
                trouble = build.problems(proj)
                if trouble:
                    return self.fail("; ".join(trouble))
                return self.send_json({"job": jobs.add("build", {"choom": proj.id, "relaunch": data.get("relaunch", True)})})
            if parts == ["api", "review"]:
                return self.send_json({"job": jobs.add("review", {"choom": data["choom"], "clips": data.get("clips", [])})})
            if parts[:2] == ["api", "jobs"] and len(parts) == 4 and parts[3] == "cancel":
                return self.send_json({"cancelled": jobs.cancel(int(parts[2]))})
        except (KeyError, ValueError) as e:
            return self.fail(str(e))
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
            elif action == "plan":
                library = {(a["pack"], a["key"]): a for a in plan.library()["actions"]}
                items = [library[(i["pack"], i["key"])] if "pack" in i else i for i in data["items"]]
                results = plan.add(proj, data["look"], items)
                return self.send_json({"results": results, "choom": details(proj)})
            elif action == "rewrite":
                warnings = plan.rewrite(proj, data["name"], data.get("text"), data.get("seconds"))
                return self.send_json({"warnings": warnings, "choom": details(proj)})
            elif action == "unplan":
                for n in names:
                    if proj.clips[n]["status"] == "planned":
                        proj.unplan(n)
            elif action == "outfit":
                # A new outfit: Klein makes versions of her in it from a look's picture.
                base = data["base"]
                if not proj.looks.get(base, {}).get("picture"):
                    return self.fail(f"no {base} picture to start from")
                if data["when"] not in pictures.WHEN:
                    return self.fail("an outfit is for cold, hot, evening or day")
                look_id = f"{base}@{data['when']}{re.sub(r'[^a-z0-9]', '', data.get('name', '').lower())}"
                if look_id in proj.looks:
                    return self.fail(f"she already has {look_id}; give it another name")
                wearing = data.get("wearing", "").strip()
                prompt = (data.get("prompt") or "").strip() or pictures.outfit_prompt(wearing, proj.looks[base].get("kleinKeep", ""))
                proj.data.setdefault("drafts", {})[look_id] = {"base": base, "wearing": wearing, "prompt": prompt,
                                                               "pictures": [], "status": "making"}
                jobs.add("picture", {"choom": cid, "look": look_id, "source": proj.looks[base]["picture"],
                                     "prompt": prompt, "count": int(data.get("count", 3))})
            elif action == "adopt":
                draft = proj.data.get("drafts", {}).get(data["look"])
                if not draft or data["picture"] not in draft["pictures"]:
                    return self.fail("no such draft picture")
                pictures.adopt(proj, data["look"], data["picture"], draft.get("wearing"), draft.get("prompt"))
            elif action == "discard":
                proj.data.get("drafts", {}).pop(data["look"], None)
            elif action == "look":
                look = proj.looks.setdefault(data["look"], {})
                for key in ("subject", "ending", "keep", "picture"):
                    if key in data:
                        look[key] = data[key]
            else:
                return self.fail("unknown action", 404)
        return self.send_json({"choom": details(Project.load(cid))})

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
        return self.send_json({"job": job})


def serve():
    ensure_workspace()
    host, port = CFG.get("host", "127.0.0.1"), int(CFG["port"])
    httpd = ThreadingHTTPServer((host, port), Handler)  # first, so a second Studio stops here, before any work
    jobs.start_workers()
    print(f"Glass Studio on http://{host}:{port}  (workspace {WORKSPACE})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    serve()
