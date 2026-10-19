#!/usr/bin/env python3
"""The campfire circle's fire as a moving relief, like a Choom's clips: a looping clip of a campfire on
black (rendered from a picture of one: split logs over embers in a small ring of stones; first frame =
last frame) becomes props/fire.mp4, three panels stacked (its color, its depth, its matte), and
props/fire.json (frame rate, panel size, focus). Run with Forge Neo's Python (Depth Anything V2), from
the hologram folder:
    ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_fire.py FIRE.mp4
The logs and stones hold still, so the depth is taken once, from the clip's median frame, and the flames
take the depth of the wood they rise from: a depth read frame by frame would make the fire's shape
wobble. The matte follows the light, so flame tips and sparks fade out softly instead of being cut.
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_alive import extend_edges, read_clip  # noqa: E402  (also gives Depth Anything its fused attention)
from make_depth import BG_LUMA, DETAIL, WEIGHTS, shape_depth  # noqa: E402
from depth_anything_v2.dpt import DepthAnythingV2  # noqa: E402

HOLOGRAM = Path(__file__).resolve().parents[1]
OUT = HOLOGRAM / "props"
MARGIN = 24  # black kept around the fire's light when the panel is cropped to it, in pixels


def main():
    src = Path(sys.argv[1])
    fps, frames = read_clip(src)
    stack = np.stack(frames)
    luma = stack.max(axis=3).astype(np.float32) / 255.0
    # The panel is cropped to what the fire lights (its flames at their tallest too), so no texture is spent
    # on black: a pixel counts if it's lit in a few frames, not just once (a stray speck near the edge).
    ys, xs = np.nonzero((luma > BG_LUMA).mean(axis=0) > 0.03)
    h, w = luma.shape[1:]
    y0, y1 = max(ys.min() - MARGIN, 0), min(ys.max() + MARGIN, h)
    x0, x1 = max(xs.min() - MARGIN, 0), min(xs.max() + MARGIN, w)
    y1, x1 = y0 + (y1 - y0) // 2 * 2, x0 + (x1 - x0) // 2 * 2  # even, for the encoder
    stack, luma = stack[:, y0:y1, x0:x1], luma[:, y0:y1, x0:x1]
    h, w = luma.shape[1:]

    still = np.median(stack, axis=0).astype(np.uint8)
    model = DepthAnythingV2(encoder="vitl", features=256, out_channels=[256, 512, 1024, 1024])
    model.load_state_dict(torch.load(WEIGHTS, map_location="cpu"))
    model = model.to("cuda").eval()
    with torch.autocast("cuda", dtype=torch.float16):
        raw = model.infer_image(still, input_size=1022).astype(np.float32)
    del model
    torch.cuda.empty_cache()

    # What holds still and is lit: the wood, the embers, the stones, the foot of the flames.
    solid = cv2.GaussianBlur(still.max(axis=2).astype(np.float32) / 255.0, (0, 0), 2.0) > BG_LUMA
    solid = cv2.morphologyEx(solid.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)) > 0
    lo, hi = np.percentile(raw[solid], [2, 99.5])
    d = np.clip((raw - lo) / max(hi - lo, 1e-6), 0, 1)
    focus = float(np.median(d[solid]))
    d = extend_edges(shape_depth(d, solid, focus, DETAIL), solid)
    depth = cv2.cvtColor(np.round(d * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)

    OUT.mkdir(exist_ok=True)
    out = OUT / "fire.mp4"
    part = out.with_suffix(".part")  # swapped in when done, so a running page never reads half a file
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h * 3}",
                            "-r", f"{fps:g}", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "14",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", str(part)], stdin=subprocess.PIPE)
    for bgr, lit in zip(stack, luma):
        matte = np.clip((cv2.GaussianBlur(lit, (0, 0), 1.0) - 0.02) / 0.1, 0, 1)
        enc.stdin.write(np.vstack([bgr, depth, cv2.cvtColor(np.round(matte * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)]).tobytes())
    enc.stdin.close()
    assert enc.wait() == 0, "ffmpeg failed"
    part.replace(out)
    meta = {"fps": fps, "texSize": [w, h], "focus": round(focus, 4), "panels": ["color", "depth", "matte"],
            "source": src.name, "frames": len(stack)}
    (OUT / "fire.json").write_text(json.dumps(meta))
    print(f"wrote {out.name} ({out.stat().st_size / 1e6:.1f} MB, {w}x{h}, {len(stack)} frames) and fire.json, focus {focus:.3f}")


if __name__ == "__main__":
    main()
