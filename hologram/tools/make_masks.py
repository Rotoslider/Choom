#!/usr/bin/env python3
"""Cut each Choom out of her hologram render (U2-Net via rembg), for make_depth.py's layer split.

Run with Wan2GP's Python, which has rembg, a CUDA onnxruntime and the u2net weights:
    U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python tools/make_masks.py
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from rembg import new_session, remove

HOLOGRAM = Path(__file__).resolve().parents[1]
RENDERS = HOLOGRAM / "sources"
OUT = HOLOGRAM / "portraits" / "masks"
FILES = {
    "aloy": "aloy_hologram_s7001.jpg",
    "optic": "optic_hologram_s7002.jpg",
    "genesis": "genesis_hologram_s7001.jpg",
    "eve": "eve_hologram_s7101.jpg",
}


def main():
    """No arguments: the four Chooms' renders. `make_masks.py <id> <picture>`: one Choom (a new one
    added in Glass Studio) from her picture."""
    import sys
    OUT.mkdir(parents=True, exist_ok=True)
    session = new_session("u2net", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    files = {sys.argv[1]: Path(sys.argv[2])} if len(sys.argv) == 3 else {cid: RENDERS / name for cid, name in FILES.items()}
    for cid, path in files.items():
        image = Image.open(path).convert("RGB")
        alpha = np.asarray(remove(image, session=session, only_mask=True).convert("L"))
        mask = (alpha > 110).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if count > 1:
            mask = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
        cv2.imwrite(str(OUT / f"{cid}.png"), mask * 255)
        print(f"{cid:8s} person covers {mask.mean():.1%}")


if __name__ == "__main__":
    main()
