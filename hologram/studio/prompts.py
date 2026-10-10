"""Clip prompts for MiniMax H3 (Wan2GP), written the way that works on the glass, and a checker for
the wording that doesn't.

A prompt is one locked-off shot: who she is in this look (the look's subject line, which says
"a plain pure black background"), what she does, the camera line, and how she ends. Loops end
exactly as they began, so the page can play her clips in any order.
"""
import re

# H3 takes 107 + 17k frames at 24 fps. Five seconds fail least; long clips (a dance, a slow turn, a
# moment that unfolds) drift more into new shots, halos or colour shifts, so check them closely.
SECONDS = {5: (124, "five"), 6: (141, "six"), 7: (175, "seven"), 10: (243, "ten"), 12: (294, "twelve"),
           15: (362, "fifteen")}
FRAMES_SECONDS = {frames: s for s, (frames, _) in SECONDS.items()}
CAMERA = "The camera stays locked off, framed exactly as at the start, and never zooms or pushes in."
SOUND = "overall_soundscape: Near silence, a soft room tone."
HEAD = re.compile(r"^(?:integrated_multimodal_description: )?\[Shot 1\] A (\w+)-second single take with a "
                  r"locked-off camera and no cuts\. (.*)\noverall_soundscape: .*$", re.S)


def build(subject, action, seconds=5, ending="", keep=""):
    """The full prompt for one clip. `ending` is the look's loop ending ("She stays in the same place
    and ends exactly as she began, facing the viewer.") or a transition's own last line; `keep` is a
    line the look says in every clip, before the action (Genesis: her motes stay on her)."""
    frames, word = SECONDS[seconds]
    parts = [f"[Shot 1] A {word}-second single take with a locked-off camera and no cuts.",
             subject.rstrip(". ") + "."] + ([keep.strip()] if keep else []) + [action.strip(), CAMERA]
    if ending:
        parts.append(ending.strip())
    return "integrated_multimodal_description: " + " ".join(parts) + "\n" + SOUND


def split(prompt):
    """(seconds word, subject, action, ending) of a prompt written in this shape, else None. The
    action is what lies between the subject and the camera line (or her closing "She stays..." line)."""
    m = HEAD.match(prompt)
    if not m:
        return None
    word, body = m.groups()
    subject, _, rest = body.partition(". ")
    ending = ""
    tail = re.search(r"\s*(She (?:keeps|stays)[^\n]*)$", rest)
    if tail:
        ending, rest = tail.group(1), rest[:tail.start()]
    rest = re.sub(r"\s*The camera [^.]*\.", "", rest)
    rest = re.sub(r"\s*,? ?and the background stays [^.]*\.", "", rest)
    return word, subject, rest.strip(), ending


# Wording that has gone wrong on the glass, with what to do instead (docs/reference.md).
LESSONS = [
    (r"\b(no|without|free of) (smoke|mist|fog|haze|glow|light effects?|particles)\b",
     "Names an effect you don't want; naming it brings it. Say what is there instead (a plain pure black background)."),
    (r"\b(breath|breathe|breathes|breathing|sigh|sighs|sighing|exhale|exhales|inhale|inhales|yawns? deeply)\b",
     "Breathing words can bring a cloud of fog. Describe what her face or shoulders do instead."),
    (r"\b(leans? (in|forward|closer)|studies (the viewer )?closely|peers? at|close-?up|moves? closer|steps? (toward|towards|closer))\b",
     "Draws the eye to her face, which makes the camera push in. Keep her where she is."),
    (r"\b(zoom|zooms|zooming|dolly|pans|panning|tracking shot|camera moves?)\b",
     "Camera wording outside the camera line invites a camera move."),
    (r"\b(walks? (away|off|out)|leaves the frame|turns? away and walks|exits?)\b",
     "She must stay in the frame and end where she began."),
]


def lint(prompt, loop=True):
    """Warnings for a prompt: [(problem, advice)]."""
    out = []
    body = prompt.split("\noverall_soundscape", 1)[0]
    camera_free = body.replace(CAMERA, "")
    for pattern, advice in LESSONS:
        m = re.search(pattern, camera_free, re.I)
        if m:
            out.append((m.group(0), advice))
    if "plain pure black background" not in body:
        out.append(("background", 'Say "a plain pure black background" in her subject line.'))
    if CAMERA not in body:
        out.append(("camera", f'End the action with the camera line: "{CAMERA}"'))
    if loop and "ends exactly as she began" not in body:
        out.append(("ending", 'A loop should end "exactly as she began", so it joins the next clip without a seam.'))
    return out
