"""New looks from Flux.2 Klein picture edits (Wan2GP's flux2_klein_9b): her clean picture in, a
few versions of her in new clothes (or with something changed) out, one of which becomes the look.

An outfit's name says when she wears it, which is how the glass chooses (OUTFIT_RULES in
living.js): cold... under 45°F, hot... over 85°F, evening... from 6 to 11 pm, day... taking turns
with her usual clothes, a different one each day, night... from 10 pm until she wakes (she falls
asleep in it if it has its own asleep look and sleep clips).
"""
import json
import os
import re
import shutil
import struct
import subprocess
import time
import zlib
from pathlib import Path

from config import CFG, PICTURES, WAN2GP, WAN2GP_PYTHON
from project import base_of, outfit_of

DRAFTS = PICTURES / "drafts"
WHEN = {"cold": "cold days (under 45°F)", "hot": "hot days (over 85°F)", "evening": "evenings, 6 to 11 pm",
        "day": "daytime, taking turns with her usual clothes",
        "night": "nights, from 10 pm until she wakes (she sleeps in it)",
        "chosen": "only when she chooses it herself (glass_wear); she sleeps in it if it has an asleep look"}
BACKGROUND = "the lighting, the framing, and the pure black background"
CLEAN_PROMPT = ("Clean up this picture of her: the same young woman with exactly the same face, hair, expression "
                "and clothes, facing the viewer, framed from the waist up with a little black space above her head, "
                "softly lit and glowing gently, on a plain pure black background. Remove everything around her.")


def outfit_prompt(wearing, keep):
    """Klein's instruction for new clothes, in the form that kept the Chooms themselves unchanged."""
    return (f"Change her clothes: she now wears {wearing.strip().rstrip('.')}. Keep everything else exactly the "
            f"same: {keep.strip().rstrip(',. ') or 'her face, expression, hair and pose'}, {BACKGROUND}.")


def with_clothes(keep):
    """What a full body or asleep picture keeps: what keeps her herself (the look's kleinKeep: Genesis's
    glasses and motes) and the clothes, which are the point of an outfit's full body."""
    keep = keep.strip().rstrip(",. ")
    if "clothes" in keep or not keep:
        return keep or "her face, hair and clothes"
    return f"{re.sub(r',\s+and\s+(?=[^,]*$)', ', ', keep)}, and her clothes"  # one list "and", before the clothes


# A clause about her arms, hands or pose in a keep line: "her arms crossed in front of her".
POSE = re.compile(r"\b(arms?|hands?|fingers?|pose|posture|crossed|clasped|raised|at her sides?)\b", re.I)
# Something she holds: "the glowing fire agate heart she holds in front of her with both hands".
HELD = re.compile(r"^(.+?)\s+(?:that\s+)?she\s+(?:holds|is holding|carries)\b", re.I)


def full_keep(keep):
    """A keep line for a full body, which stands relaxed: her pose stays out (Eve's crossed arms would
    fight "standing relaxed" in every full body), and what she holds stays without how she holds it
    (Optic's heart). Clauses are split at commas; "and" inside one ("her skin and body made of motes")
    stays whole."""
    parts = [p.strip() for p in re.split(r",\s*(?:and\s+)?", keep.strip().rstrip(",. ")) if p.strip()]
    out = []
    for p in parts:
        held = HELD.match(p)
        if held:
            out.append(held.group(1))
        elif not POSE.search(p):
            out.append(p)
    return ", ".join(out)  # with_clothes adds ", and her clothes"


def full_prompt(keep, wearing=""):
    """Klein's instruction for a full-body picture from her main one."""
    clothes = f" She wears {wearing.strip().rstrip('.')}." if wearing.strip() else ""
    return ("Show her from head to toe, standing relaxed and facing the viewer, her whole figure in frame with a little "
            f"black space above her head and below her feet. Keep {with_clothes(full_keep(keep))} "
            f"exactly as in the picture, with the same light on the same pure black background.{clothes}")


def place_prompt(does, keep):
    """Klein's instruction for one of her places, from her full body: where she is and how ("sitting
    on the ground beside a small campfire, her knees drawn up and her hands held toward the flames")."""
    return (f"Show her {does.strip().rstrip('.')}, her whole figure in frame with a little black space around her. "
            f"Keep {with_clothes(full_keep(keep))} exactly as in the picture, with the same light on the same pure "
            "black background.")


def asleep_prompt(keep):
    """Klein's instruction for her asleep, for the sleep clips."""
    return ("She has dozed off peacefully: her eyes are gently closed, her face is soft and relaxed, and her head tips "
            f"slightly down and to one side. Keep everything else exactly the same: {with_clothes(keep)}, {BACKGROUND}.")


# What a look's Klein prompt told Klein to keep (outfit or asleep form, then full body).
KEPT = (re.compile(r"Keep everything else exactly the same: (.+?), the lighting, the framing"),
        re.compile(r"Keep (.+?) exactly as in the picture"))


def kept_in(prompt):
    """The keep list a Klein prompt used, or "" for none or the stock one."""
    for pattern in KEPT:
        m = pattern.search(prompt or "")
        if m and m.group(1).strip() not in ("her face, expression, hair and pose", "her face, hair and clothes"):
            return m.group(1).strip()
    return ""


KINDS = {"outfit": "an outfit", "full": "full body", "asleep": "asleep", "place": "a place",
         "redo": "a new picture for a look she has"}
# Names a place can't have: the poses every Choom may have (clip_roles.POSES), and the words her clip
# names are made of, which would read as something else (idle_, to_, walkoff).
NOT_PLACES = {"main", "relaxed", "full", "asleep", "gone", "idle", "listen", "talk", "pose", "oops", "windy", "to",
              "from", "walkoff", "walkon", "vanish", "appear", "change", "base", "plain", "noheart"}


def gone(proj):
    """The empty glass she walks off into and on from: a pure black picture the size of her full body's
    (or main) picture, no Klein needed. Returns the look."""
    like = PICTURES / (proj.looks.get("full", {}).get("picture") or proj.looks["main"]["picture"])
    head = like.read_bytes()[:24]
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{like.name} isn't a PNG")
    w, h = struct.unpack(">II", head[16:24])
    chunk = lambda kind, data: (struct.pack(">I", len(data)) + kind + data
                                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    row = b"\x00" + bytes(w * 3)  # filter byte, then black RGB
    target = PICTURES / f"{proj.id}_gone.png"
    target.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                       + chunk(b"IDAT", zlib.compress(row * h, 9)) + chunk(b"IEND", b""))
    proj.looks["gone"] = {"picture": target.name, "subject": "", "ending": ""}
    return proj.looks["gone"]
# Klein's instruction for a new picture of a look she has, when it's the colour that's wrong.
TRUE_COLOR_PROMPT = ("Make this picture look natural and true to life: clean neutral white light with accurate, realistic "
                     "skin tones and colours and no colour cast. Keep everything else exactly the same: her face, "
                     "expression, hair, clothes and pose, the framing, and the pure black background.")


def worn_in(subject):
    """The clothes her subject line names ("an open red plaid flannel shirt over a white ribbed tank
    top"), for a look made before "She wears" was kept; "" if it names none."""
    m = re.search(r"wearing (.+?)(, (?:glows|glowing|softly|against|her|in |standing|holding))", subject or "")
    return m.group(1) if m else ""


def subject_for(look, wearing):
    """Her subject line in the new clothes: from the look's wardrobe template ("... wearing {wearing},
    glows softly against ..."), or by swapping the clothes in her subject line."""
    if look.get("wardrobe"):
        return look["wardrobe"].replace("{wearing}", wearing.strip().rstrip("."))
    subject = look.get("subject", "")
    m = re.search(r"wearing (.+?)(, (?:glows|glowing|softly|against|her|in |standing|holding))", subject)
    if m:
        return subject[:m.start(1)] + wearing + subject[m.end(1):]
    return re.sub(r",? against a", f", wearing {wearing}, against a", subject, count=1)


def run(choom, look_id, source, prompt, count=3, seed=31, log=print, refs=()):
    """Render `count` versions with Klein from the picture `source` (in clean/); returns their file
    names, saved in clean/drafts/ as <choom>_<look>_<n>.png. `refs` are more pictures in clean/ for
    Klein to take things from (a dress, shoes, a close-up of her face): picture 2, 3, ... in the
    instruction. The first stays the main subject, so her framing, pose and light are kept."""
    proc, out = start_klein(choom, look_id, source, prompt, count, seed, refs)
    return finish_klein(choom, look_id, out, proc.wait(), log)


def start_klein(choom, look_id, source, prompt, count=3, seed=31, refs=()):
    """Start Klein in its own session (the Studio can be restarted meanwhile and pick it up again).
    Returns (process, its output folder)."""
    settings_file = WAN2GP / "settings" / "flux2_klein_9b_settings.json"
    settings = json.loads(settings_file.read_text()) if settings_file.exists() else {}
    settings.update({"model_type": CFG["picture_model"], "prompt": prompt, "video_prompt_type": "KI",
                     "image_refs": [str(PICTURES / source)] + [str(PICTURES / r) for r in refs],
                     "resolution": "1440x1920", "num_inference_steps": 4,
                     "seed": int(seed), "repeat_generation": int(count), "image_mode": 1})
    slug = look_id.replace("@", "_")
    out = DRAFTS / f"run_{choom}_{slug}_{time.strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "settings.json").write_text(json.dumps(settings, indent=1))
    with open(out / "wan2gp.log", "w") as wlog:
        proc = subprocess.Popen([str(WAN2GP_PYTHON), "wgp.py", "--process", str(out / "settings.json"),
                                 "--output-dir", str(out)], cwd=WAN2GP, stdout=wlog, stderr=subprocess.STDOUT,
                                start_new_session=True)
    return proc, out


def finish_klein(choom, look_id, out, code, log=print):
    """Klein's versions from its output folder, moved into clean/drafts/; returns their names."""
    slug = look_id.replace("@", "_")
    out = Path(out)
    made = sorted(out.glob("2*.png"), key=os.path.getmtime)
    if code or not made:
        raise RuntimeError(f"Klein made no pictures (exit {code}; see {out / 'wan2gp.log'})")
    names = []
    n = 1
    for f in made:
        while (DRAFTS / f"{choom}_{slug}_{n}.png").exists():
            n += 1
        target = DRAFTS / f"{choom}_{slug}_{n}.png"
        shutil.move(str(f), target)
        names.append(f"drafts/{target.name}")
    log(f"{len(names)} pictures for {choom} {look_id}")
    return names


def new_file(proj, look_id):
    """A free file name in clean/ for a look's picture: <choom>_<outfit>_<n>.png for an outfit,
    <choom>_full_dayspandex_<n>.png for an outfit's full body or asleep look."""
    kind, outfit = base_of(look_id), outfit_of(look_id)
    slug = outfit if outfit and kind in ("main", "relaxed") else look_id.replace("@", "_")
    n = 1
    while (PICTURES / f"{proj.id}_{slug}_{n}.png").exists():
        n += 1
    return PICTURES / f"{proj.id}_{slug}_{n}.png"


def adopt(proj, look_id, draft, wearing=None, prompt=None, base_look=None, replace=False):
    """Make a draft picture a look: copied into clean/ as <choom>_<outfit>_1.png, with its subject line
    in the new clothes and the base look's keep line and ending. base_look is the look the picture
    started from (an outfit can start from another outfit, Genesis's night look from her plain one);
    a full body or asleep look started from an outfit is that outfit's own (full@dayspandex,
    asleep@night). replace: a new picture for a look she has; the rest of the look stays (its clips
    are planned again from it, plan.repicture)."""
    if replace:
        target = new_file(proj, look_id)
        shutil.copy2(PICTURES / draft, target)
        look = proj.looks[look_id]
        look["picture"] = target.name
        if prompt:
            look["klein"] = prompt
        proj.data.get("drafts", {}).pop(look_id, None)
        return look
    if look_id in proj.looks and not proj.looks[look_id].get("picture"):
        # A look waiting for its picture (a new Choom's main): just give it the chosen one.
        target = PICTURES / f"{proj.id}_{look_id}_1.png"
        shutil.copy2(PICTURES / draft, target)
        proj.looks[look_id]["picture"] = target.name
        if prompt:
            proj.looks[look_id]["klein"] = prompt
        proj.data.get("drafts", {}).pop(look_id, None)
        return proj.looks[look_id]
    kind, outfit = base_of(look_id), outfit_of(look_id)
    target = new_file(proj, look_id)
    shutil.copy2(PICTURES / draft, target)
    if kind not in ("main", "relaxed", "full", "asleep"):
        # A place: her full body's description, sitting by her campfire instead of standing. She gets
        # there from her full body (to_campfire), in her usual clothes.
        full = proj.looks.get("full", {})
        subject = re.sub(r",?\s*standing with her whole body in view", "", full.get("subject") or proj.looks["main"]["subject"])
        proj.looks[look_id] = {
            "picture": target.name,
            "subject": f"{subject.rstrip('. ')}, {wearing.strip().rstrip('.')}",
            "does": wearing.strip().rstrip("."),
            "from": "full",
            "ending": "She stays in the same place and pose and ends exactly as she began.",
            **({"keep": full["keep"]} if full.get("keep") else {}),
            **({"klein": prompt} if prompt else {}),
        }
    elif kind in ("full", "asleep"):
        base = proj.looks.get(base_look or f"main@{outfit}", {}) if outfit else proj.looks.get("main", {})
        # An outfit made on one of her full bodies (Klein changed the clothes on her whole figure): its
        # subject already stands with her whole body in view, and what she wears is head to toe.
        on_full = kind == "full" and base_of(base_look or "") == "full"
        # An outfit's full body: what's said of her legs and feet joins the outfit's own clothes (read
        # from its subject line if it has no "She wears": Eve's flannel full body lost the flannel).
        top = base.get("wearing") or (worn_in(base.get("subject")) if not on_full else "")
        if outfit and kind == "full" and wearing and top and top.lower() not in wearing.lower():
            wearing = f"{top}, {wearing.strip().rstrip('.')}"
        subject = (subject_for(base, wearing) if wearing else base.get("subject", "")).rstrip(". ")
        if kind == "full" and not on_full and re.search(r",\s*(?:her )?arms crossed(?: in front of her)?", subject):
            # A full body stands relaxed (pictures.full_keep); her waist-up pose stays out of its line.
            subject = re.sub(r",\s*(?:her )?arms crossed(?: in front of her)?", "", subject).replace(
                ", against a plain pure black background", ", against a plain pure black background, her arms relaxed at her sides", 1)
        proj.looks[look_id] = {
            "picture": target.name,
            "subject": subject + (", standing with her whole body in view" if kind == "full" and not on_full else ""),
            "ending": ("She stays in the same place and ends exactly as she began, facing the viewer, her whole body in view."
                       if kind == "full" else "She stays in the same place and pose and ends exactly as she began."),
            **({"keep": base["keep"]} if base.get("keep") else {}),
            **({"klein": prompt} if prompt else {}),
        }
    else:
        base = proj.looks.get(base_look or base_of(look_id), {})
        # What keeps her herself goes with her into the outfit, so a full body or another outfit made
        # from it later keeps the same: without it, a full body of Genesis's burgundy dress was told
        # to keep only "her face, expression, hair and pose", and her glasses and motes could go.
        klein_keep = base.get("kleinKeep") or kept_in(prompt)
        proj.looks[look_id] = {
            "picture": target.name,
            "subject": subject_for(base, wearing) if wearing else base.get("subject", ""),
            "ending": base.get("ending", ""),
            **({"keep": base["keep"]} if base.get("keep") else {}),
            **({"kleinKeep": klein_keep} if klein_keep else {}),
            **({"wearing": wearing} if wearing else {}),
            **({"klein": prompt} if prompt else {}),
        }
    proj.data.get("drafts", {}).pop(look_id, None)
    return proj.looks[look_id]
