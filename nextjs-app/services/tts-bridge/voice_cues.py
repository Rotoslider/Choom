"""
Delivery cues: "[warm] You left the shop lights on again."

A Choom whose voice runs on Drama 3 may put a short cue in square brackets
before the words it colors (Fish Audio's syntax). Two jobs here:

filter_cues  — what Drama 3 gets. Donny listened to a test set on Nov 22 2026:
               sighs were overdone, whispering came out wonky, a deep breath
               was a bit much, and the long dramatic directions sounded fake;
               light ones ([warm], [teasing], [small laugh], [low, focused])
               were good. So cues with those words, cues over a few words, and
               any second cue in one sentence are dropped. Tunable with
               DRAMA3_BLOCKED_CUES / DRAMA3_CUE_MAX_WORDS / DRAMA3_CUES_PER_SENTENCE.
strip_cues   — what Chatterbox gets (it would read "[small laugh]" aloud),
               including every Drama 3 fallback.

A cue is lowercase letters (spaces, commas, apostrophes, hyphens allowed),
3-48 characters, not inside [[...]] and not followed by "(", "[" or ":" — so
markdown links, "[Eve]:" labels, "[PASS]" and "[1]" footnotes are never touched.
The same rule lives in nextjs-app/lib/voice-cues.ts and the Signal bridge's
tts_text.py; keep them in step.
"""
import os
import re

CUE = re.compile(r"(?<!\[)\[([a-z][a-z' ,\-]{2,47})\](?![(\[\]:])")
SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
MAX_CUE_WORDS_TO_RECOGNISE = 6

DEFAULT_BLOCKED = (
    "sigh", "whisper", "breath", "gasp", "yawn", "sob", "cry", "crie", "tear",
    "scream", "shout", "yell", "shak", "trembl", "barely", "chok", "pant",
    "moan", "groan", "sniff", "weep", "wail", "huff",
)


def _env_list(name, default):
    raw = os.getenv(name)
    if raw is None:
        return default
    return tuple(s.strip().lower() for s in raw.split(",") if s.strip())


def _env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


BLOCKED = _env_list("DRAMA3_BLOCKED_CUES", DEFAULT_BLOCKED)
MAX_WORDS = _env_int("DRAMA3_CUE_MAX_WORDS", 3)
PER_SENTENCE = _env_int("DRAMA3_CUES_PER_SENTENCE", 1)


def _words(inner):
    return [w for w in re.split(r"[\s,]+", inner.strip()) if w]


def _is_cue(match):
    return len(_words(match.group(1))) <= MAX_CUE_WORDS_TO_RECOGNISE


def _tidy(text):
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r" +([,.!?;:…])", r"\1", text)
    return re.sub(r"(^|\n) +", r"\1", text).strip()


def strip_cues(text: str) -> str:
    """Every cue out, for Chatterbox."""
    return _tidy(CUE.sub(lambda m: "" if _is_cue(m) else m.group(0), text))


def _allowed(inner, blocked, max_words):
    words = _words(inner.lower())
    if not words or len(words) > max_words:
        return False
    return not any(w.startswith(b) for w in words for b in blocked)


def filter_cues(text: str, blocked=None, max_words=None, per_sentence=None):
    """(text for Drama 3, cues dropped). Keeps the first allowed cue(s) of each sentence."""
    blocked = BLOCKED if blocked is None else blocked
    max_words = MAX_WORDS if max_words is None else max_words
    per_sentence = PER_SENTENCE if per_sentence is None else per_sentence
    dropped = []
    out = []
    for sentence in SENTENCE_END.split(text):
        kept = 0

        def keep_or_drop(m):
            nonlocal kept
            if not _is_cue(m):
                return m.group(0)
            if kept < per_sentence and _allowed(m.group(1), blocked, max_words):
                kept += 1
                return m.group(0)
            dropped.append(m.group(1))
            return ""

        out.append(CUE.sub(keep_or_drop, sentence))
    return _tidy(" ".join(out)), dropped
