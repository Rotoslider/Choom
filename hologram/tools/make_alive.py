#!/usr/bin/env python3
"""Turn a Choom's idle loop (a video of her on black, first frame = last frame) into a moving relief:
per-frame depth shaped like the still reliefs, her cut-out, and her mouth position for lip sync.

Writes portraits/<id>/alive_<clip>.mp4 per clip (three panels stacked: her color, her depth, her
cut-out) and alive.json (frame rate, size, focus, and per clip its per-frame mouth). Run with Forge
Neo's Python (Depth Anything V2 + MediaPipe), from the hologram folder, after make_alive_masks.py:
    ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive.py aloy MAIN.mp4 [MORE.mp4 ...]
Only new or changed clips are encoded. After the page has reloaded, `make_alive.py aloy --prune`
deletes the videos of clips no longer listed.
"""
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
import torch
from depth_anything_v2.dinov2_layers import attention
from depth_anything_v2.dpt import DepthAnythingV2
from mediapipe.tasks.python import BaseOptions, vision

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_depth import BG_LUMA, DETAIL, WEIGHTS, shape_depth  # noqa: E402
from make_landmarks import (CHIN, LEFT_CORNER, LOWER_INNER, LOWER_OUTER, MODEL, RIGHT_CORNER,  # noqa: E402
                            UPPER_INNER, UPPER_OUTER)

HOLOGRAM = Path(__file__).resolve().parents[1]


def fused_attention(self, x):
    """DINOv2 attention through PyTorch's fused kernel: without xFormers, Depth Anything builds the
    full attention matrix (7000 tokens per frame here), which is several times slower."""
    B, N, C = x.shape
    qkv = self.qkv(x).reshape(B, N, 3, self.num_heads, C // self.num_heads).permute(2, 0, 3, 1, 4)
    x = torch.nn.functional.scaled_dot_product_attention(qkv[0], qkv[1], qkv[2]).transpose(1, 2).reshape(B, N, C)
    return self.proj_drop(self.proj(x))


attention.Attention.forward = fused_attention


def circular_smooth(stack, weights=(0.25, 0.5, 0.25)):
    """Smooth along time with wrap-around, so the loop stays seamless. Adds shifted slices in place
    (np.roll copied the whole clip for every tap: 3 s each, over two minutes a clip)."""
    half = len(weights) // 2
    out = weights[half] * stack
    for k, w in enumerate(weights):
        shift = k - half  # out[t] += w * stack[t - shift], wrapping around
        if shift > 0:
            out[shift:] += w * stack[:-shift]
            out[:shift] += w * stack[-shift:]
        elif shift < 0:
            out[:shift] += w * stack[-shift:]
            out[shift:] += w * stack[:-shift]
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


# What each clip is for, from its name (<choom>_<action>.mp4): the moods it can play in (idle, talk,
# think, listen, greet) and the pose it starts and ends in. Facing the viewer with her mouth at rest
# suits talking; glances, breaths and laughs are for quiet moments; a transition moves between poses
# (Aloy lowering or raising her hand).
ROLES = {
    "base": (["idle", "talk", "think", "listen"], "main", "main"),
    "glance": (["idle"], "main", "main"),
    "glance2": (["idle"], "main", "main"),
    "breath": (["idle"], "main", "main"),
    "amused": (["idle"], "main", "main"),
    "beat": (["idle", "listen"], "main", "main"),
    "listen": (["listen", "talk"], "main", "main"),
    "bright": (["listen"], "main", "main"),
    "thinkup": (["think"], "main", "main"),
    "thinkdown": (["think"], "main", "main"),
    "lower": (["idle"], "main", "relaxed"),
    "raise": (["idle"], "relaxed", "main"),
    "relaxed": (["idle", "talk", "think", "listen"], "relaxed", "relaxed"),
    "relaxedlisten": (["listen", "talk"], "relaxed", "relaxed"),
    "relaxedamused": (["idle"], "relaxed", "relaxed"),
    "wave": (["greet"], "relaxed", "relaxed"),
    # Quiet-moment variety; the warm, facing-him ones also suit listening (and the long calm loop
    # suits talking too).
    "smile": (["idle", "listen"], "main", "main"),
    "hum": (["idle"], "main", "main"),
    "daydream": (["idle"], "main", "main"),
    "eyebrow": (["idle", "listen"], "main", "main"),
    "longcalm": (["idle", "talk", "listen"], "main", "main"),
    "orbwatch": (["idle"], "main", "main"),
    "scan": (["idle"], "main", "main"),
    "sway": (["idle"], "main", "main"),
    "smirk": (["idle", "listen"], "main", "main"),
    "tilt": (["idle", "listen"], "main", "main"),
    "relaxedhair": (["idle"], "relaxed", "relaxed"),
    "relaxedlongcalm": (["idle", "talk", "listen"], "relaxed", "relaxed"),
    "longcalm2": (["idle", "talk", "listen"], "main", "main"),
    "groove": (["idle"], "main", "main"),
    "heartglow": (["idle"], "main", "main"),
    "skycheck": (["idle"], "main", "main"),
    "giggle": (["idle"], "main", "main"),
    "relaxedgiggle": (["idle"], "relaxed", "relaxed"),
    "relaxedglance": (["idle"], "relaxed", "relaxed"),
    "fadeout": (["change"], "main", "main@plain"),              # Genesis's motes fade away (her plain look)
    "fadeout2": (["change"], "main", "main@plain"),
    "fadein": (["change"], "main@plain", "main"),               # ... and sparkle back on
    "fadein2": (["change"], "main@plain", "main"),
    "picturelook": (["picture"], "main", "main"),               # looking at a picture beside her face
    "relaxedpicturelook": (["picture"], "relaxed", "relaxed"),
    "picturedown": (["picturedown"], "main", "main"),           # ... at one floating lower right
    "relaxedpicturedown": (["picturedown"], "relaxed", "relaxed"),
    "relaxedhum": (["idle"], "relaxed", "relaxed"),
    "relaxedthinkup": (["think", "idle"], "relaxed", "relaxed"),
    "relaxedsmile": (["idle", "listen"], "relaxed", "relaxed"),
    # "Look at me" moves, played with a selfie she has just made.
    "relaxedtoss": (["pose"], "relaxed", "relaxed"),
    "relaxedturn": (["pose"], "relaxed", "relaxed"),
    "relaxedpoint": (["pose"], "relaxed", "relaxed"),
    "relaxedhips": (["pose"], "relaxed", "relaxed"),
    "poseheart": (["pose"], "main", "main"),
    "posewink": (["pose"], "main", "main"),
    "posetilt": (["pose"], "main", "main"),
    "poseshimmy": (["pose"], "main", "main"),
    "posesparkle": (["pose"], "main", "main"),
    "posehair": (["pose"], "main", "main"),
    "poseuncross": (["pose"], "main", "main"),
    "posesmirk": (["pose"], "main", "main"),
    # Full-body moves: another framing, so the page reaches them (and leaves them) with a camera cut.
    "fulltwirl": (["pose"], "full", "full"),
    "fullwave": (["pose"], "full", "full"),
    "fullpose": (["pose"], "full", "full"),
    "fullspin": (["pose"], "full", "full"),
    # Yawns, for late evening and early morning.
    "yawn": (["yawn"], "main", "main"),
    "relaxedyawn": (["yawn"], "relaxed", "relaxed"),
    # Expressions, played while she says something that feels that way.
    "happy": (["happy"], "main", "main"),
    "surprised": (["surprised"], "main", "main"),
    "sad": (["sad"], "main", "main"),
    "concerned": (["concerned"], "main", "main"),
    # Sleep: dozing off, sleeping, waking (Aloy sleeps with her hand down), and Genesis's wind.
    "fallasleep": (["sleep"], "main", "asleep"),
    "sleep": (["sleep"], "asleep", "asleep"),
    "sleep2": (["sleep"], "asleep", "asleep"),
    "wake": (["wake"], "asleep", "main"),
    "windy": (["windy"], "main", "main"),
    "windy2": (["windy"], "main", "main"),
}
AWAKE_POSE = {"aloy": "relaxed"}  # the pose a Choom falls asleep from and wakes into, if not "main"


# Clips named by kind rather than listed one by one: <kind>_<what she does>.
KINDS = {
    "idle": (["idle"], "main", "main"),           # a quiet moment in her picture's pose
    "listen": (["idle", "listen"], "main", "main"),
    "relaxed": (["idle"], "relaxed", "relaxed"),  # a quiet moment with her hand down (Aloy)
    "talk": (["talk", "listen", "idle"], "main", "main"),            # a calm loop to talk over (lip sync)
    "relaxedtalk": (["talk", "listen", "idle"], "relaxed", "relaxed"),
    "full": (["idle"], "full", "full"),           # the glass cuts to her whole figure for a moment
    "pose": (["pose"], "main", "main"),           # a "look at me" move for a selfie
    "oops": (["oops"], "main", "main"),           # a face at her own mishap (a tool failed)
    "relaxedoops": (["oops"], "relaxed", "relaxed"),
    "fullpose": (["pose"], "full", "full"),
}


def clip_role(cid, src):
    """(moods, pose it starts in, pose it ends in) from the clip's name, <choom>_[<outfit>-]<action>.
    Clips in other clothes (evening-relaxed, cold-relaxed_glance) live in poses of their own
    (relaxed@evening); the page changes her clothes with a camera cut."""
    action = Path(src).stem.removeprefix(f"{cid}_")
    outfit = None
    if "-" in action:
        outfit, action = action.split("-", 1)
    kind = action.split("_")[0] if "_" in action else None
    moods, start, end = ROLES.get(action) or KINDS.get(kind) or ROLES["base"]
    if action in ("fallasleep", "wake") and cid in AWAKE_POSE:
        start, end = [AWAKE_POSE[cid] if pose == "main" else pose for pose in (start, end)]
    if outfit:
        start, end = [f"{pose}@{outfit}" if pose in ("main", "relaxed") else pose for pose in (start, end)]
    return moods, start, end


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


BUILD = 3  # bump when the depth shaping or the video layout changes: every clip is then rebuilt


def particles(src):
    """Whether a clip is about her particles flying free (kept by brightness, not just her outline)."""
    return bool(re.search(r"motes|windy|sparkle", Path(src).stem))


def unpack(packed, i, w):
    """Frame i of a clip's cut-out, kept bit-packed (an eighth of the memory)."""
    return np.unpackbits(packed[i], axis=1, count=w).astype(bool)


def prune(cid):
    """make_alive.py <id> --prune: delete her clip videos alive.json no longer lists (run after the page
    has reloaded, so it never asks for a file that's gone)."""
    folder = HOLOGRAM / "portraits" / cid
    keep = {c["file"] for c in json.loads((folder / "alive.json").read_text())["clips"]}
    for f in folder.glob("alive_*.mp4"):
        if f.name not in keep:
            f.unlink()
            print("removed", f.name)


def main():
    """make_alive.py <id> CLIP [CLIP ...]: the first clip is her main idle; every clip must start and
    end on the same picture of her, so the page can play them in any order."""
    cid, sources = sys.argv[1], sys.argv[2:]
    if sources == ["--prune"]:
        return prune(cid)
    folder = HOLOGRAM / "portraits" / cid
    meta_file = folder / "alive.json"
    old = json.loads(meta_file.read_text()) if meta_file.exists() else {}
    built_before = {c["source"]: c for c in old.get("clips", []) if "built" in c}
    model = None

    def files(src):
        stem = Path(src).stem
        return folder / f"alive_masks_{stem}.npz", folder / f"alive_depth_{stem}.npy"

    def stamp(src):
        cut_file, depth_file = files(src)
        return [round(Path(src).stat().st_mtime), round(depth_file.stat().st_mtime) if depth_file.exists() else 0,
                round(cut_file.stat().st_mtime) if cut_file.exists() else 0]

    def prepare(src):
        """Her cut-out (bit-packed) and raw depth (read from disk as needed) for one clip; Depth
        Anything runs only if the clip is new or changed."""
        nonlocal model
        fps, frames = read_clip(src)
        h, w = frames[0].shape[:2]
        cut_file, depth_file = files(src)
        if cut_file.exists():
            masks = np.load(cut_file)["masks"].astype(np.float32)
            assert masks.shape == (len(frames), h, w), f"{cut_file.name} {masks.shape} vs frames {(len(frames), h, w)}"
        else:
            print(f"no {cut_file.name} (tools/make_alive_masks.py); falling back to a brightness cut-out")
            masks = np.stack([person_from_luma(f) for f in frames]).astype(np.float32)
        # U2-Net can lose most of her body for a stretch when something busy moves around her
        # (Genesis's hair and motes in the wind: only her head was left, her neck and shoulders went
        # black). Every clip starts on her reference picture, so anything lit inside that first
        # outline is her and goes back in.
        lit = np.stack([cv2.GaussianBlur(f.max(axis=2).astype(np.float32) / 255.0, (0, 0), 2.0) > BG_LUMA for f in frames])
        masks = np.maximum(masks, ((masks[0] > 0.5)[None] & lit).astype(np.float32))
        # U2-Net now and then bites into an edge for a frame or two (Aloy's sleeve); a vote over
        # seven frames keeps those dropouts from flickering.
        masks = circular_smooth(masks, (1 / 7,) * 7) > 0.5
        masks = circular_smooth(masks.astype(np.float32)) > 0.5
        # Clips about her particles (Genesis's motes drifting off her, the wind) keep everything lit
        # around her, frame by frame: on pure black the only lit things are her and her motes, and the
        # cut-out alone clipped away the motes that drift beyond her outline.
        if particles(src):
            masks |= lit
        del lit
        fresh = depth_file.exists() and depth_file.stat().st_mtime >= Path(src).stat().st_mtime
        raw = np.load(depth_file, mmap_mode="r") if fresh else None
        if raw is None or raw.shape != (len(frames), h, w):
            if model is None:
                model = DepthAnythingV2(encoder="vitl", features=256, out_channels=[256, 512, 1024, 1024])
                model.load_state_dict(torch.load(WEIGHTS, map_location="cpu"))
                model = model.to("cuda").eval()
            with torch.autocast("cuda", dtype=torch.float16):  # half precision: 6x faster with the fused attention
                np.save(depth_file, np.stack([model.infer_image(f, input_size=1022) for f in frames]).astype(np.float16))
            raw = np.load(depth_file, mmap_mode="r")
        return {"src": src, "fps": fps, "frames": len(frames), "w": w, "h": h, "packed": np.packbits(masks, axis=2),
                "raw": raw, "stamp": stamp(src)}, frames

    # Her main clip is always read: every other clip's depth is lined up with its first frame.
    main_clip, _ = prepare(sources[0])
    w, h = main_clip["w"], main_clip["h"]
    ref, ref_mask = main_clip["raw"][0].astype(np.float32), unpack(main_clip["packed"], 0, w)

    def line_up(c):
        """Depth Anything's scale drifts frame to frame: every frame is lined up with the main clip's
        first frame on the pixels that are her in both (a per-frame scale and offset), so changing
        clips never changes her depth. A full-body clip is framed differently: it lines up with its
        own first frame, and its depth range is mapped onto the main clip's."""
        c["own"] = clip_role(cid, c["src"])[1] == "full"
        c_ref, c_mask = (c["raw"][0].astype(np.float32), unpack(c["packed"], 0, w)) if c["own"] else (ref, ref_mask)
        c["fit"] = []
        for i in range(c["frames"]):
            sel = unpack(c["packed"], i, w) & c_mask
            c["fit"].append(np.polyfit(np.asarray(c["raw"][i])[sel].astype(np.float32), c_ref[sel], 1))
        c["map"] = (1.0, 0.0, 0.0)
        if c["own"]:
            ref_lo, ref_hi = np.percentile(ref[ref_mask], [2, 99.5])
            vals = np.concatenate([(a * np.asarray(c["raw"][i, ::2, ::2]).astype(np.float32) + b)[unpack(c["packed"], i, w)[::2, ::2]]
                                   for i, (a, b) in enumerate(c["fit"]) if i % 2 == 0])
            own_lo, own_hi = np.percentile(vals, [2, 99.5])
            c["map"] = ((ref_hi - ref_lo) / max(own_hi - own_lo, 1e-6), own_lo, ref_lo)

    def aligned(c, i):
        a, b = c["fit"][i]
        scale, own_lo, ref_lo = c["map"]
        d = a * np.asarray(c["raw"][i]).astype(np.float32) + b
        return (d - own_lo) * scale + ref_lo if c["own"] else d

    # Her depth range comes from her main clip and is kept between builds (alive.json "range"), so a
    # build that adds clips leaves every existing clip's video as it was, and doesn't even read them.
    line_up(main_clip)
    main_stamp = main_clip["stamp"]
    if old.get("range") and old.get("rangeFrom") == [Path(sources[0]).name, main_stamp, BUILD]:
        lo, hi = old["range"]
    else:
        vals = np.concatenate([aligned(main_clip, i)[::2, ::2][unpack(main_clip["packed"], i, w)[::2, ::2]]
                               for i in range(0, main_clip["frames"], 2)])
        lo, hi = (float(v) for v in np.percentile(vals, [2, 99.5]))
        del vals
    face = np.zeros((h, w), bool)
    face[int(h * 0.12):int(h * 0.42), int(w * 0.32):int(w * 0.68)] = True
    ref_depth = np.clip((ref - lo) / max(hi - lo, 1e-6), 0, 1)
    focus = float(np.median(ref_depth[face & ref_mask]))  # fixed, so the depth doesn't pump

    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(MODEL)), num_faces=1))
    gray = lambda a: cv2.cvtColor(np.round(np.clip(a, 0, 1) * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    meta_clips, encoded = [], 0
    for k, src in enumerate(sources):
        name = Path(src).name
        out = folder / f"alive_{Path(src).stem}.mp4"
        moods, start, end = clip_role(cid, src)
        before = built_before.get(name)
        expect = [BUILD, round(lo, 6), round(hi, 6), round(focus, 6), stamp(src), main_stamp] + (["lit"] if particles(src) else [])
        if before and before.get("built") == expect and out.exists():
            # Unchanged since it was last built: keep the video and its mouth track (its role may change).
            meta_clips.append({**before, "file": out.name, "moods": moods, "from": start, "to": end, "talk": "talk" in moods})
            continue
        if k == 0:
            c, frames = main_clip, read_clip(src)[1]
        else:
            c, frames = prepare(src)
            line_up(c)
        depth = circular_smooth(np.stack([np.clip((aligned(c, i) - lo) / max(hi - lo, 1e-6), 0, 1)
                                          for i in range(c["frames"])]).astype(np.float32))
        part = out.with_suffix(".part")  # swapped in when done, so a running page never reads half a file
        enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h * 3}",
                                "-r", f"{c['fps']:g}", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "14",
                                "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", str(part)],
                               stdin=subprocess.PIPE)
        for i, bgr in enumerate(frames):
            d = cv2.bilateralFilter(depth[i], 9, 0.04, 5)
            person = drop_rim(d, unpack(c["packed"], i, w))
            d = extend_edges(shape_depth(d, person, focus, DETAIL), person)
            cut = cv2.GaussianBlur(person.astype(np.float32), (0, 0), 1.2)
            enc.stdin.write(np.vstack([bgr, gray(d), gray(cut)]).tobytes())
        enc.stdin.close()
        assert enc.wait() == 0, f"ffmpeg failed on {out.name}"
        part.replace(out)
        # Full-body clips play without lip sync (her face is too small to track, or turned away mid-twirl).
        mouths, found = (np.zeros((0, 8)), 0) if start == "full" else mouth_track(landmarker, frames)
        del frames, depth
        meta_clips.append({"file": out.name, "frames": c["frames"], "source": name,
                           "moods": moods, "from": start, "to": end, "talk": "talk" in moods,
                           "built": [BUILD, round(lo, 6), round(hi, 6), round(focus, 6), c["stamp"], main_stamp] + (["lit"] if particles(src) else []),
                           "mouth": [[round(v, 5) for v in m] for m in mouths.tolist()]})
        encoded += 1
        print(f"  wrote {out.name} ({out.stat().st_size / 1e6:.1f} MB), face found in {found}/{c['frames']} frames")
    del model
    torch.cuda.empty_cache()

    meta = {"fps": main_clip["fps"], "texSize": [w, h], "focus": round(focus, 4), "range": [lo, hi],
            "rangeFrom": [Path(sources[0]).name, main_stamp, BUILD], "panels": ["color", "depth", "cut"],
            "mouthFields": ["u", "v", "halfWidth", "halfHeight", "chin", "tilt", "halfGap", "lift"], "clips": meta_clips}
    part = meta_file.with_suffix(".part")
    part.write_text(json.dumps(meta))
    part.replace(meta_file)
    print(f"wrote alive.json: {len(meta_clips)} clips ({encoded} encoded), focus {focus:.3f}")


if __name__ == "__main__":
    main()
