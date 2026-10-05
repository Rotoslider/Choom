#!/usr/bin/env python3
"""Grab what the Portrait is showing and rebuild individual views from the interleaved image.

A clean reconstruction proves the page is pixel-exact; comparing a left and a right view shows
the parallax a viewer gets. Usage:
    python3 tools/deinterleave.py OUT.jpg [view ...]      (default views: 6 24 41)
"""
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from PIL import Image, ImageGrab

CALIBRATION = Path(__file__).resolve().parents[1] / "calibration" / "LKG-PORT-07952_visual.json"
VIEWS = 48


def portrait_origin():
    out = subprocess.run(["xrandr", "--query"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if " connected" in line and "1536x2048+" in line:
            pos = line.split("1536x2048+")[1].split()[0]
            x, y = pos.split("+")
            return int(x), int(y)
    raise SystemExit("Portrait not found")


def view_index(cal, w, h):
    v = lambda k: cal[k]["value"]
    pitch = v("pitch") * v("screenW") / v("DPI") * math.cos(math.atan(1 / v("slope")))
    tilt = v("screenH") / (v("screenW") * v("slope"))
    subp = 1 / (v("screenW") * 3)
    ys, xs = np.mgrid[0:h, 0:w]
    u = (xs + 0.5) / w
    vv = 1 - (ys + 0.5) / h  # screen rows run top-down; shader uv.y runs bottom-up
    idx = []
    for c in range(3):
        z = (u + c * subp + vv * tilt) * pitch - v("center")
        z = z - np.floor(z)
        if v("invView"):
            z = 1 - z
        idx.append(z * VIEWS)
    return np.stack(idx, axis=-1)


def rebuild(img, idx, view):
    sel = np.abs(idx - (view + 0.5)) < 0.75
    vals = np.where(sel, img, 0.0)
    out = np.zeros_like(img)
    for c in range(3):
        s = sliding_window_view(np.pad(vals[..., c], 4), (9, 9)).sum(axis=(2, 3))
        n = sliding_window_view(np.pad(sel[..., c].astype(np.float32), 4), (9, 9)).sum(axis=(2, 3))
        out[..., c] = np.where(n > 0, s / np.maximum(n, 1e-6), 0)
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "deinterleaved.jpg"
    views = [int(a) for a in sys.argv[2:]] or [6, 24, 41]
    x, y = portrait_origin()
    grab = ImageGrab.grab(bbox=(x, y, x + 1536, y + 2048), xdisplay=":0").convert("RGB")
    img = np.asarray(grab).astype(np.float32) / 255
    idx = view_index(json.loads(CALIBRATION.read_text()), 1536, 2048)
    tiles = [Image.fromarray((np.clip(rebuild(img, idx, v), 0, 1) * 255).astype(np.uint8)).resize((384, 512))
             for v in views]
    sheet = Image.new("RGB", (384 * len(tiles) + 12 * (len(tiles) - 1), 512), (40, 40, 40))
    for i, t in enumerate(tiles):
        sheet.paste(t, (i * 396, 0))
    sheet.save(out_path, quality=88)
    print(f"views {views} -> {out_path}")


if __name__ == "__main__":
    main()
