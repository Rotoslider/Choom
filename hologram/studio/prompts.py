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


# A clip with pictures of its own (a mug she sips from) renders with H3's reference model, Ref2VA,
# which wants its prompt in six sections. On the page her look is picture 1 and the ones added are
# picture 2, 3 ... (as in New look); the model counts her start and end pictures first, so the added
# ones are its <Picture 3>, <Picture 4> ...: "the mug from picture 2" reaches it as "<Picture 3>".
MAX_REFS = 4
PICTURE = re.compile(r"\bpicture (\d+)\b", re.I)


def model_pictures(text, count):
    """His "picture N" (1 is her, 2.. the added ones) in the model's numbering."""
    def swap(m):
        n = int(m.group(1))
        return "<Picture 1>" if n == 1 else f"<Picture {n + 1}>" if 2 <= n <= count + 1 else m.group(0)
    return PICTURE.sub(swap, text)


def build_ref(subject, action, seconds=5, ending="", keep="", count=1):
    """The full prompt for one clip with `count` pictures of its own, for Ref2VA. Aloy's sip from a
    fox mug (2026-10-27): the mug came out as in its picture, words alone gave a generic one."""
    frames, word = SECONDS[seconds]
    added = [f"<Picture {n}>" for n in range(3, count + 3)]
    things = [f"<Subject {n}>" for n in range(2, count + 2)]
    shot = [f"[Shot 1] {subject.rstrip('. ')}."] + ([keep.strip()] if keep else []) + [
        model_pictures(action.strip(), count), CAMERA] + ([ending.strip()] if ending else []) + [
        f"By the last frame everything from {' and '.join(added)} is out of the frame again and she matches <Picture 2>."]
    lines = ["subject_definitions:",
             "<Subject 1> is the woman in <Picture 1>, preserving her exact identity, face, hair, clothing, "
             "accessories, framing and the plain pure black background around her."]
    lines += [f"{t} is what {p} shows, preserving its exact shape, colours, materials, pattern and markings."
              for t, p in zip(things, added)]
    lines += ["summary:",
              f"[reference generation] A {word}-second loop of <Subject 1> with {' and '.join(things)}, beginning "
              "exactly on <Picture 1> and ending exactly on <Picture 2>.",
              "retention_analysis:",
              "<Subject 1> (appears in [Shot 1]): fully_preserved - her identity, face, hair, clothing and framing "
              "stay exactly as in <Picture 1>; only her movement is new."]
    lines += [f"{t} (appears in [Shot 1]): fully_preserved - kept exactly as in {p}, at a natural size with her."
              for t, p in zip(things, added)]
    lines += ["detailed_description:",
              f"The target video is a {word}-second single take with a locked-off camera and no cuts; <Picture 1> is "
              "its first frame and <Picture 2> its last frame. " + " ".join(shot),
              SOUND, "non_diegetic_music: N/A"]
    return "\n".join(lines)


def lint_refs(action, count):
    """Warnings for the wording of a clip with pictures: [(problem, advice)]."""
    named = [int(n) for n in PICTURE.findall(action)]
    if not named:
        return [("pictures", 'Say which picture holds what: "the mug from picture 2" (picture 1 is her).')]
    over = [n for n in named if n > count + 1]
    if over:
        return [(f"picture {over[0]}", f"There {'is' if count == 1 else 'are'} only {count} added: picture 2"
                 + (f" to {count + 1}" if count > 1 else "") + ".")]
    return []


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


def lint(prompt, loop=True, leaves=False):
    """Warnings for a prompt: [(problem, advice)]. leaves: a clip on or off the empty glass, where she
    does walk out of the frame (or in)."""
    out = []
    body = prompt.split("\noverall_soundscape", 1)[0]
    camera_free = body.replace(CAMERA, "")
    for pattern, advice in LESSONS:
        if leaves and pattern == LESSONS[-1][0]:
            continue
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
