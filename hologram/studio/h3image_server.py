#!/usr/bin/env python3
"""The Chooms' pictures with MiniMax H3 Image: keeps the model loaded on the GPU between pictures (about
35 s a picture, against 2.5 min to load it), and takes turns with Glass Studio's clip renders.

Run with WanGP's own Python (systemd user unit choom-h3image.service):
    ~/pinokio/api/wan2gp/app/venv/bin/python studio/h3image_server.py

The Choom app (Settings > Image engine: MiniMax H3 Image) sends each picture here:
    POST /jobs   {prompt, width, height, seed, references: [base64 png, ...], label}  -> {id}
    GET  /jobs/<id>?wait=50   -> {status: waiting|running|done|failed, image (base64 png), seed, ms, ...}
The prompt names its references as <Picture 1>, <Picture 2> ... in the order they are sent (the app
writes that sentence; see lib/h3-image-client.ts). Every route but GET /health wants the token in
~/.config/choom-h3image/token as "Authorization: Bearer <token>" (the Mac keeps it in .env as
H3_IMAGE_TOKEN).

Taking turns. A picture borrows the GPU from the Studio first (POST /api/selfie on the Studio): a clip
render running then steps aside once the clip it's on has landed, the picture is made, and the render
carries on by itself (jobs.py, the "selfie" lane). The Studio also asks this server to let go of the GPU
before a render or a Klein picture starts (POST /release), and to load again once the GPU has been idle
a minute (POST /load with restore: only if it was loaded before). The model takes the card's memory
only while it draws (about 20 GB; WanGP keeps it in about 32 GB of system RAM between pictures and
streams it to the card), but a clip render needs most of the RAM and the card, so the two don't run
together. Without the Studio running, pictures just go ahead.

WanGP runs from its own copy of WanGP's settings (~/.config/choom-h3image/wgp_config.json, remade at
every start from WanGP's own, with the text encoder in INT8: 27 GB instead of 52), so nothing here
changes WanGP's settings for its own window or the Studio's renders.
"""
import base64
import json
import os
import random
import secrets
import shutil
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WAN2GP = Path(os.environ.get("WAN2GP", Path.home() / "pinokio/api/wan2gp/app"))
HOME = Path(os.environ.get("H3IMAGE_HOME", Path.home() / ".config/choom-h3image"))
WORK = Path(os.environ.get("H3IMAGE_WORK", Path.home() / ".cache/choom-h3image"))
PORT = int(os.environ.get("H3IMAGE_PORT", "7870"))
STUDIO = os.environ.get("STUDIO_URL", "http://127.0.0.1:8767")
FORGE = os.environ.get("FORGE_URL", "http://127.0.0.1:7860")
MODEL = os.environ.get("H3IMAGE_MODEL", "minimax_h3_image_pruned")
OWN_SETTINGS = {"text_encoder_quantization": "int8"}  # over WanGP's own wgp_config.json
NEEDS_GB = 24            # free VRAM it wants to draw (20 GB measured at 2048x1152 with 3 references); under it, Forge unloads Klein
LEND_WAIT_S = 20 * 60    # longest it waits for the Studio to lend the GPU (a render finishing its clip)
KEEP_JOBS_S = 15 * 60    # a finished picture is kept this long for the app to collect

STATE_FILE = HOME / "state.json"
TOKEN_FILE = HOME / "token"


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def token():
    HOME.mkdir(parents=True, exist_ok=True)
    if not TOKEN_FILE.exists():
        TOKEN_FILE.write_text(secrets.token_urlsafe(32) + "\n")
        TOKEN_FILE.chmod(0o600)
    return TOKEN_FILE.read_text().strip()


def own_config():
    """WanGP's settings with the text encoder in INT8, in a folder of our own (it must be named
    wgp_config.json)."""
    cfg = json.loads((WAN2GP / "wgp_config.json").read_text())
    cfg.update(OWN_SETTINGS)
    path = HOME / "wgp_config.json"
    path.write_text(json.dumps(cfg, indent=1))
    return path


def call(url, payload=None, timeout=15):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"},
                                 method="GET" if payload is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def free_vram_gb():
    import torch
    free, _total = torch.cuda.mem_get_info()
    return free / 1e9


class Engine:
    """One WanGP session, used by one worker thread: pictures, loads and releases happen in turn."""

    def __init__(self):
        self.session = None
        self.state = "off"            # off | loading | ready | busy | released (let go for the Studio)
        self.wanted = self._wanted()  # loaded the last time the app asked (kept across restarts)
        self.lock = threading.Lock()  # held while the session is in use
        self.last = {}

    @staticmethod
    def _wanted():
        try:
            return bool(json.loads(STATE_FILE.read_text()).get("wanted"))
        except (OSError, ValueError):
            return False

    def set_wanted(self, wanted):
        self.wanted = wanted
        STATE_FILE.write_text(json.dumps({"wanted": wanted}))

    def _session(self):
        if self.session is None:
            sys.path.insert(0, str(WAN2GP))
            os.chdir(WAN2GP)
            from shared.api import init
            (WORK / "out").mkdir(parents=True, exist_ok=True)
            self.session = init(root=WAN2GP, config_path=own_config(), output_dir=WORK / "out", console_output=False)
        return self.session

    def _make_room(self):
        """Before loading: Klein in Forge holds 28 GB the model may need. Forge loads Klein again by
        itself the next time something asks it for a picture."""
        try:
            if free_vram_gb() < NEEDS_GB:
                call(f"{FORGE}/sdapi/v1/unload-checkpoint", {}, timeout=60)
                log(f"asked Forge to unload Klein ({free_vram_gb():.0f} GB free now)")
        except Exception as e:
            log("could not check or free VRAM:", type(e).__name__, e)

    def run(self, settings):
        session = self._session()
        if self.state in ("off", "released"):
            self._make_room()
        defaults = session.get_default_settings(MODEL)
        result = session.submit_task({**defaults, **settings, "model_type": MODEL}).result()
        if not result.success or not result.generated_files:
            raise RuntimeError("; ".join(e.message for e in result.errors) or "WanGP made no picture")
        return Path(result.generated_files[0])

    def load(self):
        """Load the model by making a tiny picture (WanGP loads a model when a task needs it)."""
        with self.lock:
            if self.state in ("ready", "busy"):
                return
            self.state = "loading"
            started = time.time()
            try:
                out = self.run({"prompt": "A plain grey wall.", "resolution": "2048x2048", "num_inference_steps": 1,
                                "guidance_scale": 1.0, "seed": 1, "image_mode": 1, "batch_size": 1,
                                "video_prompt_type": "", "image_refs": None})
                out.unlink(missing_ok=True)
                self.state = "ready"
                log(f"{MODEL} loaded in {time.time() - started:.0f} s ({free_vram_gb():.0f} GB VRAM left)")
            except Exception:
                self.state = "off"
                log("loading failed:", traceback.format_exc(limit=3))

    def release(self, off=False):
        """Let go of the GPU (the model leaves VRAM and RAM). off: the app switched to Klein, so don't
        load again for the Studio either."""
        with self.lock:
            if self.session is not None and self.state != "off":
                self.session.close()
            self.state = "off" if off else ("released" if self.wanted else "off")
            if off:
                self.set_wanted(False)
            log(f"released the GPU ({'engine switched off' if off else 'for the Studio'})")

    def picture(self, job):
        """One picture: borrow the GPU from the Studio, make it, give the GPU back."""
        req = job["req"]
        w, h = (max(256, round(int(req.get(k) or 1024) / 32) * 32) for k in ("width", "height"))
        seed = req.get("seed")
        seed = int(seed) if isinstance(seed, (int, float)) and seed >= 0 else random.randrange(2 ** 31)
        tmp = Path(tempfile.mkdtemp(dir=WORK))
        lent, started = None, time.time()
        try:
            refs = []
            for i, b64 in enumerate(req.get("references") or []):
                path = tmp / f"ref{i + 1}.png"
                path.write_bytes(base64.b64decode(str(b64).split(",", 1)[-1]))
                refs.append(str(path))
            job["status"] = "waiting"
            lent = lend(req.get("label") or "a Choom's picture")
            job["waitedMs"] = int((time.time() - started) * 1000)
            with self.lock:
                job["status"] = "running"
                self.state = "busy" if self.state == "ready" else "loading"
                began = time.time()
                out = self.run({"prompt": req["prompt"], "resolution": f"{w}x{h}", "num_inference_steps": 6,
                                "guidance_scale": 1.0, "guidance_phases": 1, "sample_solver": "euler", "seed": seed,
                                "image_mode": 1, "batch_size": 1, "video_prompt_type": "I" if refs else "",
                                "image_refs": refs or None})
                job.update(image=base64.b64encode(out.read_bytes()).decode(), seed=seed, width=w, height=h,
                           ms=int((time.time() - began) * 1000), status="done")
                out.unlink(missing_ok=True)
                self.state = "ready"
                if not self.wanted:
                    self.set_wanted(True)
            log(f"picture for {req.get('label') or '?'}: {w}x{h}, {len(refs)} refs, {job['ms'] / 1000:.0f} s"
                f" (+{job['waitedMs'] / 1000:.0f} s waiting for the GPU)")
        except Exception as e:
            job.update(status="failed", error=f"{type(e).__name__}: {e}")
            if self.state in ("busy", "loading"):
                self.state = "ready" if self.session is not None else "off"
            log("picture failed:", traceback.format_exc(limit=3))
        finally:
            give_back(lent)
            shutil.rmtree(tmp, ignore_errors=True)
            self.last = {k: job.get(k) for k in ("status", "ms", "waitedMs", "width", "height", "error")}


def lend(label):
    """Borrow the GPU from Glass Studio; None if the Studio isn't there to take turns with."""
    try:
        job = call(f"{STUDIO}/api/selfie", {"label": label})["id"]
    except Exception:
        return None
    deadline = time.time() + LEND_WAIT_S
    while time.time() < deadline:
        try:
            status = call(f"{STUDIO}/api/selfie/{job}").get("status")
        except Exception:
            return job  # the Studio went away: go ahead
        if status != "waiting":
            return job
        time.sleep(1)
    give_back(job)
    raise RuntimeError(f"the GPU stayed busy for {LEND_WAIT_S // 60} minutes (Glass Studio didn't lend it)")


def give_back(job):
    if job is not None:
        try:
            call(f"{STUDIO}/api/selfie/{job}/done", {})
        except Exception:
            pass


engine = Engine()
jobs, jobs_lock, todo = {}, threading.Lock(), []
work = threading.Condition()


def worker():
    while True:
        with work:
            while not todo:
                work.wait()
            item = todo.pop(0)
        if item == "load":
            engine.load()
        else:
            engine.picture(item)
        with jobs_lock:
            for jid in [j for j, v in jobs.items() if v.get("ended", time.time()) < time.time() - KEEP_JOBS_S]:
                jobs.pop(jid, None)
            if item != "load":
                item["ended"] = time.time()


def queue(item):
    with work:
        todo.append(item)
        work.notify()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if self.headers.get("Authorization", "") == f"Bearer {TOKEN}":
            return True
        self.send(401, {"error": "token needed"})
        return False

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            return self.send(200, {"ok": True, "model": MODEL, "state": engine.state, "wanted": engine.wanted,
                                   "queued": len(todo), "last": engine.last})
        if not self.authorized():
            return
        if path.startswith("/jobs/"):
            jid = path.split("/")[2]
            wait = 0.0
            if "wait=" in self.path:
                wait = min(float(self.path.split("wait=")[1].split("&")[0] or 0), 55)
            deadline = time.time() + wait
            while True:
                job = jobs.get(jid)
                if job is None:
                    return self.send(404, {"error": "no such job (pictures are kept 15 minutes)"})
                if job["status"] in ("done", "failed") or time.time() >= deadline:
                    return self.send(200, {k: v for k, v in job.items() if k != "req"})
                time.sleep(0.5)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self.authorized():
            return
        try:
            body = self.body()
        except ValueError:
            return self.send(400, {"error": "bad JSON"})
        if path == "/jobs":
            if not str(body.get("prompt") or "").strip():
                return self.send(400, {"error": "prompt required"})
            jid = secrets.token_hex(8)
            job = {"id": jid, "status": "queued", "req": body, "queuedAt": time.time()}
            with jobs_lock:
                jobs[jid] = job
            queue(job)
            return self.send(200, {"id": jid, "status": "queued", "ahead": len(todo) - 1})
        if path == "/load":
            if body.get("restore") and not (engine.wanted and engine.state == "released"):
                return self.send(200, {"state": engine.state, "wanted": engine.wanted})
            if not body.get("restore"):
                engine.set_wanted(True)
            queue("load")
            return self.send(200, {"state": "loading"})
        if path == "/release":
            engine.release(off=bool(body.get("off")))
            return self.send(200, {"state": engine.state, "wanted": engine.wanted})
        self.send(404, {"error": "not found"})


TOKEN = token()

if __name__ == "__main__":
    WORK.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=worker, daemon=True).start()
    if engine.wanted:
        queue("load")  # it was in use before this start (a reboot): load again
    log(f"H3 Image server on :{PORT} ({MODEL}); {'loading' if engine.wanted else 'loads when first asked'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
