#!/usr/bin/env python3
"""Contact sheets and automatic checks for rendered clips.

The sheet is eight frames of a clip in a row (studio/sheets/<clip>.jpg). The checks look for the
ways clips go wrong on the glass, measured on small grey frames:
    background  the black around her lifts (a flash, fog, a glow or smoke rolling in)
    push-in     she grows in the frame (the camera pushes in or zooms)
    color       her light or colour drifts away from her picture's
    seam        a loop's last frame doesn't come back to its first (a visible jump each time it ends)
    cut         a sudden jump mid-clip (a new shot)
Flags are hints for the review page; you decide. Needs numpy, so run it with Wan2GP's Python:
    ~/pinokio/api/wan2gp/app/venv/bin/python studio/review.py aloy [CLIP ...] [--all] [--force]
"""
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import CLIPS, SHEETS  # noqa: E402
from project import Project, editing  # noqa: E402

W, H = 104, 138          # analysis size (the clip is 832x1104)
BG = 0.045               # darker than this is empty black glass (make_depth.BG_LUMA)
# Set on the four Chooms' first 784 clips: these flag 38 of the 46 clips dropped by eye (the rest were
# dropped for taste) and 5% of the kept ones. Clips that move a lot on purpose (full body, her
# particles, a look changing on screen) get the looser limits.
LIMITS = {"background": 0.06, "push-in": 1.15, "color": 0.15, "seam": 0.009, "cut": 15}
LOOSE = {"background": 0.3, "push-in": 1.6, "color": 0.3, "seam": 0.009, "cut": 40}
BUSY = re.compile(r"motes|windy|sparkle|glow|fade|heart")


def frames_of(src, w=W, h=H):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-vf", f"scale={w}:{h}:flags=area",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3).astype(np.float32) / 255.0


def dilate(mask, r):
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def loose(name, clip):
    return clip["from"] == "full" or clip["from"] != clip["to"] or bool(BUSY.search(name))


def measure(src, loop=True, lenient=False):
    f = frames_of(src)
    luma = f.max(axis=3)
    her = luma > BG
    first = her[0]
    # The black well away from her outline in the first frame: it should stay black.
    away = ~dilate(first, 6)
    away[:4], away[-4:], away[:, :4], away[:, -4:] = False, False, False, False
    if away.sum() < 200:
        away = ~dilate(first, 2)
    lift = luma[:, away].mean(axis=1)
    background = float(np.percentile(lift, 98) - lift[0])
    # Her size: lit pixels, against the first frame (a push-in grows her steadily).
    area = her.reshape(len(f), -1).sum(axis=1).astype(np.float32)
    growth = float(np.percentile(area, 95) / max(area[0], 1))
    # Her colour inside her first outline, against the first frame.
    tint = np.stack([f[i][first].mean(axis=0) for i in range(len(f))])
    color = float(np.abs(tint - tint[0]).max())
    # Frame-to-frame change; the seam is the step from the last frame back to the first.
    steps = np.abs(np.diff(luma, axis=0)).mean(axis=(1, 2))
    typical = float(np.median(steps)) + 1e-4
    seam = float(np.abs(luma[-1] - luma[0]).mean()) if loop else 0.0
    cut = float(steps.max() / typical)
    m = {"background": round(background, 4), "push-in": round(growth, 3), "color": round(color, 3),
         "seam": round(seam, 4), "cut": round(cut, 1)}
    limits = LOOSE if lenient else LIMITS
    flags = [k for k, v in m.items() if v > limits[k] and (k != "seam" or loop)]
    return m, flags


def sheet(src, out, count=8, w=208, h=276):
    """Eight frames in a row, first to last."""
    n = int(subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
                            "stream=nb_read_packets", "-of", "csv=p=0", str(src)], capture_output=True, text=True).stdout.strip() or 124)
    pick = "+".join(f"eq(n\\,{round(i * (n - 1) / (count - 1))})" for i in range(count))
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf",
                    f"select='{pick}',scale={w}:{h},tile={count}x1:padding=4:color=0x202020",
                    "-frames:v", "1", "-q:v", "4", str(out)], check=True)


def check(cid, names, force=False):
    """Sheets and checks for clips, saved to her project every 20 clips (a long run that gets stopped
    keeps what it did)."""
    proj = Project.load(cid)
    results, pending = {}, {}

    def save():
        if pending:
            with editing(cid) as p:
                for name, (m, flags) in pending.items():
                    if name in p.clips:
                        p.clips[name]["checks"] = m
                        p.clips[name]["flags"] = flags
            pending.clear()

    for name in names:
        clip = proj.clips.get(name)
        src = CLIPS / f"{name}.mp4"
        if not clip or not src.exists():
            continue
        out = SHEETS / f"{name}.jpg"
        fresh = out.exists() and out.stat().st_mtime >= src.stat().st_mtime
        if fresh and clip.get("checks") and not force:
            continue
        if not fresh or force:
            sheet(src, out)
        m, flags = measure(src, loop=clip["from"] == clip["to"], lenient=loose(name, clip))
        results[name] = pending[name] = (m, flags)
        print(f"{name}: {', '.join(flags) or 'clean'}  {m}", flush=True)
        if len(pending) >= 20:
            save()
    save()
    return results


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    cid, names = args[0], args[1:]
    proj = Project.load(cid)
    if not names:
        names = [n for n, c in proj.clips.items()
                 if c["status"] == "rendered" or ("--all" in sys.argv and c["status"] in ("kept", "dropped"))]
    check(cid, names, force="--force" in sys.argv)


if __name__ == "__main__":
    main()
