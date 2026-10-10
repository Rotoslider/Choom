"""What each of a Choom's clips is for, read from its name (<choom>_[<outfit>-]<action>.mp4): the
moods it can play in and the pose it starts and ends in. Shared by make_alive.py (which writes them
into alive.json for the page) and Glass Studio (which names the clips it plans so they land here).
"""
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
    # Expressions, played while she says something that feels that way.
    "happy": (["happy"], "main", "main"),
    "surprised": (["surprised"], "main", "main"),
    "sad": (["sad"], "main", "main"),
    "concerned": (["concerned"], "main", "main"),
    # Sleep: dozing off, sleeping, waking (Aloy sleeps with her hand down), and Genesis's wind.
    "fallasleep": (["sleep"], "main", "asleep"),
    "sleep": (["sleep"], "asleep", "asleep"),
    "sleep2": (["sleep"], "asleep", "asleep"),
    "wake": (["wake"], "asleep", "main"),
    "windy": (["windy"], "main", "main"),
    "windy2": (["windy"], "main", "main"),
}
AWAKE_POSE = {"aloy": "relaxed"}  # the pose a Choom falls asleep from and wakes into, if not "main"


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
}


def clip_role(cid, src):
    """(moods, pose it starts in, pose it ends in) from the clip's name, <choom>_[<outfit>-]<action>.
    Clips in other clothes (evening-relaxed, cold-relaxed_glance) live in poses of their own
    (relaxed@evening); the page changes her clothes with a camera cut."""
    action = Path(src).stem.removeprefix(f"{cid}_")
    outfit = None
    if "-" in action:
        outfit, action = action.split("-", 1)
    kind = action.split("_")[0] if "_" in action else None
    moods, start, end = ROLES.get(action) or KINDS.get(kind) or ROLES["base"]
    if action in ("fallasleep", "wake") and cid in AWAKE_POSE:
        start, end = [AWAKE_POSE[cid] if pose == "main" else pose for pose in (start, end)]
    if outfit:
        start, end = [f"{pose}@{outfit}" if pose in ("main", "relaxed") else pose for pose in (start, end)]
    return moods, start, end
