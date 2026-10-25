"""What each of a Choom's clips is for, read from its name (<choom>_[<outfit>-]<action>.mp4): the
moods it can play in and the pose it starts and ends in. Shared by make_alive.py (which writes them
into alive.json for the page) and Glass Studio (which names the clips it plans so they land here).
"""
import json
import re
import sys
from pathlib import Path

# What each clip is for, from its name (<choom>_<action>.mp4): the moods it can play in (idle, talk,
# think, listen, greet) and the pose it starts and ends in. Facing the viewer with her mouth at rest
# suits talking; glances, breaths and laughs are for quiet moments; a transition moves between poses
# (Aloy lowering or raising her hand).
ROLES = {
    "base": (["idle", "talk", "think", "listen"], "main", "main"),
    "glance": (["idle"], "main", "main"),
    "glance2": (["idle"], "main", "main"),
    "breath": (["idle"], "main", "main"),
    "amused": (["idle"], "main", "main"),
    "beat": (["idle", "listen"], "main", "main"),
    "listen": (["listen", "talk"], "main", "main"),
    "bright": (["listen"], "main", "main"),
    "thinkup": (["think"], "main", "main"),
    "thinkdown": (["think"], "main", "main"),
    "lower": (["idle"], "main", "relaxed"),
    "raise": (["idle"], "relaxed", "main"),
    "relaxed": (["idle", "talk", "think", "listen"], "relaxed", "relaxed"),
    "relaxedlisten": (["listen", "talk"], "relaxed", "relaxed"),
    "relaxedamused": (["idle"], "relaxed", "relaxed"),
    "wave": (["greet"], "relaxed", "relaxed"),
    # Quiet-moment variety; the warm, facing-him ones also suit listening (and the long calm loop
    # suits talking too).
    "smile": (["idle", "listen"], "main", "main"),
    "hum": (["idle"], "main", "main"),
    "daydream": (["idle"], "main", "main"),
    "eyebrow": (["idle", "listen"], "main", "main"),
    "longcalm": (["idle", "talk", "listen"], "main", "main"),
    "orbwatch": (["idle"], "main", "main"),
    "scan": (["idle"], "main", "main"),
    "sway": (["idle"], "main", "main"),
    "smirk": (["idle", "listen"], "main", "main"),
    "tilt": (["idle", "listen"], "main", "main"),
    "relaxedhair": (["idle"], "relaxed", "relaxed"),
    "relaxedlongcalm": (["idle", "talk", "listen"], "relaxed", "relaxed"),
    "longcalm2": (["idle", "talk", "listen"], "main", "main"),
    "groove": (["idle"], "main", "main"),
    "heartglow": (["idle"], "main", "main"),
    "skycheck": (["idle"], "main", "main"),
    "giggle": (["idle"], "main", "main"),
    "relaxedgiggle": (["idle"], "relaxed", "relaxed"),
    "relaxedglance": (["idle"], "relaxed", "relaxed"),
    "fadeout": (["change"], "main", "main@plain"),              # Genesis's motes fade away (her plain look)
    "fadeout2": (["change"], "main", "main@plain"),
    "fadein": (["change"], "main@plain", "main"),               # ... and sparkle back on
    "fadein2": (["change"], "main@plain", "main"),
    "heartaway": (["change"], "main", "main@noheart"),          # Optic's heart dissolves away
    "heartaway2": (["change"], "main", "main@noheart"),
    "heartback": (["change"], "main@noheart", "main"),          # ... and glows back into her hands
    "heartback2": (["change"], "main@noheart", "main"),
    "picturelook": (["picture"], "main", "main"),               # looking at a picture beside her face
    "relaxedpicturelook": (["picture"], "relaxed", "relaxed"),
    "picturedown": (["picturedown"], "main", "main"),           # ... at one floating lower right
    "relaxedpicturedown": (["picturedown"], "relaxed", "relaxed"),
    "relaxedhum": (["idle"], "relaxed", "relaxed"),
    "relaxedthinkup": (["think", "idle"], "relaxed", "relaxed"),
    "relaxedsmile": (["idle", "listen"], "relaxed", "relaxed"),
    # "Look at me" moves, played with a selfie she has just made.
    "relaxedtoss": (["pose"], "relaxed", "relaxed"),
    "relaxedturn": (["pose"], "relaxed", "relaxed"),
    "relaxedpoint": (["pose"], "relaxed", "relaxed"),
    "relaxedhips": (["pose"], "relaxed", "relaxed"),
    "poseheart": (["pose"], "main", "main"),
    "posewink": (["pose"], "main", "main"),
    "posetilt": (["pose"], "main", "main"),
    "poseshimmy": (["pose"], "main", "main"),
    "posesparkle": (["pose"], "main", "main"),
    "posehair": (["pose"], "main", "main"),
    "poseuncross": (["pose"], "main", "main"),
    "posesmirk": (["pose"], "main", "main"),
    # Full-body moves: another framing, so the page reaches them (and leaves them) with a camera cut.
    "fulltwirl": (["pose"], "full", "full"),
    "fullwave": (["pose"], "full", "full"),
    "fullpose": (["pose"], "full", "full"),
    "fullspin": (["pose"], "full", "full"),
    # Yawns, for late evening and early morning.
    "yawn": (["yawn"], "main", "main"),
    "relaxedyawn": (["yawn"], "relaxed", "relaxed"),
    # Expressions, played once when what was said feels that way.
    "happy": (["happy"], "main", "main"),
    "surprised": (["surprised"], "main", "main"),
    "sad": (["sad"], "main", "main"),
    "concerned": (["concerned"], "main", "main"),
    "relaxedhappy": (["happy"], "relaxed", "relaxed"),  # in a relaxed pose (Aloy's outfits are all hand-down)
    "relaxedsurprised": (["surprised"], "relaxed", "relaxed"),
    "relaxedsad": (["sad"], "relaxed", "relaxed"),
    "relaxedconcerned": (["concerned"], "relaxed", "relaxed"),
    # Sleep: dozing off, sleeping, waking (Aloy sleeps with her hand down), and Genesis's wind.
    "fallasleep": (["sleep"], "main", "asleep"),
    "sleep": (["sleep"], "asleep", "asleep"),
    "sleep2": (["sleep"], "asleep", "asleep"),
    "wake": (["wake"], "asleep", "main"),
    "windy": (["windy"], "main", "main"),
    "windy2": (["windy"], "main", "main"),
}


# Her home pose: the one she falls asleep from, wakes into and changes clothes in. "main" unless her
# Studio project says otherwise ("home": Aloy's is "relaxed", hand down). The Studio and the build
# pass it; home_pose() reads it from her project for anything that doesn't.
_projects = {}


def _project(cid):
    """Her Studio project's home pose and places, read again only when the file changes."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio"))
        from config import PROJECTS  # stdlib only; works under any of the Pythons the tools run in
        f = PROJECTS / f"{cid}.json"
        stamp = f.stat().st_mtime
        if _projects.get(cid, (None,))[0] != stamp:
            data = json.loads(f.read_text())
            places = {look: spec.get("from") or "full" for look, spec in data.get("looks", {}).items()
                      if "@" not in look and look not in POSES}
            _projects[cid] = (stamp, data.get("home") or "main", places)
        return _projects[cid][1:]
    except Exception:
        return "main", {}


def home_pose(cid):
    return _project(cid)[0]


# Poses every Choom may have; any other look of hers without an outfit is a place she goes to and
# stays a while (Genesis's campfire: sitting on the ground by a fire), reached from her full body (its
# look's "from") by a clip that sits her down. "gone" is the empty glass she walks off into and on from.
# Her seats at the campfire circle (circle, circleside; closet.SEATS) get their roles the same way, but
# have no clips to get there: the glass cuts to them (living.js seatClip).
POSES = ("main", "relaxed", "full", "asleep", "gone")


def places(cid):
    """{place: the pose she gets there from}, from her Studio project: {"campfire": "full"}."""
    return _project(cid)[1]


# Clips between her and the empty glass, named by kind (walkoff, walkon2, vanish_motes): walking out of
# her full-body frame and back in, or (waist-up) vanishing and appearing, Genesis's motes scattering and
# gathering. The glass plays them on a quiet turn: the one leaving walks off, the next one walks on.
# Each kind: the frame she's in, and whether she leaves it (else she comes into it).
GONE = {"walkoff": ("full", True), "walkon": ("full", False), "vanish": ("main", True), "appear": ("main", False)}


# Clips named by kind rather than listed one by one: <kind>_<what she does>.
KINDS = {
    "idle": (["idle"], "main", "main"),           # a quiet moment in her picture's pose
    "listen": (["idle", "listen"], "main", "main"),
    "relaxed": (["idle"], "relaxed", "relaxed"),  # a quiet moment with her hand down (Aloy)
    "talk": (["talk", "listen", "idle"], "main", "main"),            # a calm loop to talk over (lip sync)
    "relaxedtalk": (["talk", "listen", "idle"], "relaxed", "relaxed"),
    "full": (["idle"], "full", "full"),           # the glass cuts to her whole figure for a moment
    "pose": (["pose"], "main", "main"),           # a "look at me" move for a selfie
    "oops": (["oops"], "main", "main"),           # a face at her own mishap (a tool failed)
    "relaxedoops": (["oops"], "relaxed", "relaxed"),
    "fullpose": (["pose"], "full", "full"),
    "relaxedlisten": (["idle", "listen"], "relaxed", "relaxed"),
    "relaxedpose": (["pose"], "relaxed", "relaxed"),
    "windy": (["windy"], "main", "main"),         # her hair in the wind, on windy days only
    "relaxedwindy": (["windy"], "relaxed", "relaxed"),
}


# A change of clothes on screen: <choom>_[<from>-]change_<to>[_<what>], "usual" for her usual
# clothes (genesis_eveningdress-change_night_slip: the burgundy dress to her night look). The glass
# plays it instead of the camera cut when she changes from one to the other. fullchange_ is the same in
# her whole figure, for a change that needs her feet in the frame (a nightie slipping to the floor):
# full@nightwarm to full@<the other outfit>, cut to and back from like her other full-body clips.
CHANGE = re.compile(r"(full)?change_([a-z0-9]+)(?:_[a-z0-9]+)?")


def clip_role(cid, src, home=None):
    """(moods, pose it starts in, pose it ends in) from the clip's name, <choom>_[<outfit>-]<action>.
    Clips in other clothes (evening-relaxed, cold-relaxed_glance, dayspandex-full_sway, night-sleep)
    live in poses of their own (relaxed@evening, full@dayspandex, asleep@night); the page changes her
    clothes with a camera cut, or a change clip. `home` is her home pose (home_pose() if not given)."""
    home = home or home_pose(cid)
    action = Path(src).stem.removeprefix(f"{cid}_")
    outfit = None
    if "-" in action:
        outfit, action = action.split("-", 1)
    change = CHANGE.fullmatch(action)
    if change:
        frame, to = "full" if change.group(1) else home, change.group(2)
        return ["change"], f"{frame}@{outfit}" if outfit else frame, frame if to == "usual" else f"{frame}@{to}"
    kind = action.split("_")[0] if "_" in action else None
    gone = GONE.get(re.sub(r"\d+$", "", action.split("_")[0]))
    if gone and not outfit:
        frame = home if gone[0] == "main" else gone[0]  # Aloy vanishes and appears with her hand down
        start, end = (frame, "gone") if gone[1] else ("gone", frame)
        return ["go"], start, end
    spots = places(cid)
    place = action.split("_")[1] if kind in ("to", "from") and len(action.split("_")) > 1 else None
    if place in spots and not outfit:
        # Getting there and back: to_campfire sits her down from her full body, from_campfire gets her up.
        return ["go"], spots[place] if kind == "to" else place, place if kind == "to" else spots[place]
    stem = re.sub(r"\d+$", "", action.split("_")[0])
    if not outfit and (stem in spots or stem.removesuffix("listen") in spots):
        # Her loop there (campfire: she can talk in it), listening there, and quiet moments there.
        place = stem if stem in spots else stem.removesuffix("listen")
        if stem != place:
            return ["listen", "talk"], place, place
        return (["idle", "talk", "think", "listen"] if action == stem or re.fullmatch(stem + r"\d+", action)
                else ["idle"]), place, place
    moods, start, end = ROLES.get(action) or KINDS.get(kind) or ROLES["base"]
    if action in ("fallasleep", "wake") and home != "main":
        start, end = [home if pose == "main" else pose for pose in (start, end)]
    if outfit:
        start, end = [f"{pose}@{outfit}" if pose in ("main", "relaxed", "full", "asleep") else pose for pose in (start, end)]
    return moods, start, end
