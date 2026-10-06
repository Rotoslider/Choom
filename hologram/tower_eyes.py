#!/usr/bin/env python3
"""The tower's eyes: is Donny looking at the glass?

Watches the camera mounted at the Portrait's top edge and tells the page when he looks at the glass
and when he looks away, so the Choom on it can turn to him. Uses MediaPipe's face landmarker: his
head's turn (from the face's transformation matrix) plus where his irises sit in his eyes gives one
gaze direction. Looking at the glass means within YAW_LIMIT of straight on, and his head's tilt near
his usual one (learned while he faces the camera, so it fits however the camera is mounted). Frames
are processed in memory and never kept; only "looking" / "not looking" changes are sent and logged.

Finds a USB camera by name (a Logitech Brio first) and waits quietly until one is plugged in.
Run with the hologram's venv (launch.sh starts it):  .venv-ears/bin/python tower_eyes.py
Test on a video file:  .venv-ears/bin/python tower_eyes.py --source clip.mp4 --print
"""
import argparse
import json
import math
import os
import time
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

HOLOGRAM_URL = os.environ.get("HOLOGRAM_URL", "http://127.0.0.1:8765")
MODEL = Path.home() / ".cache" / "mediapipe" / "face_landmarker.task"
FPS = 12                  # frames looked at per second
YAW_LIMIT = 15.0          # degrees either side of straight on that still count as looking at her
PITCH_LIMIT = 18.0        # degrees from his usual head tilt
EYE_DEGREES = 50.0        # how far a fully turned iris (offset 1) turns his gaze
LOOK_AFTER = 0.5          # seconds of looking before it counts
AWAY_AFTER = 1.5          # seconds of looking away before it counts
FACE_GONE_AFTER = 3.0     # seconds without a face before he's gone from the tower


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

    def gaze(self, frame, now):
        """(gaze yaw, head pitch) of the face in this frame, or None."""
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = self.landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb),
                                                  int((now - self.started) * 1000))
        if not result.face_landmarks:
            return None
        yaw, pitch = head_angles(result.facial_transformation_matrixes[0])
        points = [(p.x, p.y) for p in result.face_landmarks[0]]
        return yaw + EYE_DEGREES * iris_offset(points), pitch

    def update(self, seen, now):
        """Debounced state from this frame; tells the page when it changes."""
        changed = False
        if seen is None:
            if self.face and now - (self.since["face"] or now) > FACE_GONE_AFTER:
                self.face, self.looking, changed = False, False, True
        else:
            self.since["face"] = now
            if not self.face:
                self.face, changed = True, True
            gaze_yaw, pitch = seen
            facing = abs(gaze_yaw) < YAW_LIMIT
            if facing:  # learn his usual tilt while he faces the camera
                self.pitch_usual = pitch if self.pitch_usual is None else self.pitch_usual + (pitch - self.pitch_usual) * 0.02
            at_glass = facing and abs(pitch - (self.pitch_usual or pitch)) < PITCH_LIMIT
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
        while True:
            camera = find_camera()
            if camera is None:
                time.sleep(30)  # plugged in later: picked up on its own
                continue
            index, name = camera
            cap = cv2.VideoCapture(index, cv2.CAP_V4L2)
            if not cap.isOpened():
                time.sleep(30)
                continue
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
            post({"camera": name})
            last = 0.0
            while cap.isOpened():
                ok, frame = cap.read()
                if not ok:
                    break
                now = time.monotonic()
                if now - last < 1 / FPS:
                    continue
                last = now
                self.update(self.gaze(frame, now), now)
            cap.release()
            post({"camera": None})
            time.sleep(5)

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
