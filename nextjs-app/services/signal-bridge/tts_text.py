"""
Markup stripping for text that is about to be spoken.

Shared by replies (bridge.py) and scheduled / wake-up messages
(scheduler.send_message_to_owner). The scheduler used to carry its own
weaker copy — markdown characters and emojis only — so wake-ups spoke
image alt text (the full image description), link targets and raw HTML
aloud: on 2026-09-28 a looping heartbeat's voice note read out
"button onclick window location href https www google com …" dozens of
times. One cleaner, so the two paths can't drift apart again.
"""
import re

_EMOJI = re.compile(
    r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF'
    r'\U00002600-\U000026FF\U00002700-\U000027BF\U0000FE00-\U0000FE0F\U0001F900-\U0001F9FF'
    r'\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF\U0000200D\U000020E3\U000E0020-\U000E007F]+'
)


def strip_markup_for_tts(text: str) -> str:
    # A <button>'s label is UI chrome a model invented, not speech.
    text = re.sub(r'<button\b[^>]*>.*?</button>', ' ', text, flags=re.DOTALL | re.IGNORECASE)
    # Any other HTML tag, attributes included. Must run before the bare-URL
    # rule, which would otherwise eat a quoted href up to the tag's '>'.
    text = re.sub(r'</?[a-zA-Z][^>]*>', ' ', text)
    # Markdown IMAGE refs entirely — the alt text of a generated image is the
    # full diffusion prompt (C-44). Must run before the link rule below,
    # which would keep the alt.
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
    # Markdown links: keep the text, drop the URL.
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # Bare URLs
    text = re.sub(r'https?://\S+', '', text)
    # Other markdown
    text = re.sub(r'[*_~`#]+', '', text)
    text = _EMOJI.sub('', text)
    return re.sub(r'\s+', ' ', text).strip()
