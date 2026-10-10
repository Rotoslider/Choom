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
    "pajamas": {"pajamas", "pyjamas", "pjs", "nightgown", "nightie", "sleepwear"},
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
WHEN = ("evening", "cold", "hot", "day")

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
MOVE_NAMES = {
    "hairflip": "hair flip", "backturn": "turn your back", "slowdance": "slow dance", "happydance": "victory dance",
    "taichi": "tai chi", "lookback": "look back", "lookaround": "look around", "blowkiss": "blow a kiss",
    "pose": "strike a pose", "toss": "hair toss", "heart": "heart hands", "hair": "play with your hair",
}
MOVE_FRESH_S = 180  # a move she asked for plays within three minutes, or not at all


def words(text):
    return [w for w in re.findall(r"[a-z]+", (text or "").lower()) if w not in STOP]


def canon(tokens):
    """Each word, plus the garment and colour family it belongs to."""
    out = set()
    for w in tokens:
        out.add(w)
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
    m = re.search(r"\bwearing ([^,]+)", subject or "")
    return m.group(1).strip() if m else changes(subject, main_subject)


def changes(subject, main_subject):
    """The parts of a look's subject line that aren't in her main one (Optic without her heart:
    "leaning slightly forward with her empty hands loosely clasped in front of her")."""
    if not main_subject:
        return ""
    main = {s.strip() for s in main_subject.split(",")}
    return ", ".join(s.strip() for s in (subject or "").split(",")[1:]
                     if s.strip() not in main and "background" not in s)


def default_tags(look_id, subject, main_subject=""):
    """Closet words for a look: its garments, colours and materials, and its name."""
    tokens = words(wearing(subject, main_subject))
    tags = [w for w in tokens if w in GARMENT_OF or w in COLOR_OF or w in MATCH_EXTRA]
    tags += [GARMENT_OF[w] for w in tokens if w in GARMENT_OF] + [COLOR_OF[w] for w in tokens if w in COLOR_OF]
    outfit = look_id.split("@")[1] if "@" in look_id else look_id
    tags += [w for w in name_words(outfit) if w]
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


def moves(cid, alive, closet):
    """{move: [clip sources]}: her selfie moves and full-body clips, clips named for a move she could
    ask for (a dance, a wave, a kiss), and any clip the Studio gave words to."""
    extra = closet.get("moves", {})
    out = {}
    for c in alive.get("clips", []):
        src = c.get("source", "")
        word = move_word(cid, src)
        askable = "pose" in c.get("moods", []) or c.get("from") == "full" or word in MOVE_WORDS
        for w in ([word] if askable and word else []) + list(extra.get(Path(src).stem, [])):
            out.setdefault(w, []).append(src)
    return out


def move_name(word):
    return MOVE_NAMES.get(word, word)


# ---- Requests ----------------------------------------------------------------------------------
def match_move(request, available):
    """The moves a request asks for: [(word, sources)], best first (ties all kept), or []."""
    asked = set(words(request))
    scored = []
    for word, sources in available.items():
        keys = {word} | MOVE_KEYWORDS.get(word, set()) | set(words(move_name(word)))
        score = len(asked & keys) + (0.5 if word in asked else 0)  # its own name breaks a tie
        if score:
            scored.append((score, word, sources))
    if not scored:
        return []
    best = max(s for s, _, _ in scored)
    return [(w, srcs) for s, w, srcs in scored if s == best]


def match_outfit(request, available):
    """An outfit for a request: ("usual", None) for her usual clothes, (name, outfit), or None.
    A garment named must be in the outfit; colours and other words break ties; a tie is a coin toss."""
    asked = canon(words(request))
    if asked & USUAL:
        return ("usual", None)
    garments = asked & set(GARMENTS)
    colors = asked & set(COLORS)
    scored = []
    for name, o in available.items():
        has = canon(words(" ".join(o["tags"]) + " " + o.get("wearing", "") + " " + " ".join(name_words(name))))
        if garments and not garments & has:
            continue
        score = 10 * len(garments & has) + 3 * len(colors & has) + 2 * len((asked - garments - colors) & has)
        if score:
            scored.append((score, name))
    if not scored:
        return None
    best = max(s for s, _ in scored)
    name = random.choice([n for s, n in scored if s == best])
    return (name, available[name])


def add_wish(portraits, cid, kind, what):
    """Note something she asked for and hasn't got, for the Studio's Plan page."""
    f = Path(portraits) / cid / "wishes.json"
    try:
        wishes = json.loads(f.read_text())
    except (OSError, ValueError):
        wishes = []
    same = next((w for w in wishes if w["kind"] == kind and w["what"].lower() == what.lower()), None)
    if same:
        same["times"] = same.get("times", 1) + 1
        same["last"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    else:
        wishes.append({"kind": kind, "what": what, "times": 1, "first": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "last": time.strftime("%Y-%m-%dT%H:%M:%S")})
    tmp = f.with_suffix(".part")
    tmp.write_text(json.dumps(wishes, indent=1))
    tmp.replace(f)
