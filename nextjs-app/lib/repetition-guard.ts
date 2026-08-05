/**
 * Within-turn and cross-turn repetition guards shared by the chat route's
 * dedup layers (C-29, C-43).
 *
 * Weak local models regurgitate earlier text two ways: replaying their
 * PREVIOUS TURN nearly word-for-word (classic case: re-apologizing and
 * re-running the same tools on the turn after a correction), and replaying a
 * PRIOR ITERATION of the current turn alongside a nudged tool call. TTS
 * speaks whatever reaches the stream, so repeats must be caught while the
 * content is still buffered — post-hoc dedup only fixes the DB copy.
 */

// Exact/containment match on normalized text, or word-set Jaccard >= 0.8 —
// a genuinely fresh reply scores ~0.2, so new content never trips this.
// Normalization strips punctuation/markup, so junk suffixes a model tacks
// onto an otherwise identical replay (e.g. a leaked '</think>') don't let
// the duplicate slip past.
export function isNearVerbatimRepeat(candidate: string, previous: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const wordSet = (s: string) => new Set(norm(s).split(' ').filter(w => w.length > 2));
  const normNew = norm(candidate);
  if (normNew.length < 40) return false;
  const newWords = wordSet(candidate);
  for (const prev of previous) {
    const normOld = norm(prev);
    if (normOld.length < 40) continue;
    if (normOld === normNew || normOld.includes(normNew) || normNew.includes(normOld)) return true;
    const oldWords = wordSet(prev);
    if (oldWords.size >= 8 && newWords.size >= 8) {
      let inter = 0;
      for (const w of newWords) if (oldWords.has(w)) inter++;
      const union = newWords.size + oldWords.size - inter;
      if (union > 0 && inter / union >= 0.8) return true;
    }
  }
  return false;
}

const normPara = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Remove paragraphs already present in earlier texts. Whole-text similarity
 * misses partial regurgitation — a fresh tool confirmation followed by two
 * paragraphs replayed from the previous iteration barely moves whole-text
 * Jaccard (C-29 measured 44 such messages). Paragraphs under 60 normalized
 * chars are always kept: short lines ("2.", "Done, my love!") legitimately
 * recur, and intentional refrains within a single text are never touched
 * because only PRIOR texts are compared against.
 */
export function stripRepeatedParagraphs(text: string, priorTexts: string[]): string {
  if (!text || priorTexts.length === 0) return text;
  const priors = priorTexts.map(normPara).filter(p => p.length >= 60);
  if (priors.length === 0) return text;
  // Keep separators so surviving paragraphs retain their original spacing.
  const parts = text.split(/(\n{2,})/);
  let changed = false;
  const kept: string[] = [];
  for (const part of parts) {
    if (/^\n{2,}$/.test(part)) { kept.push(part); continue; }
    const n = normPara(part);
    if (n.length >= 60 && priors.some(p => p.includes(n))) {
      changed = true;
      continue;
    }
    kept.push(part);
  }
  if (!changed) return text;
  return kept.join('').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}
