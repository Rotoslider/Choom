#!/usr/bin/env python3
"""Turn a Choom's idle loop (a video of her on black, first frame = last frame) into a moving relief:
per-frame depth shaped like the still reliefs, her cut-out, and her mouth position for lip sync.

Writes portraits/<id>/alive_<k>.mp4 per clip (three panels stacked: her color, her depth, her
cut-out) and alive.json (frame rate, size, focus, and per clip its per-frame mouth). Run with Forge
Neo's Python (Depth Anything V2 + MediaPipe), from the hologram folder, after make_alive_masks.py:
    ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive.py aloy MAIN.mp4 [MORE.mp4 ...]
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


def read_clip(src):
    """Frames of one clip, cropped to the panel's 3:4."""
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    h, w = frames[0].shape[:2]
    cw = min(w, int(round(h * 0.75 / 2)) * 2)
    x0 = (w - cw) // 2
    return fps, [f[:, x0:x0 + cw] for f in frames]


def mouth_track(landmarker, frames):
    """Her mouth on every frame (texture UV, v up, and texture pixels), gaps filled and lightly smoothed."""
    h, w = frames[0].shape[:2]
    mouths = []
    for bgr in frames:
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
    n = len(mouths)
    known = [i for i, m in enumerate(mouths) if m is not None]
    if not known:
        raise SystemExit("no face found in any frame")
    for i in range(n):
        if mouths[i] is None:
            mouths[i] = mouths[min(known, key=lambda k: min(abs(k - i), n - abs(k - i)))]
    smooth = circular_smooth(np.array(mouths, np.float64), (0.25, 0.5, 0.25))  # light: it must keep up
    return smooth, len(known)


def main():
    """make_alive.py <id> CLIP [CLIP ...]: the first clip is her main idle; every clip must start and
    end on the same picture of her, so the page can play them in any order."""
    cid, sources = sys.argv[1], sys.argv[2:]
    folder = HOLOGRAM / "portraits" / cid
    clips = []
    for k, src in enumerate(sources):
        fps, frames = read_clip(src)
        h, w = frames[0].shape[:2]
        cut_file = folder / f"alive_masks_{k}.npz"
        if cut_file.exists():
            masks = np.load(cut_file)["masks"].astype(np.float32)
            assert masks.shape == (len(frames), h, w), f"{cut_file.name} {masks.shape} vs frames {(len(frames), h, w)}"
        else:
            print(f"no {cut_file.name} (tools/make_alive_masks.py); falling back to a brightness cut-out")
            masks = np.stack([person_from_luma(f) for f in frames])
        # U2-Net now and then bites into an edge for a frame or two (Aloy's sleeve); a vote over
        # seven frames keeps those dropouts from flickering.
        masks = circular_smooth(masks, (1 / 7,) * 7) > 0.5
        masks = circular_smooth(masks.astype(np.float32)) > 0.5
        clips.append({"src": src, "fps": fps, "frames": frames, "masks": masks})
        print(f"{cid} clip {k}: {len(frames)} frames {w}x{h} at {fps:g} fps ({Path(src).name})")

    model = DepthAnythingV2(encoder="vitl", features=256, out_channels=[256, 512, 1024, 1024])
    model.load_state_dict(torch.load(WEIGHTS, map_location="cpu"))
    model = model.to("cuda").eval()
    for c in clips:
        c["raw"] = np.stack([model.infer_image(f, input_size=1022) for f in c["frames"]]).astype(np.float32)
    del model
    torch.cuda.empty_cache()

    # Depth Anything's scale drifts frame to frame: line every frame of every clip up with the main
    # clip's first frame on the pixels that are her in both, then normalize them all together, so
    # changing clips never changes her depth.
    ref, ref_mask = clips[0]["raw"][0], clips[0]["masks"][0]
    for c in clips:
        for i in range(len(c["raw"])):
            sel = c["masks"][i] & ref_mask
            a, b = np.polyfit(c["raw"][i][sel], ref[sel], 1)
            c["raw"][i] = a * c["raw"][i] + b
    allv = np.concatenate([c["raw"][c["masks"]] for c in clips])
    lo, hi = np.percentile(allv, [2, 99.5])
    del allv
    h, w = clips[0]["frames"][0].shape[:2]
    face = np.zeros((h, w), bool)
    face[int(h * 0.12):int(h * 0.42), int(w * 0.32):int(w * 0.68)] = True
    ref_depth = np.clip((ref - lo) / max(hi - lo, 1e-6), 0, 1)
    focus = float(np.median(ref_depth[face & ref_mask]))  # fixed, so the depth doesn't pump

    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(MODEL)), num_faces=1))
    gray = lambda a: cv2.cvtColor(np.round(np.clip(a, 0, 1) * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    meta_clips = []
    for k, c in enumerate(clips):
        depth = circular_smooth(np.clip((c["raw"] - lo) / max(hi - lo, 1e-6), 0, 1))
        out = folder / f"alive_{k}.mp4"
        enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h * 3}",
                                "-r", f"{c['fps']:g}", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "14",
                                "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
        for i, bgr in enumerate(c["frames"]):
            d = cv2.bilateralFilter(depth[i].astype(np.float32), 9, 0.04, 5)
            person = drop_rim(d, c["masks"][i])
            d = extend_edges(shape_depth(d, person, focus, DETAIL), person)
            cut = cv2.GaussianBlur(person.astype(np.float32), (0, 0), 1.2)
            enc.stdin.write(np.vstack([bgr, gray(d), gray(cut)]).tobytes())
        enc.stdin.close()
        enc.wait()
        mouths, found = mouth_track(landmarker, c["frames"])
        # Calm clips (eyes open, mouth at rest) can play while she talks; a laugh or a long
        # eyes-closed breath is for quiet moments only. Named <choom>_<action>.mp4.
        calm = not any(k in Path(c["src"]).stem for k in ("breath", "amused"))
        meta_clips.append({"file": out.name, "frames": len(c["frames"]), "source": Path(c["src"]).name, "talk": calm,
                           "mouth": [[round(v, 5) for v in m] for m in mouths.tolist()]})
        print(f"  wrote {out.name} ({out.stat().st_size / 1e6:.1f} MB), face found in {found}/{len(c['frames'])} frames")

    meta = {"fps": clips[0]["fps"], "texSize": [w, h], "focus": round(focus, 4), "panels": ["color", "depth", "cut"],
            "mouthFields": ["u", "v", "halfWidth", "halfHeight", "chin", "tilt", "halfGap", "lift"], "clips": meta_clips}
    (folder / "alive.json").write_text(json.dumps(meta))
    print(f"wrote alive.json: {len(meta_clips)} clips, focus {focus:.3f}")


if __name__ == "__main__":
    main()
