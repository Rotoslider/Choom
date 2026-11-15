"""The video models a clip can be rendered with (models.json beside this file).

Every clip records the model it's planned with ("model": an id from models.json). New clips and re-rolls
take the Studio's default (studio.json "clip_model", set from the page's Model menu); a planned clip can
be switched before it renders. A clip from before models could be chosen has none: it was made with H3.
A render queues each clip on its own model's Wan2GP model type, the clip's own pictures sending it to
the model's reference type, and Wan2GP loads each model once (render.make_queue).

Models that are Wan2GP finetunes keep their definitions in finetunes/ here; install() copies them into
Wan2GP's finetunes folder before a render needs them, because Wan2GP falls back to a task's base model
type when it doesn't know its model type (a finetune missing would render with something else). Their
weights must be in Wan2GP's ckpts folder first (download() fetches them; a render inside Wan2GP would
otherwise spend its first clip on a 40 GB download), and files made from them (10Eros-Max's PDD heads,
pdd_heads.py) are made the first time.
"""
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from config import CFG, CONFIG_DIR, CONFIG_FILE, WAN2GP, WAN2GP_PYTHON

HERE = Path(__file__).resolve().parent
REGISTRY = HERE / "models.json"
FINETUNES = HERE / "finetunes"
LEGACY = "h3"  # what made the clips rendered before a clip recorded its model


def all_models():
    """[{id, name, short, about, clip, reference, ...}], H3's types as studio.json may override them."""
    models = json.loads(REGISTRY.read_text())["models"]
    for m in models:
        if m["id"] == "h3":
            m["clip"], m["reference"] = CFG["video_model"], CFG["reference_model"]
    return models


def ids():
    return [m["id"] for m in all_models()]


def get(mid):
    found = next((m for m in all_models() if m["id"] == mid), None)
    if not found:
        raise ValueError(f"no model {mid!r} (models.json has {', '.join(ids())})")
    return found


def default():
    """The model new clips and re-rolls are planned with."""
    mid = CFG.get("clip_model") or LEGACY
    return mid if mid in ids() else LEGACY


def set_default(mid):
    """The Studio's default model, kept in studio.json beside its other settings."""
    get(mid)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    saved = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else {}
    saved["clip_model"] = mid
    part = CONFIG_FILE.with_name(CONFIG_FILE.name + ".part")
    part.write_text(json.dumps(saved, indent=2) + "\n")
    os.replace(part, CONFIG_FILE)
    CFG["clip_model"] = mid


def of(clip):
    """The model a clip renders with (planned, queued) or was made with (rendered and after)."""
    if clip.get("model"):
        return clip["model"]
    return default() if clip.get("status") in ("planned", "queued") else LEGACY


def wan_type(mid, reference=False):
    """Wan2GP's model type for a clip on this model: its reference type for a clip with pictures."""
    m = get(mid)
    return m["reference"] if reference else m["clip"]


def minutes(frames, mid=None):
    """Rendering time of a clip of `frames` frames on a model, in minutes."""
    per = get(mid or default()).get("minutes_per_clip") or CFG["minutes_per_clip"]
    return per * frames / 124


CKPTS = WAN2GP / "ckpts"


def missing_weights(mid):
    """[{file, gb, ...}] of the model's weights not in Wan2GP's ckpts folder yet."""
    return [w for w in get(mid).get("weights", []) if not (CKPTS / w["file"]).is_file()]


def download(mid, log=print):
    """Fetch the model's missing weights into Wan2GP's ckpts folder (resuming a broken download), check
    their size and sha256, then install it. curl, so it needs nothing but the URL."""
    m = get(mid)
    for w in missing_weights(mid):
        dst = CKPTS / w["file"]
        part = dst.with_name(dst.name + ".part")
        log(f"{m['name']}: downloading {w['file']} ({w.get('gb', '?')} GB) from {w['url']}")
        subprocess.run(["curl", "-L", "--fail", "-C", "-", "-o", str(part), w["url"]], check=True)
        if w.get("bytes") and part.stat().st_size != w["bytes"]:
            raise ValueError(f"{w['file']}: {part.stat().st_size} bytes, expected {w['bytes']} (run it again to resume)")
        if w.get("sha256"):
            log("checking its sha256…")
            h = hashlib.sha256()
            with part.open("rb") as f:
                for chunk in iter(lambda: f.read(1 << 24), b""):
                    h.update(chunk)
            if h.hexdigest() != w["sha256"]:
                part.unlink()
                raise ValueError(f"{w['file']}: sha256 {h.hexdigest()} doesn't match; the download was deleted")
        part.replace(dst)
        log(f"{w['file']}: done")
    return install(mid, log)


def install(mid, log=print):
    """Ready the model for a render: its weights must be there (else ValueError, saying how to fetch them);
    files made from them are made if missing; its finetune definitions are copied into Wan2GP (new or
    changed ones). Returns the definitions copied."""
    m = get(mid)
    missing = missing_weights(mid)
    if missing:
        raise ValueError(f"{m['name']} isn't on this machine yet: its weights ({round(sum(w.get('gb', 0) for w in missing), 1)} GB) "
                         f"download with  python3 studio/studio.py models --download {mid}")
    for d in m.get("derived", []):
        dst = CKPTS / d["file"]
        if dst.is_file():
            continue
        log(f"{m['name']}: making {d['file']} from {d['from']}")
        proc = subprocess.run([str(WAN2GP_PYTHON), str(HERE / d["tool"]), str(CKPTS / d["from"]), str(dst)],
                              capture_output=True, text=True)
        if proc.returncode or not dst.is_file():
            raise ValueError(f"{d['tool']} failed: {(proc.stderr or proc.stdout).strip()[-400:]}")
    copied = []
    for name in get(mid).get("finetunes", []):
        src, dst = FINETUNES / f"{name}.json", WAN2GP / "finetunes" / f"{name}.json"
        if not src.is_file():
            raise ValueError(f"model {mid}: its Wan2GP definition {src.name} is missing from {FINETUNES}")
        if dst.is_file() and dst.read_bytes() == src.read_bytes():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        copied.append(name)
    return copied


def public():
    """What the page shows: every model, the default, and what each still has to download."""
    out = []
    for m in all_models():
        missing = missing_weights(m["id"])
        out.append({"id": m["id"], "name": m["name"], "short": m.get("short", m["name"]), "about": m.get("about", ""),
                    "source": m.get("source", ""), "minutesPerClip": m.get("minutes_per_clip") or CFG["minutes_per_clip"],
                    "download": round(sum(w.get("gb", 0) for w in missing), 1) if missing else 0})
    return {"models": out, "default": default()}
