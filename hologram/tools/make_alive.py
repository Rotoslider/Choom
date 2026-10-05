#!/usr/bin/env python3
"""Turn a Choom's idle loop (a video of her on black, first frame = last frame) into a moving relief:
per-frame depth shaped like the still reliefs, her cut-out, and her mouth position for lip sync.

Writes portraits/<id>/alive.mp4 (three panels stacked: her color, her depth, her cut-out) and
alive.json (frame rate, size, focus, per-frame mouth). Run with Forge Neo's Python (Depth Anything
V2 + MediaPipe), from the hologram folder, after tools/make_alive_masks.py:
    ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive.py aloy LOOP.mp4
"""
import json
import math
import subprocess
import sys
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
import torch
from depth_anything_v2.dpt import DepthAnythingV2
from mediapipe.tasks.python import BaseOptions, vision

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_depth import BG_LUMA, DETAIL, WEIGHTS, shape_depth  # noqa: E402
from make_landmarks import (CHIN, LEFT_CORNER, LOWER_INNER, LOWER_OUTER, MODEL, RIGHT_CORNER,  # noqa: E402
                            UPPER_INNER, UPPER_OUTER)

HOLOGRAM = Path(__file__).resolve().parents[1]


def circular_smooth(stack, weights=(0.25, 0.5, 0.25)):
    """Smooth along time with wrap-around, so the loop stays seamless."""
    out = np.zeros_like(stack)
    half = len(weights) // 2
    for k, w in enumerate(weights):
        out += w * np.roll(stack, k - half, axis=0)
    return out


def extend_edges(d, person):
    """Carry her edge depth outward into the empty glass, so her silhouette is no depth cliff for
    the mesh to stretch across; the cut-out panel trims her outline instead."""
    _, labels = cv2.distanceTransformWithLabels((~person).astype(np.uint8), cv2.DIST_L2, 5,
                                                labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(person)
    lut = np.zeros(labels.max() + 1, np.float32)
    lut[labels[ys, xs]] = d[ys, xs]
    out = np.where(person, d, lut[labels])
    return np.where(person, d, cv2.GaussianBlur(out, (0, 0), 6)).astype(np.float32)


def drop_rim(d, person, jump=0.2, reach=6):
    """Remove thin fringes of far-back pixels hugging a nearer edge (rim glow, stray background):
    left in, the mesh would stretch from the edge down to them."""
    k = np.ones((2 * reach + 1, 2 * reach + 1), np.uint8)
    near_edge = cv2.dilate((~person).astype(np.uint8), k) > 0
    local_near = cv2.dilate(np.where(person, d, 0).astype(np.float32), k)
    return person & ~(near_edge & (local_near - d > jump))


def person_from_luma(bgr):
    """She's the one lit thing on black: threshold, keep the biggest piece, fill holes."""
    luma = cv2.GaussianBlur(bgr.max(axis=2).astype(np.float32) / 255.0, (0, 0), 2.0)
    lit = cv2.morphologyEx((luma > BG_LUMA).astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(lit, connectivity=8)
    if count <= 1:
        return lit.astype(np.float32)
    person = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    filled = person.copy()
    h, w = person.shape
    cv2.floodFill(filled, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 1)
    return (person | (1 - filled)).astype(np.float32)


def main():
    cid, src = sys.argv[1], sys.argv[2]
    folder = HOLOGRAM / "portraits" / cid
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    h, w = frames[0].shape[:2]
    # Crop to the panel's 3:4.
    cw = min(w, int(round(h * 0.75 / 2)) * 2)
    x0 = (w - cw) // 2
    frames = [f[:, x0:x0 + cw] for f in frames]
    w = cw
    n = len(frames)
    print(f"{cid}: {n} frames {w}x{h} at {fps:g} fps")

    model = DepthAnythingV2(encoder="vitl", features=256, out_channels=[256, 512, 1024, 1024])
    model.load_state_dict(torch.load(WEIGHTS, map_location="cpu"))
    model = model.to("cuda").eval()

    cut_file = folder / "alive_masks.npz"
    if cut_file.exists():
        masks = np.load(cut_file)["masks"].astype(np.float32)
        assert masks.shape == (n, h, w), f"masks {masks.shape} don't match frames {(n, h, w)}"
    else:
        print("no alive_masks.npz (tools/make_alive_masks.py); falling back to a brightness cut-out")
        masks = np.stack([person_from_luma(f) for f in frames])
    # U2-Net now and then bites into an edge for a frame or two (Aloy's sleeve); a vote over seven
    # frames keeps those dropouts from flickering.
    masks = circular_smooth(masks, (1 / 7,) * 7) > 0.5
    masks = circular_smooth(masks.astype(np.float32)) > 0.5
    raws = np.stack([model.infer_image(f, input_size=1022) for f in frames]).astype(np.float32)

    # Depth Anything's scale drifts frame to frame: line every frame up with the first one on the
    # pixels that are her in both, then normalize them all together.
    ref = raws[0]
    for i in range(n):
        sel = masks[i] & masks[0]
        a, b = np.polyfit(raws[i][sel], ref[sel], 1)
        raws[i] = a * raws[i] + b
    lo, hi = np.percentile(raws[masks], [2, 99.5])
    depth = np.clip((raws - lo) / max(hi - lo, 1e-6), 0, 1)
    depth = circular_smooth(depth)

    # Focus on her face in the first frame, and keep it fixed so the depth doesn't pump.
    face = np.zeros((h, w), bool)
    face[int(h * 0.12):int(h * 0.42), int(w * 0.32):int(w * 0.68)] = True
    focus = float(np.median(depth[0][face & masks[0]]))

    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(MODEL)), num_faces=1))
    mouths = []
    packed = []
    for i, bgr in enumerate(frames):
        d = cv2.bilateralFilter(depth[i].astype(np.float32), 9, 0.04, 5)
        person = drop_rim(d, masks[i])
        d = extend_edges(shape_depth(d, person, focus, DETAIL), person)
        cut = cv2.GaussianBlur(person.astype(np.float32), (0, 0), 1.2)
        gray = lambda a: cv2.cvtColor(np.round(np.clip(a, 0, 1) * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
        packed.append(np.vstack([bgr, gray(d), gray(cut)]))

        found = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                           data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))).face_landmarks
        if not found:
            mouths.append(None)
            continue
        lm = found[0]
        px = lambda k: (lm[k].x * w, lm[k].y * h)
        (lx, ly), (rx, ry) = px(LEFT_CORNER), px(RIGHT_CORNER)
        (ux, uy), (dx, dy) = px(UPPER_INNER), px(LOWER_INNER)
        cx, cy = (ux + dx) / 2, (uy + dy) / 2
        mouths.append([cx / w, 1 - cy / h, math.dist((lx, ly), (rx, ry)) / 2,
                       math.dist(px(UPPER_OUTER), px(LOWER_OUTER)) / 2, math.dist((cx, cy), px(CHIN)),
                       -math.atan2(ry - ly, rx - lx),
                       math.dist((ux, uy), (dx, dy)) / 2,   # half the gap her lips already have
                       cy - (ly + ry) / 2])                 # how far her mouth corners curve up (a smile)

    # Fill frames where the face wasn't found from their neighbours, then smooth the jitter out.
    known = [i for i, m in enumerate(mouths) if m is not None]
    if not known:
        raise SystemExit("no face found in any frame")
    for i in range(n):
        if mouths[i] is None:
            mouths[i] = mouths[min(known, key=lambda k: min(abs(k - i), n - abs(k - i)))]
    mouths = circular_smooth(np.array(mouths, np.float64), (0.25, 0.5, 0.25))  # light: it must keep up with her head

    out = folder / "alive.mp4"
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h * 3}",
                            "-r", f"{fps:g}", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "14",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
    for f in packed:
        enc.stdin.write(f.tobytes())
    enc.stdin.close()
    enc.wait()

    meta = {"fps": fps, "frames": n, "texSize": [w, h], "focus": round(focus, 4), "panels": ["color", "depth", "cut"],
            "mouth": [[round(v, 5) for v in m] for m in mouths.tolist()],
            "mouthFields": ["u", "v", "halfWidth", "halfHeight", "chin", "tilt", "halfGap", "lift"]}
    (folder / "alive.json").write_text(json.dumps(meta))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB) and alive.json; focus {focus:.3f}, "
          f"face found in {len(known)}/{n} frames")


if __name__ == "__main__":
    main()
