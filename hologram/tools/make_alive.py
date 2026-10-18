#!/usr/bin/env python3
"""Turn a Choom's idle loop (a video of her on black, first frame = last frame) into a moving relief:
per-frame depth shaped like the still reliefs, her cut-out, and her mouth position for lip sync.

Writes portraits/<id>/alive_<clip>.mp4 per clip (three panels stacked: her color, her depth, her
cut-out) and alive.json (frame rate, size, focus, and per clip its per-frame mouth). Run with Forge
Neo's Python (Depth Anything V2 + MediaPipe), from the hologram folder, after make_alive_masks.py:
    ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive.py aloy MAIN.mp4 [MORE.mp4 ...]
Only new or changed clips are encoded; a changed clip gets a new file name (alive_<clip>_v2.mp4), so
a page still running on the old alive.json never plays a new video with an old mouth track. After the
page has reloaded, `make_alive.py aloy --prune [--keep-file KEEP]` deletes the videos alive.json no
longer lists and, with a keep file (one clip name per line), the cut-out and depth caches of clips not
in it. `--home relaxed` names her home pose (tools/clip_roles.py); HOLOGRAM_PORTRAITS moves the
portraits folder (a test Studio's).
"""
import json
import math
import os
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
from clip_roles import POSES, clip_role, home_pose  # noqa: E402
from make_landmarks import (CHIN, LEFT_CORNER, LOWER_INNER, LOWER_OUTER, MODEL, RIGHT_CORNER,  # noqa: E402
                            UPPER_INNER, UPPER_OUTER)

HOLOGRAM = Path(__file__).resolve().parents[1]
PORTRAITS = Path(os.environ.get("HOLOGRAM_PORTRAITS") or HOLOGRAM / "portraits")


def save_npy(path, array):
    """np.save, written whole and swapped in: a build stopped halfway never leaves a cut-short cache
    that looks newer than its clip (every later build would fail on it)."""
    part = path.with_name(path.name + ".part")
    with open(part, "wb") as f:
        np.save(f, array)
    os.replace(part, path)


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


def mouth_at(landmarker, bgr, box=None):
    """Her mouth in one frame (texture UV, v up, and texture pixels), or None if no face is found. box:
    (x0, y0, size) of a square to look in, for a face too small to find in the whole frame."""
    h, w = bgr.shape[:2]
    x0, y0, cw, ch = (box[0], box[1], box[2], box[2]) if box else (0, 0, w, h)
    found = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                       data=np.ascontiguousarray(cv2.cvtColor(bgr[y0:y0 + ch, x0:x0 + cw], cv2.COLOR_BGR2RGB)))).face_landmarks
    if not found:
        return None
    lm = found[0]
    px = lambda k: (x0 + lm[k].x * cw, y0 + lm[k].y * ch)
    (lx, ly), (rx, ry) = px(LEFT_CORNER), px(RIGHT_CORNER)
    (ux, uy), (dx, dy) = px(UPPER_INNER), px(LOWER_INNER)
    cx, cy = (ux + dx) / 2, (uy + dy) / 2
    return [cx / w, 1 - cy / h, math.dist((lx, ly), (rx, ry)) / 2,
            math.dist(px(UPPER_OUTER), px(LOWER_OUTER)) / 2, math.dist((cx, cy), px(CHIN)),
            -math.atan2(ry - ly, rx - lx),
            math.dist((ux, uy), (dx, dy)) / 2,   # half the gap her lips already have
            cy - (ly + ry) / 2]                  # how far her mouth corners curve up (a smile)


def face_box(landmarker, bgr):
    """A square around her face where the landmarker finds it, for a wide shot whose face it misses in
    the whole frame (Genesis by her campfire): squares half the frame wide, over its top two thirds."""
    h, w = bgr.shape[:2]
    size = w // 2
    for y0 in range(0, int(h * 0.67) - size // 2, size // 4):
        for x0 in range(0, w - size + 1, size // 4):
            if mouth_at(landmarker, bgr, (x0, y0, size)):
                return x0, y0, size
    return None


def mouth_track(landmarker, frames, required=True):
    """Her mouth on every frame (texture UV, v up, and texture pixels), gaps filled and lightly smoothed.
    Not required (a wide shot at a place, her face small): it looks again in a square around her face
    found in the first frame, and no face there either means no lip sync."""
    mouths = [mouth_at(landmarker, bgr) for bgr in frames]
    if not required and not any(mouths):
        box = face_box(landmarker, frames[0])
        mouths = [mouth_at(landmarker, bgr, box) for bgr in frames] if box else mouths
    n = len(mouths)
    known = [i for i, m in enumerate(mouths) if m is not None]
    if not known:
        if not required:
            return np.zeros((0, 8)), 0
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


def wide(pose):
    """Framed wider than her waist-up pictures: her full body, a place (sitting by her campfire), or
    the empty glass she walks off into."""
    return pose.split("@")[0] not in ("main", "relaxed", "asleep")


def at_place(start, end):
    """A clip at one of her places or on the way there (to_campfire): everything lit is kept, the fire
    she sits by too, which isn't her outline."""
    return any(pose.split("@")[0] not in POSES for pose in (start, end))


def joined(src):
    """Whether a clip is in an outfit (its name has an outfit prefix: evening-relaxed)."""
    return "-" in Path(src).stem.split("_", 1)[-1]


def unpack(packed, i, w):
    """Frame i of a clip's cut-out, kept bit-packed (an eighth of the memory)."""
    return np.unpackbits(packed[i], axis=1, count=w).astype(bool)


def prune(cid, keep_file=None):
    """make_alive.py <id> --prune [--keep-file KEEP]: delete her clip videos alive.json no longer lists
    (run after the page has reloaded, so it never asks for a file that's gone). With a keep file (the
    clips she still has, one name per line), also the cut-out and depth caches of clips not in it or
    on the glass; without one, caches stay."""
    folder = PORTRAITS / cid
    clips = json.loads((folder / "alive.json").read_text())["clips"]
    keep = {c["file"] for c in clips}
    freed = 0
    for f in folder.glob("alive_*.mp4"):
        if f.name not in keep:
            freed += f.stat().st_size
            f.unlink()
            print("removed", f.name)
    if keep_file:
        mine = {l.strip() for l in Path(keep_file).read_text().splitlines() if l.strip()}
        mine |= {Path(c["source"]).stem for c in clips}
        for pattern, prefix in (("alive_masks_*.npz", "alive_masks_"), ("alive_depth_*.npy", "alive_depth_")):
            for f in folder.glob(pattern):
                if f.stem.removeprefix(prefix) not in mine:
                    freed += f.stat().st_size
                    f.unlink()
                    print("removed cache", f.name)
        for f in folder.glob("*.part"):  # left by a build that was stopped
            f.unlink()
    print(f"prune {cid}: {freed / 1e9:.1f} GB freed")


def main():
    """make_alive.py <id> CLIP [CLIP ...]: the first clip is her main idle; every clip must start and
    end on the same picture of her, so the page can play them in any order."""
    cid, sources = sys.argv[1], sys.argv[2:]
    home = None
    if "--home" in sources:
        i = sources.index("--home")
        home = sources[i + 1]
        del sources[i:i + 2]
    if sources[:1] == ["--prune"]:
        return prune(cid, sources[2] if sources[1:2] == ["--keep-file"] else None)
    folder = PORTRAITS / cid
    meta_file = folder / "alive.json"
    old = json.loads(meta_file.read_text()) if meta_file.exists() else {}
    home = home or old.get("home") or home_pose(cid)  # given, the last build's, or her Studio project's
    role = lambda src: clip_role(cid, src, home)
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
        # cut-out alone clipped away the motes that drift beyond her outline. So do clips at a place.
        _, start, end = role(src)
        if particles(src) or at_place(start, end):
            masks |= lit
        # On and off the empty glass: only what's lit can be her, so an empty frame stays empty (U2-Net
        # finds something in a black frame), and all that's lit is her: the motes she scatters into or
        # gathers from were mostly cut away (Genesis's appear, 2026-10-18).
        if "gone" in (start, end):
            masks &= np.stack([cv2.dilate(f.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0 for f in lit])
            masks |= lit
        # Outfit clips: anything lit that touches her outline is her (or her clothes). U2-Net took the
        # dark knit of Genesis's sweater, where it runs off the bottom-left of the frame, for background
        # in whole stretches of a clip, the first frame included, so the outline rule couldn't help.
        if joined(src):
            for i in range(len(masks)):
                count, labels = cv2.connectedComponents(lit[i].astype(np.uint8), connectivity=8)
                touching = np.unique(labels[masks[i] & lit[i]])
                masks[i] |= np.isin(labels, touching[touching > 0])
        del lit
        fresh = depth_file.exists() and depth_file.stat().st_mtime >= Path(src).stat().st_mtime
        raw = np.load(depth_file, mmap_mode="r") if fresh else None
        if raw is None or raw.shape != (len(frames), h, w):
            if model is None:
                model = DepthAnythingV2(encoder="vitl", features=256, out_channels=[256, 512, 1024, 1024])
                model.load_state_dict(torch.load(WEIGHTS, map_location="cpu"))
                model = model.to("cuda").eval()
            with torch.autocast("cuda", dtype=torch.float16):  # half precision: 6x faster with the fused attention
                save_npy(depth_file, np.stack([model.infer_image(f, input_size=1022) for f in frames]).astype(np.float16))
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
        clips never changes her depth. A clip framed wider (full body, a place, walking on or off) lines
        up with its own first frame (its last, walking on from the empty glass), and its depth range is
        mapped onto the main clip's. A frame with too little of her to fit (she's off the glass) takes
        the nearest frame's fit."""
        _, start, end = role(c["src"])
        c["own"] = wide(start) or wide(end)
        r = c["frames"] - 1 if start == "gone" else 0
        c_ref, c_mask = (c["raw"][r].astype(np.float32), unpack(c["packed"], r, w)) if c["own"] else (ref, ref_mask)
        fits = []
        for i in range(c["frames"]):
            sel = unpack(c["packed"], i, w) & c_mask
            fits.append(np.polyfit(np.asarray(c["raw"][i])[sel].astype(np.float32), c_ref[sel], 1) if sel.sum() >= 500 else None)
        known = [i for i, f in enumerate(fits) if f is not None]
        c["fit"] = [f if f is not None else (fits[min(known, key=lambda k: abs(k - i))] if known else np.array([1.0, 0.0]))
                    for i, f in enumerate(fits)]
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
        moods, start, end = role(src)
        before = built_before.get(name)
        expect = [BUILD, round(lo, 6), round(hi, 6), round(focus, 6), stamp(src), main_stamp] + (["lit"] if particles(src) else []) + (["joined"] if joined(src) else [])
        if before and before.get("built") == expect and (folder / before["file"]).exists():
            # Unchanged since it was last built: keep the video and its mouth track (its role may change).
            meta_clips.append({**before, "moods": moods, "from": start, "to": end, "talk": "talk" in moods})
            continue
        # New or changed: a file name the page isn't playing now (alive.json still lists the old one
        # until this build writes it, and its mouth track is for the old video).
        out, v = folder / f"alive_{Path(src).stem}.mp4", 1
        while out.exists():
            v += 1
            out = folder / f"alive_{Path(src).stem}_v{v}.mp4"
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
        # Full-body clips play without lip sync (her face is too small to track, or turned away mid-twirl),
        # and so do clips on and off the glass; at a place she has it if her face can be found.
        mouths, found = ((np.zeros((0, 8)), 0) if start.split("@")[0] == "full" or "gone" in (start, end) else
                         mouth_track(landmarker, frames, required=not at_place(start, end)))
        del frames, depth
        meta_clips.append({"file": out.name, "frames": c["frames"], "source": name,
                           "moods": moods, "from": start, "to": end, "talk": "talk" in moods,
                           "built": [BUILD, round(lo, 6), round(hi, 6), round(focus, 6), c["stamp"], main_stamp] + (["lit"] if particles(src) else []) + (["joined"] if joined(src) else []),
                           "mouth": [[round(v, 5) for v in m] for m in mouths.tolist()]})
        encoded += 1
        print(f"  wrote {out.name} ({out.stat().st_size / 1e6:.1f} MB), face found in {found}/{c['frames']} frames")
    del model
    torch.cuda.empty_cache()

    meta = {"fps": main_clip["fps"], "texSize": [w, h], "focus": round(focus, 4), "range": [lo, hi],
            "home": home,
            "rangeFrom": [Path(sources[0]).name, main_stamp, BUILD], "panels": ["color", "depth", "cut"],
            "mouthFields": ["u", "v", "halfWidth", "halfHeight", "chin", "tilt", "halfGap", "lift"], "clips": meta_clips}
    part = meta_file.with_suffix(".part")
    part.write_text(json.dumps(meta))
    part.replace(meta_file)
    print(f"wrote alive.json: {len(meta_clips)} clips ({encoded} encoded), focus {focus:.3f}")


if __name__ == "__main__":
    main()
