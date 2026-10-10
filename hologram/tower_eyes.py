#!/usr/bin/env python3
"""The tower's eyes: is Donny looking at the glass?

Watches the camera mounted at the Portrait's top edge and tells the page when he looks at the glass
and when he looks away, so the Choom on it can turn to him. Uses MediaPipe's face landmarker: his
head's turn (from the face's transformation matrix) plus where his irises sit in his eyes gives one
gaze direction. Looking at the glass means within YAW_LIMIT of straight on, and his head's tilt near
his usual one (learned while he faces the camera, so it fits however the camera is mounted). Frames
are processed in memory and never written anywhere; only "looking" / "not looking" changes are sent
and logged.

It also answers the Choom app's Camera tab and the Chooms' "glass" camera, on 127.0.0.1:8766 only
(server.py relays requests from the Choom app): the latest frame as a JPEG (kept in memory, replaced
twelve times a second), the camera's adjustments, and its settings (camera on or off, the Chooms
allowed to look, eye contact, how wide "looking at the glass" is). Settings live in camera.json in
the hologram's config folder and are applied again whenever the camera starts.

Finds a USB camera by name (a Logitech Brio first) and waits quietly until one is plugged in.
Run with the hologram's venv (launch.sh starts it):  .venv-ears/bin/python tower_eyes.py
Test on a video file:  .venv-ears/bin/python tower_eyes.py --source clip.mp4 --print
"""
import argparse
import json
import math
import os
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

from camera_controls import CameraControls

HOLOGRAM_URL = os.environ.get("HOLOGRAM_URL", "http://127.0.0.1:8765")
MODEL = Path.home() / ".cache" / "mediapipe" / "face_landmarker.task"
FPS = 12                  # frames looked at per second
YAW_LIMIT = 6.0           # degrees either side of straight on that still count as looking at her. Measured at
                          # the desk (Oct 9): on the glass within about 3°, the monitors from 9° and 15° out
PITCH_LIMIT = 18.0        # degrees from his usual head tilt
EYE_DEGREES = 50.0        # how far a fully turned iris (offset 1) turns his gaze
LOOK_AFTER = 0.5          # seconds of looking before it counts
AWAY_AFTER = 1.5          # seconds of looking away before it counts
FACE_GONE_AFTER = 3.0     # seconds without a face before he's gone from the tower
CONFIG = Path(os.environ.get("HOLOGRAM_CONFIG", Path.home() / ".config" / "choom-hologram")) / "camera.json"
PORT = 8766
DEFAULTS = {
    "enabled": True,          # off: the camera is let go (its light goes out); no eye contact, no welcome back
    "chooms": True,           # the Chooms may take a snapshot ("glass" in their camera tool)
    "eye_contact": True,      # the Choom on the glass turns to him when he looks at her
    "yaw_limit": YAW_LIMIT,   # degrees either side of straight on that count as looking at the glass
    "welcome": True,          # welcome back when he sits down after a while (server.py reads these two)
    "welcome_minutes": 20,
    "controls": {},           # the camera's adjustments, applied again when it starts
}


def load_settings():
    try:
        return {**DEFAULTS, **json.loads(CONFIG.read_text())}
    except (OSError, ValueError):
        return dict(DEFAULTS)


def save_settings(settings):
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, indent=1))
    tmp.replace(CONFIG)


def usb_id(index):
    """The camera's USB vendor:product, for its vendor controls."""
    try:
        dev = Path(os.path.realpath(f"/sys/class/video4linux/video{index}/device")).parent
        return f"{(dev / 'idVendor').read_text().strip()}:{(dev / 'idProduct').read_text().strip()}"
    except OSError:
        return None


def post(payload):
    try:
        request = urllib.request.Request(f"{HOLOGRAM_URL}/eyes", data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
        urllib.request.urlopen(request, timeout=3).read()
    except Exception:
        pass


def find_camera():
    """The first USB camera by name (Brio preferred), as a /dev/video index, or None. Virtual
    cameras (v4l2loopback) aren't on USB and are skipped."""
    found = []
    for node in sorted(Path("/sys/class/video4linux").glob("video*")):
        name = (node / "name").read_text().strip() if (node / "name").exists() else ""
        index = int(node.name[5:])
        if "/usb" not in os.path.realpath(node / "device"):
            continue
        if (node / "index").exists() and (node / "index").read_text().strip() != "0":
            continue  # a camera's second node is metadata, not frames
        found.append((0 if "brio" in name.lower() else 1, index, name))
    return min(found)[1:] if found else None


def head_angles(matrix):
    """Yaw (turn, + toward image right) and pitch (tilt, + down) in degrees from the face matrix."""
    rotation = np.array(matrix)[:3, :3]
    yaw = math.degrees(math.asin(max(-1.0, min(1.0, rotation[0, 2]))))
    pitch = math.degrees(math.atan2(-rotation[1, 2], rotation[2, 2]))
    return yaw, pitch


def iris_offset(points):
    """How far his irises sit toward the image's right (+) or left (-) of his eyes, -1..1."""
    def one(outer, inner, iris):
        o, i, c = (np.array(points[k][:2]) for k in (outer, inner, iris))
        half = np.linalg.norm(i - o) / 2
        return float(np.dot(c - (o + i) / 2, (i - o) / (2 * half)) / half) if half > 0 else 0.0
    return (one(33, 133, 468) - one(263, 362, 473)) / 2


class Eyes:
    def __init__(self, show=False):
        self.show = show
        self.landmarker = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(MODEL)), running_mode=vision.RunningMode.VIDEO,
            num_faces=1, output_facial_transformation_matrixes=True))
        self.pitch_usual = None       # his head tilt when facing the camera, learned as he does
        self.looking = False
        self.face = False
        self.since = {"look": None, "away": None, "face": None}
        self.started = time.monotonic()
        self.roi, self.roi_seen, self.search, self.clock = None, 0.0, 0, -1   # where his face is in the frame
        self.settings = load_settings()
        self.lock = threading.Lock()
        self.frame, self.frame_at, self.face_box, self.last_gaze = None, 0.0, None, None
        self.camera_name, self.controls = None, None
        self.wake = threading.Event()       # a setting changed: the camera loop looks again at once

    def gaze(self, frame, now):
        """(gaze yaw, head pitch) of the face in this frame, or None. MediaPipe shrinks its input to a
        small square before it looks for a face, and at the desk his face is a tenth of a wide camera's
        frame: too small to find. So it looks at a square crop: around his face once found (about three
        and a half faces wide), else the middle of the frame, then each side in turn."""
        h, w = frame.shape[:2]
        if self.roi is None:
            side = min(h, w)
            spots = [(w - side) // 2, 0, w - side]
            x0, y0, size = spots[self.search % len(spots)], 0, side
            self.search += 1
        else:
            x0, y0, size = self.roi
        crop = np.ascontiguousarray(frame[y0:y0 + size, x0:x0 + size])
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        self.clock = max(self.clock + 1, int((now - self.started) * 1000))  # VIDEO mode wants rising times
        result = self.landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), self.clock)
        if not result.face_landmarks:
            if self.roi is not None and now - self.roi_seen > 1.0:
                self.roi = None  # lost him: search the whole frame again
            return None
        points = [(p.x, p.y) for p in result.face_landmarks[0]]
        xs, ys = [x for x, _ in points], [y for _, y in points]
        cx, cy = x0 + size * (min(xs) + max(xs)) / 2, y0 + size * (min(ys) + max(ys)) / 2
        face = size * (max(xs) - min(xs))
        self.face_box = (int(x0 + size * min(xs)), int(y0 + size * min(ys)), int(x0 + size * max(xs)), int(y0 + size * max(ys)))
        new = int(min(min(h, w), max(320, 3.5 * face)))
        self.roi = (int(min(max(cx - new / 2, 0), w - new)), int(min(max(cy - new / 2, 0), h - new)), new)
        self.roi_seen = now
        yaw, pitch = head_angles(result.facial_transformation_matrixes[0])
        return yaw + EYE_DEGREES * iris_offset(points), pitch

    def update(self, seen, now):
        """Debounced state from this frame; tells the page when it changes."""
        changed = False
        self.last_gaze = seen
        if seen is None:
            self.face_box = None if not self.face else self.face_box
            if self.face and now - (self.since["face"] or now) > FACE_GONE_AFTER:
                self.face, self.looking, changed = False, False, True
        else:
            self.since["face"] = now
            if not self.face:
                self.face, changed = True, True
            gaze_yaw, pitch = seen
            facing = abs(gaze_yaw) < float(self.settings.get("yaw_limit", YAW_LIMIT))
            if facing:  # learn his usual tilt while he faces the camera
                self.pitch_usual = pitch if self.pitch_usual is None else self.pitch_usual + (pitch - self.pitch_usual) * 0.02
            at_glass = facing and abs(pitch - (self.pitch_usual or pitch)) < PITCH_LIMIT and self.settings.get("eye_contact", True)
            key = "look" if at_glass else "away"
            self.since["away" if at_glass else "look"] = None
            self.since[key] = self.since[key] or now
            held = now - self.since[key]
            if at_glass != self.looking and held >= (LOOK_AFTER if at_glass else AWAY_AFTER):
                self.looking, changed = at_glass, True
        if changed:
            post({"looking": self.looking, "face": self.face})
        return changed

    def run_camera(self):
        threading.Thread(target=self.serve, daemon=True).start()
        while True:
            if not self.settings.get("enabled", True):
                self.wake.wait(30)  # turned off in the Choom app: the camera stays free and dark
                self.wake.clear()
                continue
            camera = find_camera()
            if camera is None:
                self.wake.wait(30)  # plugged in later: picked up on its own
                self.wake.clear()
                continue
            index, name = camera
            cap = cv2.VideoCapture(index, cv2.CAP_V4L2)
            if not cap.isOpened():
                time.sleep(30)
                continue
            self.camera_name, self.controls = name, CameraControls(index, usb_id(index))
            self.controls.set(self.settings.get("controls") or {})
            # 720p at 15 frames a second is plenty (it follows his face with a crop), and frames it
            # skips are only grabbed, never decoded: decoding every 1080p frame took most of a core.
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            cap.set(cv2.CAP_PROP_FPS, 15)
            post({"camera": name})
            last = 0.0
            while cap.isOpened() and self.settings.get("enabled", True):
                if not cap.grab():
                    break
                now = time.monotonic()
                if now - last < 1 / FPS:
                    continue
                ok, frame = cap.retrieve()
                if not ok:
                    break
                last = now
                with self.lock:
                    self.frame, self.frame_at = frame, now
                self.update(self.gaze(frame, now), now)
            cap.release()
            with self.lock:
                self.frame, self.face_box = None, None
            self.camera_name = None
            if self.face or self.looking:
                self.face, self.looking = False, False
                post({"looking": False, "face": False})
            post({"camera": None})
            time.sleep(1)

    # --- the Choom app's Camera tab and the Chooms' snapshots (127.0.0.1 only) ---------------
    def state(self):
        controls = None
        if self.controls and self.camera_name:
            try:
                controls = self.controls.describe()
            except OSError:
                controls = None
        settings = {k: v for k, v in self.settings.items() if k != "controls"}
        return {"camera": self.camera_name, "streaming": self.frame is not None, "face": self.face,
                "looking": self.looking, "gaze": None if self.last_gaze is None else round(self.last_gaze[0], 1),
                "settings": settings, "controls": controls, "light": False}

    def jpeg(self, width=960, overlay=False):
        """The latest frame as a JPEG, or None. With overlay: where it sees his face, green while he's
        looking at the glass, for positioning the camera."""
        with self.lock:
            frame = None if self.frame is None or time.monotonic() - self.frame_at > 3 else self.frame.copy()
            box = self.face_box
        if frame is None:
            return None
        if overlay and box:
            color = (80, 220, 80) if self.looking else (60, 180, 255)
            cv2.rectangle(frame, box[:2], box[2:], color, 3)
            gaze = "" if self.last_gaze is None else f"  {self.last_gaze[0]:+.0f} deg"
            cv2.putText(frame, ("looking at the glass" if self.looking else "face") + gaze, (box[0], max(30, box[1] - 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, color, 2, cv2.LINE_AA)
        h, w = frame.shape[:2]
        if width and width < w:
            frame = cv2.resize(frame, (width, int(h * width / w)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return buf.tobytes() if ok else None

    def change(self, body):
        """Apply settings and adjustments from the Choom app; returns the new state."""
        settings = dict(self.settings)
        for key in ("enabled", "chooms", "eye_contact", "welcome"):
            if isinstance(body.get(key), bool):
                settings[key] = body[key]
        if isinstance(body.get("yaw_limit"), (int, float)):
            settings["yaw_limit"] = max(2.0, min(20.0, float(body["yaw_limit"])))
        if isinstance(body.get("welcome_minutes"), (int, float)):
            settings["welcome_minutes"] = max(5, min(240, int(body["welcome_minutes"])))
        controls = dict(settings.get("controls") or {})
        if body.get("reset_controls"):
            controls = {}
            if self.controls and self.camera_name:
                defaults = {n: c["default"] for n, c in self.controls.describe().items() if "default" in c}
                self.controls.set({**defaults, "field_of_view": 90})
        if isinstance(body.get("controls"), dict):
            wanted = {k: v for k, v in body["controls"].items() if isinstance(v, (int, float))}
            if self.controls and self.camera_name:
                self.controls.set(wanted)
            controls.update(wanted)
        settings["controls"] = controls
        if not settings.get("eye_contact") and self.looking:
            self.looking = False
            post({"looking": False, "face": self.face})
        self.settings = settings
        save_settings(settings)
        self.wake.set()
        return self.state()

    def serve(self):
        eyes = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, code, body, kind="application/json"):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                url = urllib.parse.urlparse(self.path)
                query = dict(urllib.parse.parse_qsl(url.query))
                if url.path == "/state":
                    return self.reply(200, eyes.state())
                if url.path == "/frame":
                    if query.get("purpose") == "snapshot" and not eyes.settings.get("chooms", True):
                        return self.reply(403, {"error": "Donny has turned off the Chooms' access to the glass camera."})
                    if not eyes.settings.get("enabled", True):
                        return self.reply(409, {"error": "The glass camera is turned off."})
                    data = eyes.jpeg(int(query.get("width", 960)), query.get("overlay") == "1")
                    if data is None:
                        return self.reply(503, {"error": "The glass camera has no picture right now (unplugged or starting)."})
                    return self.reply(200, data, "image/jpeg")
                self.reply(404, {"error": "not found"})

            def do_POST(self):
                if urllib.parse.urlparse(self.path).path != "/settings":
                    return self.reply(404, {"error": "not found"})
                try:
                    body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                except ValueError:
                    return self.reply(400, {"error": "bad json"})
                self.reply(200, eyes.change(body))

        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

    def run_file(self, path):
        """Test on a video: prints the state as it changes (and every frame with --print)."""
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 24
        k = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            now = self.started + k / fps
            seen = self.gaze(frame, now)
            if self.update(seen, now) or self.show:
                detail = f"gaze {seen[0]:+5.1f} pitch {seen[1]:+5.1f}" if seen else "no face"
                print(f"{k / fps:5.2f}s {detail}  looking={self.looking} face={self.face}")
            k += 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="a video file to test on instead of the camera")
    parser.add_argument("--print", action="store_true", help="print every frame (with --source)")
    args = parser.parse_args()
    eyes = Eyes(show=args.print)
    if args.source:
        globals()["post"] = lambda payload: None  # a test sends nothing to the page
        eyes.run_file(args.source)
    else:
        eyes.run_camera()
