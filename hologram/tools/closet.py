"""A Choom's closet on the glass: the outfits and moves she can ask for, and how a request finds one.

The Chooms ask the glass for things themselves (the looking-glass skill in the Choom app):
glass_move("a little dance"), glass_wear("my red dress"), glass_closet(). The hologram's server
answers from what is built on the glass (alive.json) and from portraits/<id>/closet.json, which
Glass Studio writes: each outfit's closet words ("dress", "burgundy") and what she wears in it, and
any extra words for a clip. A request is matched loosely, by garment and colour for clothes and by
the name of the move, so "the red dress" finds a burgundy one; something she hasn't got becomes a
wish in portraits/<id>/wishes.json, which the Studio shows on its Plan page.

Shared by server.py (answering) and Glass Studio (default closet words, writing closet.json).
"""
import json
import os
import random
import re
import time
from pathlib import Path

# Garments, by the word the closet uses for them. A request that names a garment only matches an
# outfit with that garment.
GARMENTS = {
    "dress": {"dress", "dresses", "gown", "sundress", "frock"},
    "sweater": {"sweater", "jumper", "knit", "pullover", "cardigan", "turtleneck"},
    "top": {"top", "tank", "camisole", "cami", "halter"},
    "shirt": {"shirt", "blouse", "tee", "flannel"},
    "jacket": {"jacket", "blazer", "bomber", "windbreaker"},
    "coat": {"coat", "parka", "trench", "overcoat"},
    "hoodie": {"hoodie", "hoody", "sweatshirt"},
    "jeans": {"jeans"},
    "pants": {"pants", "trousers", "slacks", "leggings"},
    "skirt": {"skirt"},
    "shorts": {"shorts"},
    "pajamas": {"pajamas", "pajama", "pyjamas", "pjs", "jammies", "nightgown", "nightie", "nightdress", "nightshirt",
                "sleepwear", "nightwear"},
    "lingerie": {"lingerie", "teddy", "negligee", "babydoll", "bodysuit", "chemise"},
    "swimsuit": {"swimsuit", "bikini", "swimwear"},
    "overalls": {"overalls", "dungarees"},
    "robe": {"robe", "kimono"},
}
# Colours by family, so "red" finds burgundy and "blue" finds denim.
COLORS = {
    "red": {"red", "burgundy", "crimson", "maroon", "wine", "scarlet", "cherry", "ruby"},
    "pink": {"pink", "rose", "blush", "magenta", "fuchsia"},
    "orange": {"orange", "coral", "peach", "rust", "amber"},
    "yellow": {"yellow", "gold", "golden", "mustard"},
    "green": {"green", "olive", "emerald", "sage", "mint"},
    "blue": {"blue", "navy", "denim", "turquoise", "azure", "teal"},
    "purple": {"purple", "violet", "lavender", "lilac", "plum", "mauve"},
    "white": {"white", "cream", "ivory"},
    "black": {"black", "charcoal"},
    "gray": {"gray", "grey", "silver"},
    "brown": {"brown", "tan", "beige", "camel", "khaki"},
}
MATERIALS = {"denim", "knit", "wool", "lace", "leather", "silk", "satin", "velvet", "linen", "cotton", "sequin",
             "sequins", "cable", "flannel"}
MATCH_EXTRA = MATERIALS | {"long", "short", "strappy", "sleeveless"}  # also kept as closet words
GARMENT_OF = {w: g for g, words in GARMENTS.items() for w in words}
COLOR_OF = {w: c for c, words in COLORS.items() for w in words}
USUAL = {"usual", "normal", "regular", "default", "everyday", "original", "own"}
STOP = {"a", "an", "the", "my", "your", "her", "some", "on", "in", "into", "with", "wear", "wearing", "put", "change",
        "outfit", "clothes", "please", "little", "i", "want", "to", "me", "something", "one", "that", "this", "for",
        "do", "of", "and", "again", "now", "bit", "quick", "just", "go", "get", "dressed"}
# An outfit's name says when she wears it (living.js OUTFIT_RULES); the rest is its own name.
WHEN = ("evening", "cold", "hot", "day", "night")
# Asking for something to sleep in finds her night clothes (their name starts with night).
NIGHT_WORDS = {"night", "nighttime", "bed", "bedtime", "sleep", "sleeping"}

# Clip actions a Choom may ask for even though they aren't selfie moves or full-body clips.
MOVE_WORDS = {"dance", "groove", "twirl", "spin", "wave", "kiss", "blowkiss", "wink", "curtsy", "bow", "stretch",
              "stretches", "hairflip", "hop", "jump", "backturn", "runway", "ballet", "celebrate", "taichi",
              "shimmy", "shrug", "clap", "salute", "slowdance", "happydance"}
# Words that also call up a move, besides its own name.
MOVE_KEYWORDS = {
    "twirl": {"spin", "pirouette", "whirl"},
    "spin": {"twirl", "whirl"},
    "dance": {"groove", "boogie", "dancing"},
    "groove": {"dance", "dancing"},
    "slowdance": {"slow", "dance", "sway"},
    "happydance": {"victory", "happy", "dance", "celebrate"},
    "wave": {"hello", "hi", "bye", "goodbye", "waving"},
    "kiss": {"blow", "smooch", "blowkiss"},
    "blowkiss": {"blow", "kiss", "smooch"},
    "curtsy": {"bow", "curtsey"},
    "bow": {"curtsy"},
    "stretch": {"stretches", "stretching"},
    "stretches": {"stretch", "stretching"},
    "hairflip": {"hair", "flip", "toss"},
    "toss": {"hair", "flip", "hairflip"},
    "backturn": {"back", "behind"},
    "turn": {"show"},
    "runway": {"catwalk", "model", "strut"},
    "ballet": {"ballerina", "pirouette"},
    "celebrate": {"cheer", "yay", "hooray", "celebration"},
    "taichi": {"tai", "chi"},
    "hop": {"jump", "bounce"},
    "heart": {"hands", "love"},
}
# Each move as something she does, so the glass's answer reads right: "On the glass you blow a kiss ..."
# (it said "you kiss", "you arms", "you model"). A move not listed keeps its own word.
MOVE_NAMES = {
    "arms": "fold your arms", "backturn": "turn and show your back", "ballet": "do a ballet move",
    "blowkiss": "blow a kiss", "bounce": "bounce on your toes", "clap": "clap your hands", "dance": "dance",
    "groove": "groove to the music", "hair": "play with your hair", "hairflick": "flick your hair",
    "hairflip": "flip your hair", "happydance": "do a victory dance", "heart": "make heart hands",
    "hips": "put your hands on your hips", "hop": "hop", "kiss": "blow a kiss", "lookaround": "look around",
    "lookback": "look back over your shoulder", "model": "strike a model pose", "point": "point",
    "pose": "strike a pose", "runway": "walk the runway", "slowdance": "slow dance", "spin": "spin around",
    "step": "take a step", "stretch": "stretch", "stretches": "stretch", "taichi": "do some tai chi",
    "tilt": "tilt your head", "toss": "toss your hair", "turn": "turn around", "uncross": "uncross your arms",
}
# Words in a place's description that say nothing about it ("... looking up at the viewer").
PLACE_FILLER = {"viewer", "looking", "toward", "towards", "beside", "small", "held", "drawn", "their", "while", "whole"}
MOVE_FRESH_S = 180  # a move she asked for plays within three minutes, or not at all


def words(text):
    return [w for w in re.findall(r"[a-z]+", (text or "").lower()) if w not in STOP]


def canon(tokens):
    """Each word, plus the garment and colour family it belongs to."""
    out = set()
    for w in tokens:
        out.add(w)
        if w in NIGHT_WORDS:
            out.add("night")
        if w in GARMENT_OF:
            out.add(GARMENT_OF[w])
        if w in COLOR_OF:
            out.add(COLOR_OF[w])
    return out


def name_words(outfit):
    """evening, dress from "eveningdress"; day, denim from "daydenim"."""
    for when in WHEN:
        if outfit.startswith(when) and outfit != when:
            return [when, outfit[len(when):]]
    return [outfit]


def wearing(subject, main_subject=""):
    """What she wears in a look, from its subject line: "a long burgundy dress with thin straps". A
    look without a "wearing" phrase (Genesis without her motes) is the part of its subject that isn't
    in her main one: "natural skin, a delicate necklace and a dark top with thin straps"."""
    # Up to where the scene starts (", against a plain pure black background", ", glows softly"), not the
    # first comma: "a long, soft ivory cotton nightgown" came back as "a long". A new Choom's subject goes
    # on with ", glowing softly against".
    m = re.search(r"\bwearing (.+?)(?:, (?:glows|glowing|softly|against|in clean|in soft|her |standing|holding)|$)", subject or "")
    return m.group(1).strip().rstrip(",. ") if m else changes(subject, main_subject)


def changes(subject, main_subject):
    """The parts of a look's subject line that aren't in her main one: what a look without a
    "wearing" phrase has instead (Genesis without her motes: "natural skin")."""
    if not main_subject:
        return ""
    main = {s.strip() for s in main_subject.split(",")}
    return ", ".join(s.strip() for s in (subject or "").split(",")[1:]
                     if s.strip() not in main and "background" not in s)


# Something she holds in a subject line, and where: "holding a glowing fire agate heart in front of her".
HELD = re.compile(r"^(?:holding|carrying|cradling|clutching|with)\s+(.+?)"
                  r"(?:\s+(?:in front of her|in (?:both )?her hands?|close to her chest|against her chest|beside her))?$")


def same_clothes(subject, main_subject):
    """What a look in her usual clothes, changed some other way, is in her closet. What she holds in her
    main look and not here is named ("your usual clothes, without a glowing fire agate heart"), and
    so is clothing added here. A pose isn't clothes, so it stays out: listing Optic's heart-aside
    look as "leaning slightly forward with her empty hands loosely clasped" told her nothing she
    could wear."""
    def parts(s):
        return [p.strip() for p in (s or "").split(",")[1:] if p.strip() and "background" not in p]
    look, main = parts(subject), parts(main_subject)
    gone = [m.group(1) for p in main if p not in look and (m := HELD.match(p))]
    added = [p for p in look if p not in main and any(w in GARMENT_OF or w in COLOR_OF for w in words(p))]
    return ", ".join(["your usual clothes"] + [f"without {g}" for g in gone] + added)


def usual_clothes(closet, main_subject=""):
    """Her usual clothes as words a request can match (match_outfit's `usual`): closet.json's "usual"
    and what she holds in her main look (Optic's heart), or, when her usual look names no clothes
    (Genesis's motes), her main subject line without the person and the scene. Never her hair or eyes:
    "blue eyes" would have made Eve's usual dress "my blue dress"."""
    parts = [p.strip() for p in (main_subject or "").split(",")[1:]
             if p.strip() and "background" not in p and " light" not in p]
    held = [m.group(1) for p in parts if (m := HELD.match(p))]
    usual = (closet or {}).get("usual") or ", ".join(p for p in parts if not HELD.match(p))
    return ", ".join(t for t in [usual] + held if t)


def default_tags(look_id, subject, main_subject=""):
    """Closet words for a look: its garments, colours and materials, and its name."""
    tokens = words(wearing(subject, main_subject))
    tags = [w for w in tokens if w in GARMENT_OF or w in COLOR_OF or w in MATCH_EXTRA]
    tags += [GARMENT_OF[w] for w in tokens if w in GARMENT_OF] + [COLOR_OF[w] for w in tokens if w in COLOR_OF]
    outfit = look_id.split("@")[1] if "@" in look_id else look_id
    tags += [w for w in name_words(outfit) if w]
    if outfit.startswith("night"):
        tags.append("pajamas")  # "my pajamas" finds them, whatever they are (Eve's are a lace teddy)
    return sorted(set(tags))



# ---- What's on the glass ---------------------------------------------------------------------
def load(portraits, cid):
    """(alive.json, closet.json) for a Choom; either may be {}."""
    def read(name):
        try:
            return json.loads((Path(portraits) / cid / name).read_text())
        except (OSError, ValueError):
            return {}
    return read("alive.json"), read("closet.json")


def outfits(alive, closet):
    """The outfits she can wear on the glass: those with a loop she can talk over. {name: {tags, wearing}}"""
    names = sorted({c["from"].split("@")[1] for c in alive.get("clips", [])
                    if "@" in c.get("from", "") and "talk" in c.get("moods", [])})
    looks = closet.get("looks", {})
    return {o: {"tags": looks.get(o, {}).get("tags") or name_words(o), "wearing": looks.get(o, {}).get("wearing", "")}
            for o in names}


def move_word(cid, source):
    """The move a clip makes, from its name: twirl from genesis_fulltwirl.mp4, dance from
    genesis_evening-full_dance.mp4. None for a clip with no move in its name."""
    action = Path(source).stem.removeprefix(f"{cid}_")
    if "-" in action:
        action = action.split("-", 1)[1]
    word = action.split("_", 1)[1] if "_" in action else re.sub(r"^(full|pose|relaxed)(?=[a-z])", "", action)
    return re.sub(r"\d+$", "", word) or None


def places(alive, closet):
    """{place: where she is and how}: her places (sitting by her campfire) that the glass can take her
    to, a clip there to get her there (to_campfire) built. From closet.json's "places"."""
    reachable = {c.get("to") for c in alive.get("clips", []) if c.get("moods") == ["go"]}
    return {p: does for p, does in closet.get("places", {}).items() if p in reachable}


def moves(cid, alive, closet):
    """{move: [clip sources]}: her selfie moves and full-body clips, clips named for a move she could
    ask for (a dance, a wave, a kiss), any clip the Studio gave words to, and her places (the clip that
    takes her to her campfire, under "campfire")."""
    extra = closet.get("moves", {})
    spots = places(alive, closet)
    out = {}
    for c in alive.get("clips", []):
        src = c.get("source", "")
        word = move_word(cid, src)
        if c.get("moods") == ["windy"]:
            continue  # weather, not a move: it plays on windy days only
        if c.get("moods") == ["go"]:
            if c.get("to") in spots:
                out.setdefault(c["to"], []).append(src)
            continue  # walking on and off the glass is for her turns on it, not to ask for
        askable = "pose" in c.get("moods", []) or c.get("from", "").split("@")[0] == "full" or word in MOVE_WORDS
        for w in ([word] if askable and word else []) + list(extra.get(Path(src).stem, [])):
            out.setdefault(w, []).append(src)
    return out


def move_name(word, spots=None):
    if spots and word in spots:
        return f"go to your {word}"
    return MOVE_NAMES.get(word, word)


def as_you(text):
    """A place's description said to her: "her knees drawn up" -> "your knees drawn up"."""
    return re.sub(r"\bshe\b", "you", re.sub(r"\bher\b", "your", text))


# ---- Requests ----------------------------------------------------------------------------------
def match_move(request, available, spots=None):
    """The moves a request asks for: [(word, sources)], best first (ties all kept), or []. spots: her
    places, found by the words of their description too ("sit by the fire" finds her campfire)."""
    asked = set(words(request))
    scored = []
    for word, sources in available.items():
        keys = {word} | MOVE_KEYWORDS.get(word, set()) | set(words(move_name(word)))
        if spots and word in spots:
            told = {w for w in words(spots[word]) if len(w) > 3 and w not in PLACE_FILLER}
            keys |= told | {"sit" for w in told if w.startswith("sit")} | {"fire" for w in told | {word} if "fire" in w}
        score = len(asked & keys) + (0.5 if word in asked else 0)  # its own name breaks a tie
        if score:
            scored.append((score, word, sources))
    if not scored:
        return []
    best = max(s for s, _, _ in scored)
    return [(w, srcs) for s, w, srcs in scored if s == best]


def match_outfit(request, available, warm=None, usual=""):
    """An outfit for a request: ("usual", None) for her usual clothes, (name, outfit), or None.
    A garment, colour or fabric named must be in the outfit: "a midnight-blue silk slip dress" isn't her
    dark green dress, it's a wish (Eve, 2026-10-14). Other words break ties; a tie between her warm
    and cold night clothes goes by the weather (`warm`: 70°F or more), a tie with her usual clothes goes
    to them, any other tie is a coin toss.

    `usual` describes her usual clothes (closet.json's "usual" and her main subject line), so they can be
    asked for like any outfit: "my wireframe dress" (Eve) and "my cream blouse" (Aloy) found other outfits
    before, and "my motes" (Genesis) became a wish. "Usual", "normal", "own" alone mean her usual clothes,
    but not beside a garment, colour or fabric: "my own green dress" is her green dress."""
    asked = canon(words(request))
    garments = asked & set(GARMENTS)
    colors = asked & set(COLORS)
    fabrics = asked & MATERIALS
    if asked & USUAL and not (garments or colors or fabrics):
        return ("usual", None)
    candidates = dict(available, **({"usual": {"tags": [], "wearing": usual}} if usual.strip() else {}))
    scored = []
    for name, o in candidates.items():
        has = canon(words(" ".join(o["tags"]) + " " + o.get("wearing", "") + " " + " ".join(name_words(name))))
        if any(named and not named & has for named in (garments, colors, fabrics)):
            continue
        score = 10 * len(garments & has) + 3 * len(colors & has) + 2 * len((asked - garments - colors) & has)
        if score:
            scored.append((score, name))
    if not scored:
        return None
    best = max(s for s, _ in scored)
    tied = [n for s, n in scored if s == best]
    if "usual" in tied:  # "my mint tee": her usual tee, not the tee under her cold-day jacket
        return ("usual", None)
    if warm is not None:
        tied = [n for n in tied if ("warm" if warm else "cold") in n] or tied
    name = random.choice(tied)
    return (name, available[name])


def read_wishes(f):
    """The wishes in a wishes.json, read so that a half-written file (the Studio letting one go at that
    moment) is read again rather than taken for none. A file that stays unreadable is kept beside it as
    wishes.json.unreadable-<time> instead of being written over."""
    for attempt in range(5):
        try:
            return json.loads(f.read_text())
        except FileNotFoundError:
            return []
        except (OSError, ValueError):
            time.sleep(0.1)
    try:
        f.replace(f.with_name(f"{f.name}.unreadable-{time.strftime('%Y%m%d-%H%M%S')}"))
    except OSError:
        pass
    return []


def add_wish(portraits, cid, kind, what):
    """Note something she asked for and hasn't got, for the Studio's Plan page. Written whole (a temp file
    swapped in), so nobody reading it sees half a file."""
    f = Path(portraits) / cid / "wishes.json"
    wishes = read_wishes(f)
    same = next((w for w in wishes if w["kind"] == kind and w["what"].lower() == what.lower()), None)
    if same:
        same["times"] = same.get("times", 1) + 1
        same["last"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    else:
        wishes.append({"kind": kind, "what": what, "times": 1, "first": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "last": time.strftime("%Y-%m-%dT%H:%M:%S")})
    tmp = f.with_name(f".{f.name}.{os.getpid()}.part")
    tmp.write_text(json.dumps(wishes, indent=1))
    tmp.replace(f)
