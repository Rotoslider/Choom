"""New looks from Flux.2 Klein picture edits (Wan2GP's flux2_klein_9b): her clean picture in, a
few versions of her in new clothes (or with something changed) out, one of which becomes the look.

An outfit's name says when she wears it, which is how the glass chooses (OUTFIT_RULES in
living.js): cold... under 45°F, hot... over 85°F, evening... from 6 to 11 pm, day... taking turns
with her usual clothes, a different one each day.
"""
import json
import os
import re
import shutil
import subprocess
import time

from config import CFG, PICTURES, WAN2GP, WAN2GP_PYTHON
from project import base_of, outfit_of

DRAFTS = PICTURES / "drafts"
WHEN = {"cold": "cold days (under 45°F)", "hot": "hot days (over 85°F)", "evening": "evenings, 6 to 11 pm",
        "day": "daytime, taking turns with her usual clothes"}
BACKGROUND = "the lighting, the framing, and the pure black background"
CLEAN_PROMPT = ("Clean up this picture of her: the same young woman with exactly the same face, hair, expression "
                "and clothes, facing the viewer, framed from the waist up with a little black space above her head, "
                "softly lit and glowing gently, on a plain pure black background. Remove everything around her.")


def outfit_prompt(wearing, keep):
    """Klein's instruction for new clothes, in the form that kept the Chooms themselves unchanged."""
    return (f"Change her clothes: she now wears {wearing.strip().rstrip('.')}. Keep everything else exactly the "
            f"same: {keep.strip().rstrip(',. ') or 'her face, expression, hair and pose'}, {BACKGROUND}.")


def full_prompt(keep, wearing=""):
    """Klein's instruction for a full-body picture from her main one."""
    clothes = f" She wears {wearing.strip().rstrip('.')}." if wearing.strip() else ""
    return ("Show her from head to toe, standing relaxed and facing the viewer, her whole figure in frame with a little "
            f"black space above her head and below her feet. Keep {keep.strip().rstrip(',. ') or 'her face, hair and clothes'} "
            f"exactly as in the picture, with the same light on the same pure black background.{clothes}")


def asleep_prompt(keep):
    """Klein's instruction for her asleep, for the sleep clips."""
    return ("She has dozed off peacefully: her eyes are gently closed, her face is soft and relaxed, and her head tips "
            f"slightly down and to one side. Keep everything else exactly the same: "
            f"{keep.strip().rstrip(',. ') or 'her face, hair and clothes'}, {BACKGROUND}.")


KINDS = {"outfit": "an outfit", "full": "full body", "asleep": "asleep"}


def subject_for(look, wearing):
    """Her subject line in the new clothes: from the look's wardrobe template ("... wearing {wearing},
    glows softly against ..."), or by swapping the clothes in her subject line."""
    if look.get("wardrobe"):
        return look["wardrobe"].replace("{wearing}", wearing.strip().rstrip("."))
    subject = look.get("subject", "")
    m = re.search(r"wearing (.+?)(, (?:glows|softly|against|her|in |standing|holding))", subject)
    if m:
        return subject[:m.start(1)] + wearing + subject[m.end(1):]
    return re.sub(r",? against a", f", wearing {wearing}, against a", subject, count=1)


def run(choom, look_id, source, prompt, count=3, seed=31, log=print):
    """Render `count` versions with Klein from the picture `source` (in clean/); returns their file
    names, saved in clean/drafts/ as <choom>_<look>_<n>.png."""
    settings_file = WAN2GP / "settings" / "flux2_klein_9b_settings.json"
    settings = json.loads(settings_file.read_text()) if settings_file.exists() else {}
    settings.update({"model_type": CFG["picture_model"], "prompt": prompt, "video_prompt_type": "KI",
                     "image_refs": [str(PICTURES / source)], "resolution": "1440x1920", "num_inference_steps": 4,
                     "seed": int(seed), "repeat_generation": int(count), "image_mode": 1})
    slug = look_id.replace("@", "_")
    out = DRAFTS / f"run_{choom}_{slug}_{time.strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "settings.json").write_text(json.dumps(settings, indent=1))
    with open(out / "wan2gp.log", "w") as wlog:
        proc = subprocess.Popen([str(WAN2GP_PYTHON), "wgp.py", "--process", str(out / "settings.json"),
                                 "--output-dir", str(out)], cwd=WAN2GP, stdout=wlog, stderr=subprocess.STDOUT,
                                start_new_session=True)
        code = proc.wait()
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


def adopt(proj, look_id, draft, wearing=None, prompt=None):
    """Make a draft picture a look: copied into clean/ as <choom>_<outfit>_1.png, with its subject line
    in the new clothes and the base look's keep line and ending."""
    if look_id in proj.looks and not proj.looks[look_id].get("picture"):
        # A look waiting for its picture (a new Choom's main): just give it the chosen one.
        target = PICTURES / f"{proj.id}_{look_id}_1.png"
        shutil.copy2(PICTURES / draft, target)
        proj.looks[look_id]["picture"] = target.name
        if prompt:
            proj.looks[look_id]["klein"] = prompt
        proj.data.get("drafts", {}).pop(look_id, None)
        return proj.looks[look_id]
    base = proj.looks.get(base_of(look_id), {}) if look_id not in ("full", "asleep") else proj.looks.get("main", {})
    if look_id in ("full", "asleep"):
        target = PICTURES / f"{proj.id}_{look_id}_1.png"
        n = 1
        while target.exists():
            n += 1
            target = PICTURES / f"{proj.id}_{look_id}_{n}.png"
        shutil.copy2(PICTURES / draft, target)
        subject = (subject_for(base, wearing) if wearing else base.get("subject", "")).rstrip(". ")
        proj.looks[look_id] = {
            "picture": target.name,
            "subject": subject + (", standing with her whole body in view" if look_id == "full" else ""),
            "ending": ("She stays in the same place and ends exactly as she began, facing the viewer, her whole body in view."
                       if look_id == "full" else "She stays in the same place and pose and ends exactly as she began."),
            **({"keep": base["keep"]} if base.get("keep") else {}),
            **({"klein": prompt} if prompt else {}),
        }
        proj.data.get("drafts", {}).pop(look_id, None)
        return proj.looks[look_id]
    outfit = outfit_of(look_id) or look_id
    n = 1
    while (PICTURES / f"{proj.id}_{outfit}_{n}.png").exists():
        n += 1
    target = PICTURES / f"{proj.id}_{outfit}_{n}.png"
    shutil.copy2(PICTURES / draft, target)
    proj.looks[look_id] = {
        "picture": target.name,
        "subject": subject_for(base, wearing) if wearing else base.get("subject", ""),
        "ending": base.get("ending", ""),
        **({"keep": base["keep"]} if base.get("keep") else {}),
        **({"wearing": wearing} if wearing else {}),
        **({"klein": prompt} if prompt else {}),
    }
    proj.data.get("drafts", {}).pop(look_id, None)
    return proj.looks[look_id]
