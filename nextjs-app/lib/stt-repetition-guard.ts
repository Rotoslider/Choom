/**
 * Collapse Whisper decoder loops in a transcript.
 *
 * Whisper sometimes locks onto a phrase and emits it until the token budget
 * runs out — 2026-09-20 a 99 s mic recording came back as a real paragraph
 * followed by "Access all of the... " repeated ~110 times. Rapid-MLX decodes
 * with a single temperature (no compression-ratio fallback) and conditions
 * each 30 s window on the previous text, so once a window loops, every later
 * window loops too. Nothing upstream stops it; this does, after the fact.
 *
 * Rule: any phrase of 1–12 words that repeats back-to-back 3+ times is
 * collapsed to one copy. Genuine speech repeats a phrase twice at most
 * ("no, no" survives; "no, no, no, no" becomes "no,"). Keep it that simple —
 * the failure is hundreds of copies, not three.
 */

export interface RepetitionGuardResult {
  text: string;
  /** How many repeated copies were removed (0 = untouched). */
  removed: number;
  /** The phrase that looped, when one did. */
  phrase?: string;
}

const MAX_PHRASE_WORDS = 12;
const MIN_REPEATS = 3;

const normalizeWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

export function collapseRepetitions(input: string): RepetitionGuardResult {
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length < MIN_REPEATS) return { text: input, removed: 0 };
  const norm = words.map(normalizeWord);

  const out: string[] = [];
  let removed = 0;
  let phrase: string | undefined;
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    for (let n = 1; n <= MAX_PHRASE_WORDS && i + n * MIN_REPEATS <= words.length; n++) {
      // Count how many consecutive copies of words[i..i+n) follow.
      let copies = 1;
      while (i + (copies + 1) * n <= words.length && sameRun(norm, i, i + copies * n, n)) copies++;
      if (copies >= MIN_REPEATS && norm.slice(i, i + n).some(w => w.length > 0)) {
        out.push(...words.slice(i, i + n));
        removed += copies - 1;
        phrase ??= words.slice(i, i + n).join(' ');
        i += copies * n;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) { out.push(words[i]); i++; }
  }
  if (removed === 0) return { text: input, removed: 0 };
  return { text: out.join(' ').trim(), removed, phrase };
}

function sameRun(norm: string[], a: number, b: number, n: number): boolean {
  for (let k = 0; k < n; k++) if (norm[a + k] !== norm[b + k]) return false;
  return true;
}
