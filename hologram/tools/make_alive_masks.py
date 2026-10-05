#!/usr/bin/env python3
"""Cut a Choom out of every frame of her idle loop with U2-Net, for make_alive.py (a plain
brightness cut-out would keep her rim glow, which sits at background depth and smears).

Run with Wan2GP's Python, which has rembg and the u2net weights:
    U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python \
        tools/make_alive_masks.py aloy LOOP.mp4
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from rembg import new_session, remove

HOLOGRAM = Path(__file__).resolve().parents[1]


def main():
    cid, src = sys.argv[1], sys.argv[2]
    session = new_session("u2net", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    cap = cv2.VideoCapture(src)
    masks = []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        h, w = bgr.shape[:2]
        cw = min(w, int(round(h * 0.75 / 2)) * 2)  # same 3:4 crop as make_alive.py
        x0 = (w - cw) // 2
        rgb = Image.fromarray(cv2.cvtColor(bgr[:, x0:x0 + cw], cv2.COLOR_BGR2RGB))
        alpha = np.asarray(remove(rgb, session=session, only_mask=True).convert("L"))
        masks.append(alpha > 110)
    out = HOLOGRAM / "portraits" / cid / "alive_masks.npz"
    np.savez_compressed(out, masks=np.stack(masks))
    print(f"{cid}: {len(masks)} masks -> {out}")


if __name__ == "__main__":
    main()
