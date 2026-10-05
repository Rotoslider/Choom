#!/usr/bin/env python3
"""Find each Choom's mouth for lip sync: lip corners, inner lip line, lip height, chin and head
tilt, from MediaPipe's face landmarker. Writes portraits/<id>/mouth.json (texture UV, v up) and a
check image per portrait.

Run with Forge Neo's Python (it has mediapipe); the landmarker model is downloaded once:
    ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_landmarks.py
"""
import json
import math
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

HOLOGRAM = Path(__file__).resolve().parents[1]
PORTRAITS = HOLOGRAM / "portraits"
MODEL = Path.home() / ".cache" / "mediapipe" / "face_landmarker.task"
MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/face_landmarker/"
             "face_landmarker/float16/1/face_landmarker.task")

# MediaPipe face-mesh indices
LEFT_CORNER, RIGHT_CORNER = 61, 291
UPPER_OUTER, UPPER_INNER, LOWER_INNER, LOWER_OUTER = 0, 13, 14, 17
CHIN = 152


def main():
    if not MODEL.exists():
        MODEL.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, MODEL)
    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(MODEL)), num_faces=1))

    for entry in json.loads((PORTRAITS / "manifest.json").read_text()):
        folder = PORTRAITS / entry["id"]
        bgr = cv2.imread(str(folder / "color.jpg"))
        h, w = bgr.shape[:2]
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        found = landmarker.detect(image).face_landmarks
        if not found:
            print(f"{entry['name']:8s} no face found; lip sync off")
            (folder / "mouth.json").unlink(missing_ok=True)
            continue
        lm = found[0]
        px = lambda i: (lm[i].x * w, lm[i].y * h)  # image pixels, y down
        (lx, ly), (rx, ry) = px(LEFT_CORNER), px(RIGHT_CORNER)
        (ux, uy), (dx, dy) = px(UPPER_INNER), px(LOWER_INNER)
        cx, cy = (ux + dx) / 2, (uy + dy) / 2          # middle of the lip line
        half_width = math.dist((lx, ly), (rx, ry)) / 2
        half_height = math.dist(px(UPPER_OUTER), px(LOWER_OUTER)) / 2
        chin = math.dist((cx, cy), px(CHIN))
        tilt = -math.atan2(ry - ly, rx - lx)           # radians, in the v-up texture frame
        mouth = {
            "center": [round(cx / w, 5), round(1 - cy / h, 5)],
            "halfWidth": round(half_width, 2),          # texture pixels
            "halfHeight": round(half_height, 2),
            "chin": round(chin, 2),
            "tilt": round(tilt, 4),
            "texSize": [w, h],
        }
        (folder / "mouth.json").write_text(json.dumps(mouth, indent=2))

        check = bgr.copy()
        for i in (LEFT_CORNER, RIGHT_CORNER, UPPER_OUTER, UPPER_INNER, LOWER_INNER, LOWER_OUTER, CHIN):
            cv2.circle(check, tuple(int(v) for v in px(i)), 5, (255, 0, 255), -1)
        cv2.ellipse(check, (int(cx), int(cy)), (int(half_width), int(half_height)),
                    math.degrees(-tilt), 0, 360, (0, 255, 0), 2)
        cv2.imwrite(str(folder / "mouth_check.jpg"), check[int(cy - 3 * chin):int(cy + 2 * chin),
                                                            int(cx - 3 * half_width):int(cx + 3 * half_width)])
        print(f"{entry['name']:8s} mouth at ({cx:.0f},{cy:.0f}) half-width {half_width:.0f}px "
              f"lips {2 * half_height:.0f}px chin {chin:.0f}px tilt {math.degrees(tilt):.1f} deg")


if __name__ == "__main__":
    main()
