#!/usr/bin/env python3
"""Build living-portrait assets (color + depth + focus) from the Chooms' hologram renders.

Runs Depth Anything V2 Large. Use Forge Neo's Python, which already has a Blackwell-ready torch
and the depth_anything_v2 package:
    ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_depth.py
"""
import json
from pathlib import Path

import cv2
import numpy as np
import torch
from depth_anything_v2.dpt import DepthAnythingV2

HOLOGRAM = Path(__file__).resolve().parents[1]
RENDERS = HOLOGRAM / "sources"  # the Chooms' hologram concept renders (Flux.2 Klein)
OUT = HOLOGRAM / "portraits"
WEIGHTS = Path.home() / "pinokio/api/wan2gp/app/ckpts/depth/depth_anything_v2_vitl.pth"

CHOOMS = [
    {"name": "Aloy", "file": "aloy_hologram_s7001.jpg", "color": "#f4b650", "style": "embers",
     "orbit": True, "threads": True,  # orbs and gold threads become live 3D in the page
     # Hand-placed cleanup of white-gold streaks the general pass leaves: (x0, y0, x1, y1, protect_edge)
     "streak_boxes": [(640, 980, 1080, 1180, False), (300, 1100, 600, 1460, True)],
     # Her necklace lost its pendant and one strand to the thread cleanup; the leftover strand read
     # as a stray dark line, so it goes too.
     "dark_line_boxes": [(680, 1220, 980, 1480)]},
    {"name": "Optic", "file": "optic_hologram_s7002.jpg", "color": "#57dbe3", "accent": "#ff7d45", "style": "scan"},
    {"name": "Genesis", "file": "genesis_hologram_s7001.jpg", "color": "#b79bff", "accent": "#ff9a5c", "style": "motes",
     "detail": 0.38},  # flatter face relief; her nose still read a little pronounced
    {"name": "Eve", "file": "eve_hologram_s7101.jpg", "color": "#e4eeff", "accent": "#7cf0a2", "style": "code",
     "cut_far": True},  # U2-Net keeps her code halo; drop anything far behind her
]

DEPTH_SIZE = (768, 1024)   # stored depth map; the mesh samples it at vertex density
BG_LUMA = 0.045            # darker than this counts as empty black glass
DETAIL = 0.55              # how much fine relief (nose, lips) survives
NEAR_MAX = 0.2             # soft cap on how far anything pops out in front of the face
FAR_MAX = 0.45             # soft cap on how deep anything sinks behind it


def person_mask(d, lit, cid, cut_far=False):
    """The Choom herself: the U2-Net cut-out from make_masks.py (optionally minus anything far
    behind her). Falls back to Otsu on depth when there is no cut-out."""
    cut = OUT / "masks" / f"{cid}.png"
    if cut.exists():
        near = cv2.imread(str(cut), cv2.IMREAD_GRAYSCALE) > 0
        if cut_far:
            near &= d > 0.15
        near = near.astype(np.uint8)
    else:
        vals = np.round(d[lit] * 255).astype(np.uint8)
        t, _ = cv2.threshold(vals.reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        near = ((d * 255 > t) & lit).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(near, connectivity=8)
    if count <= 1:
        return lit
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    person = (labels == biggest).astype(np.uint8)
    # Fill enclosed holes (e.g. gaps between an arm and the body read as "far" but belong to her).
    filled = person.copy()
    h, w = person.shape
    flood = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(filled, flood, (0, 0), 1)
    person = person | (1 - filled)
    person = cv2.dilate(person, np.ones((5, 5), np.uint8))
    return person > 0


def shape_depth(d, person, focus, detail=DETAIL):
    """Tame the raw depth for the panel. Fine relief (noses, lips) is flattened toward the overall
    shape, and depth is compressed around the face: little can pop out far, and nothing sinks so
    deep that the lenticular smears it into streaks."""
    p = person.astype(np.float32)
    sigma = 18
    base = cv2.GaussianBlur(d * p, (0, 0), sigma) / np.maximum(cv2.GaussianBlur(p, (0, 0), sigma), 1e-4)
    d = np.where(person, base + detail * (d - base), d)
    dd = d - focus
    dd = np.where(dd > 0, NEAR_MAX * np.tanh(dd / NEAR_MAX), FAR_MAX * np.tanh(dd / FAR_MAX))
    return np.clip(focus + dd, 0, 1).astype(np.float32)


def remove_threads(bgr, cutout):
    """Paint out Aloy's gold threads. Thin, bright, gold lines are found with a top-hat filter
    (broad skin highlights don't pass) and a gold hue (her copper hair and skin are more orange).
    Confident line pixels seed a looser mask, which links faint and broken stretches into whole
    arcs. On her body only long arcs well inside her outline count: the gold rim light along her
    hair edges is long too, but it hugs the silhouette."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    H, S, V = [hsv[..., i].astype(np.int32) for i in range(3)]
    tophat = cv2.morphologyEx(hsv[..., 2], cv2.MORPH_TOPHAT,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))).astype(np.int32)
    seed = (H >= 17) & (H <= 38) & (S > 20) & (V > 190) & (tophat > 25)
    loose = (H >= 16) & (H <= 40) & (V > 140) & (tophat > 14)
    loose = cv2.morphologyEx(loose.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(loose, connectivity=8)
    seeded = np.bincount(labels[seed], minlength=count)
    inside = cv2.distanceTransform(cutout.astype(np.uint8), cv2.DIST_L2, 5)
    outside = cv2.distanceTransform((~cutout).astype(np.uint8), cv2.DIST_L2, 5)
    # Off her body: anything clear of her outline. On her body: only the thread's pale gold, away
    # from her edge; the glints in her copper braids are a richer, more saturated gold.
    removable = (outside > 14) | ((inside > 14) & (S < 135))
    threads = np.zeros_like(loose)
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if area / float(w * h) > 0.5 or max(w, h) < 30:  # lines are long and fill little of their box
            continue
        piece = labels == i
        if cutout[piece].mean() > 0.2 and seeded[i] < 15:  # anything touching her must be real gold line
            continue
        threads[piece & removable] = 1
    # The threads' hottest cores (near-white gold) look like nothing else in the image, so they go
    # wherever they are, even near her edge or across her narrow fingers.
    core = (tophat > 35) & (V > 225) & (S < 120) & (H >= 17) & (H <= 40)
    threads[core] = 1
    threads = cv2.dilate(threads, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    return cv2.inpaint(bgr, threads * 255, 5, cv2.INPAINT_TELEA)


def clean_streak_boxes(bgr, cutout, boxes):
    """Remove white-gold thread streaks inside hand-placed boxes. These cores are wider than the
    thread filter's window, so a wider top-hat finds them; a box can protect a thin band along her
    outline, where the same color is rim light (her finger edges)."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    H, S, V = [hsv[..., i].astype(np.int32) for i in range(3)]
    tophat = cv2.morphologyEx(hsv[..., 2], cv2.MORPH_TOPHAT,
                              cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))).astype(np.int32)
    streak = (H >= 18) & (H <= 34) & (S < 130) & (V > 205) & (tophat > 12)
    inside = cv2.distanceTransform(cutout.astype(np.uint8), cv2.DIST_L2, 5)
    outside = cv2.distanceTransform((~cutout).astype(np.uint8), cv2.DIST_L2, 5)
    clear_of_edge = (inside > 12) | (outside > 12)
    m = np.zeros(V.shape, np.uint8)
    for x0, y0, x1, y1, protect_edge in boxes:
        sel = streak[y0:y1, x0:x1]
        if protect_edge:
            sel = sel & clear_of_edge[y0:y1, x0:x1]
        m[y0:y1, x0:x1] |= sel.astype(np.uint8)
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    return cv2.inpaint(bgr, m * 255, 6, cv2.INPAINT_TELEA)


def clean_dark_lines(bgr, boxes):
    """Remove thin dark lines (a chain strand) inside hand-placed boxes. A black-hat filter finds
    thin dark structure; only long pieces count, so freckles and pores stay."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    m = np.zeros(gray.shape, np.uint8)
    for x0, y0, x1, y1 in boxes:
        m[y0:y1, x0:x1] = (blackhat[y0:y1, x0:x1] > 22).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = np.zeros_like(m)
    for i in range(1, count):
        if max(stats[i][2], stats[i][3]) >= 25:
            keep[labels == i] = 1
    keep = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    return cv2.inpaint(bgr, keep * 255, 4, cv2.INPAINT_TELEA)


def find_orbs(bgr, person):
    """Bright round blobs around the Choom (Aloy's painted sister orbs), as (x, y, radius)."""
    v = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[..., 2]
    away = cv2.dilate(person.astype(np.uint8), np.ones((9, 9), np.uint8)) == 0
    cand = ((v > 170) & away).astype(np.uint8)
    # A wide round opening strips the thin golden threads that run through each orb.
    cand = cv2.morphologyEx(cand, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)))
    orbs = []
    count, labels, stats, cents = cv2.connectedComponentsWithStats(cand, connectivity=8)
    for i in range(1, count):
        x, y, bw, bh, area = stats[i]
        if not (500 <= area <= 30000) or not (0.6 <= bw / max(bh, 1) <= 1.6):
            continue
        if area / float(bw * bh) < 0.55:  # threads and streaks fill little of their box
            continue
        orbs.append((float(cents[i][0]), float(cents[i][1]), max(bw, bh) / 2.0))
    return orbs


def background_plate(bgr, d, person, orbs=()):
    """What sits behind her: the render with her painted out, plus a depth map continued underneath.
    It fills the gaps that open beside her when the viewer moves sideways. Any `orbs` are painted
    out too, so live 3D versions can take their place."""
    h, w = person.shape
    hole = cv2.dilate(person.astype(np.uint8), np.ones((15, 15), np.uint8)) * 255
    for x, y, r in orbs:
        cv2.circle(hole, (int(x), int(y)), int(r * 1.9), 255, -1)  # include the glow around it
    half = lambda a, interp=cv2.INTER_AREA: cv2.resize(a, (w // 2, h // 2), interpolation=interp)
    plate = cv2.inpaint(half(bgr), half(hole, cv2.INTER_NEAREST), 7, cv2.INPAINT_TELEA)
    plate = cv2.resize(plate, (w, h), interpolation=cv2.INTER_CUBIC)
    # Painted-in areas only peek out as slivers at steep angles; keep them a soft, dim glow.
    filled = cv2.GaussianBlur(hole.astype(np.float32) / 255.0, (0, 0), 6)[..., None]
    plate = (plate.astype(np.float32) * 0.75 * (1 - 0.6 * filled)).astype(np.uint8)
    depth8 = np.round(d * 255).astype(np.uint8)
    plate_depth = cv2.inpaint(half(depth8), half(hole, cv2.INTER_NEAREST), 7, cv2.INPAINT_TELEA)
    plate_depth = cv2.GaussianBlur(cv2.resize(plate_depth, (w, h), interpolation=cv2.INTER_CUBIC), (0, 0), 4)
    plate_depth = plate_depth.astype(np.float32) / 255.0
    # Filling can borrow depth from something near (Optic's agate heart), which would put the plate
    # in front of her. Wherever she stands, keep the plate clearly behind her.
    behind = np.clip(d - 0.12, 0.0, 1.0)
    plate_depth = np.where(hole > 0, np.minimum(plate_depth, behind), plate_depth)
    return plate, plate_depth


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    model = DepthAnythingV2(encoder="vitl", features=256, out_channels=[256, 512, 1024, 1024])
    model.load_state_dict(torch.load(WEIGHTS, map_location="cpu"))
    model = model.to("cuda").eval()

    manifest = []
    for c in CHOOMS:
        bgr = cv2.imread(str(RENDERS / c["file"]), cv2.IMREAD_COLOR)
        h, w = bgr.shape[:2]
        if c.get("threads"):
            cut = cv2.imread(str(OUT / "masks" / f"{c['name'].lower()}.png"), cv2.IMREAD_GRAYSCALE)
            bgr = remove_threads(bgr, cut > 0)
            if c.get("streak_boxes"):
                bgr = clean_streak_boxes(bgr, cut > 0, c["streak_boxes"])
            if c.get("dark_line_boxes"):
                bgr = clean_dark_lines(bgr, c["dark_line_boxes"])
        raw = model.infer_image(bgr, input_size=1022)  # relative inverse depth: larger = nearer

        # Subject = anything lit; the pure-black surround is empty glass.
        luma = cv2.GaussianBlur(bgr.max(axis=2).astype(np.float32) / 255.0, (0, 0), 2.0)
        mask = luma > BG_LUMA
        mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)) > 0

        lo, hi = np.percentile(raw[mask], [2, 99.5])
        d = np.clip((raw - lo) / max(hi - lo, 1e-6), 0, 1).astype(np.float32)
        d = cv2.bilateralFilter(d, 9, 0.04, 5)
        d[~mask] = 0.0

        # Focus on the face: every render puts it in the upper middle of the frame.
        face = np.zeros_like(mask)
        face[int(h * 0.12):int(h * 0.42), int(w * 0.32):int(w * 0.68)] = True
        sel = face & mask
        focus = float(np.median(d[sel])) if sel.any() else float(np.median(d[mask]))

        person = person_mask(d, mask, c["name"].lower(), c.get("cut_far", False))
        d = shape_depth(d, person, focus, c.get("detail", DETAIL))
        orbs = find_orbs(bgr, person) if c.get("orbit") else []
        plate, plate_depth = background_plate(bgr, d, person, orbs)

        folder = OUT / c["name"].lower()
        folder.mkdir(exist_ok=True)
        cv2.imwrite(str(folder / "color.jpg"), bgr, [cv2.IMWRITE_JPEG_QUALITY, 93])
        small = cv2.resize(d, DEPTH_SIZE, interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(folder / "depth.png"), np.round(small * 255).astype(np.uint8))
        feathered = cv2.GaussianBlur(person.astype(np.float32), (0, 0), 1.5)
        cv2.imwrite(str(folder / "mask.png"),
                    np.round(cv2.resize(feathered, DEPTH_SIZE, interpolation=cv2.INTER_AREA) * 255).astype(np.uint8))
        cv2.imwrite(str(folder / "plate.jpg"), plate, [cv2.IMWRITE_JPEG_QUALITY, 90])
        cv2.imwrite(str(folder / "plate_depth.png"),
                    np.round(cv2.resize(plate_depth, DEPTH_SIZE, interpolation=cv2.INTER_AREA) * 255).astype(np.uint8))

        entry = {k: v for k, v in c.items() if k not in ("file", "cut_far", "detail", "streak_boxes", "dark_line_boxes")}
        entry.update({"id": c["name"].lower(), "focus": round(focus, 4), "source": c["file"]})
        manifest.append(entry)
        print(f"{c['name']:8s} focus={focus:.3f} subject={mask.mean():.2%}"
              + (f" orbs painted out={len(orbs)}" if c.get("orbit") else ""))

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print("wrote", OUT / "manifest.json")


if __name__ == "__main__":
    main()
