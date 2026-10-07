#!/usr/bin/env python3
"""Depth only: cache Depth Anything's raw depth for new clips (alive_depth_<clip>.npy), so the next
Wan2GP queue can start right away and make_alive.py then runs on the CPU beside it. Skips clips whose
cache is already fresh. Forge Neo's Python, from the hologram folder:
    ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive_depth.py aloy CLIP.mp4 [...]
"""
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_alive import HOLOGRAM, DepthAnythingV2, WEIGHTS, read_clip  # noqa: E402  (also patches attention)


def main():
    cid, sources = sys.argv[1], sys.argv[2:]
    folder = HOLOGRAM / "portraits" / cid
    model = None
    for src in sources:
        depth_file = folder / f"alive_depth_{Path(src).stem}.npy"
        if depth_file.exists() and depth_file.stat().st_mtime >= Path(src).stat().st_mtime:
            continue
        _, frames = read_clip(src)
        if model is None:
            model = DepthAnythingV2(encoder="vitl", features=256, out_channels=[256, 512, 1024, 1024])
            model.load_state_dict(torch.load(WEIGHTS, map_location="cpu"))
            model = model.to("cuda").eval()
        with torch.autocast("cuda", dtype=torch.float16):
            np.save(depth_file, np.stack([model.infer_image(f, input_size=1022) for f in frames]).astype(np.float16))
        print(f"depth {Path(src).name}: {len(frames)} frames")


if __name__ == "__main__":
    main()
