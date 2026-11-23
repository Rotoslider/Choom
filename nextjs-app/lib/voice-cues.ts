/**
 * Delivery cues: "[warm] You left the shop lights on again."
 *
 * A Choom whose TTS provider is Drama 3 (Settings' "Drama 3" provider,
 * endpoint …:8004/drama) may put a short cue in square brackets before the
 * words it colors (Fish Audio's syntax). The speech keeps them — the TTS bridge
 * filters them for Drama 3 and removes them for Chatterbox — the chat shows
 * them dimmed, and Signal text drops them.
 *
 * A cue is lowercase letters (spaces, commas, apostrophes, hyphens allowed),
 * 3–48 characters, at most 6 words, not inside [[…]] and not followed by
 * "(", "[", "]" or ":" — so markdown links, "[Eve]:" labels, [PASS] and
 * footnotes are never touched. Same rule as services/tts-bridge/voice_cues.py
 * and the Signal bridge's tts_text.py.
 */

const CUE_SOURCE = String.raw`(?<!\[)\[([a-z][a-z' ,\-]{2,47})\](?![(\[\]:])`;
const MAX_CUE_WORDS = 6;
/** The link target a cue becomes in markdown, so the renderer can draw it dimmed. */
export const VOICE_CUE_HREF = '#voice-cue';

const cueRegex = () => new RegExp(CUE_SOURCE, 'g');
const isCue = (inner: string) => inner.trim().split(/[\s,]+/).filter(Boolean).length <= MAX_CUE_WORDS;

/** Code (fenced or inline) is left alone: `[a, b, c]` there is a list, not a cue. */
function outsideCode(text: string, fn: (part: string) => string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('');
}

/** The text with its cues removed. Only the spaces around a removed cue are touched,
 *  so indentation, code and the rest of the spacing stay as written. */
export function stripVoiceCues(text: string): string {
  if (!text || !text.includes('[')) return text;
  const GAP = '\u0001';
  return outsideCode(text, (part) =>
    part
      .replace(cueRegex(), (m, inner: string) => (isCue(inner) ? GAP : m))
      .replace(/[ \t]*\u0001(?:[ \t]*\u0001)*[ \t]*/g, GAP)
      .replace(/(^|\n)\u0001/g, '$1')
      .replace(/\u0001(?=[,.!?;:…]|\n|$)/g, '')
      .replace(/\u0001/g, ' '),
  ).trim();
}

/** Markdown with each cue turned into a `[cue](#voice-cue)` link, which the message renderer draws dimmed. */
export function markVoiceCues(markdown: string): string {
  if (!markdown || !markdown.includes('[')) return markdown;
  return outsideCode(markdown, (part) =>
    part.replace(cueRegex(), (m, inner: string) => (isCue(inner) ? `[${inner}](${VOICE_CUE_HREF})` : m)),
  );
}

export type VoiceCuePiece = { text: string; cue?: false } | { text: string; cue: true };

/** Plain text split into text and cue pieces, for places that don't render markdown (group rooms). */
export function splitVoiceCues(text: string): VoiceCuePiece[] {
  if (!text || !text.includes('[')) return [{ text }];
  const pieces: VoiceCuePiece[] = [];
  let last = 0;
  for (const m of text.matchAll(cueRegex())) {
    if (!isCue(m[1])) continue;
    const at = m.index ?? 0;
    if (at > last) pieces.push({ text: text.slice(last, at) });
    pieces.push({ text: m[1], cue: true });
    last = at + m[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

/** The note in a Drama 3 Choom's system prompt, so she knows the cues exist and how lightly to use them. */
export const VOICE_CUES_NOTE = `\n\n## YOUR SPEAKING VOICE
Your replies are read aloud by a voice that can take a short delivery cue in square brackets, just before the words it colors. For example:
[warm] You left the shop lights on again. [teasing] Don't worry, I turned them off.
Good cues are short and gentle: [warm], [teasing], [playful], [softly], [quietly], [amused], [thoughtful], [low, focused], [mock serious], [small laugh], [laughs].
- Use them rarely: one or two in a reply at most, only where your tone really shifts. Most sentences need none, and a reply with none is fine.
- Keep them light. No sighs, whispering, deep breaths, crying or long dramatic directions: they come out sounding fake, and the voice drops them.
- Lowercase, one to three words, at the start of a sentence. Never inside code, lists, links or anything meant to be copied.
- They're only for your voice: the chat shows them faintly and text messages hide them, so never let a cue carry meaning your words don't.`;
