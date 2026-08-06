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

const unitWordSet = (s: string) => new Set(normPara(s).split(' ').filter(w => w.length > 2));

/**
 * Collapse degenerate repetition WITHIN one text. A weak local model at long
 * context can loop inside a SINGLE completion — the 2026-08-06 incident
 * generated six near-identical ~1.5k-char apology blocks (~15k chars) in one
 * iteration before hitting the token cap. Cross-iteration layers never see
 * that: they only compare against PRIOR texts. Paragraph-aligned matching
 * misses it too — the looped blocks run together mid-paragraph, so no two
 * paragraphs line up (measured on the incident text: a paragraph pass
 * removed 7%; this sentence-level pass removes the whole meltdown).
 *
 * Mechanics: scan sentence-ish units in order. A unit with >= 80 normalized
 * chars that is near-identical to an EARLIER kept unit (normalized
 * containment either way, or word-set Jaccard >= 0.8 — same bar as
 * isNearVerbatimRepeat) is dropped. THREE dropped units confirm
 * degeneration, and degenerate completions never recover — so on the third
 * drop the text is cut back to where the FIRST drop occurred (everything
 * from the first loop signal on is replay interleaved with filler), then
 * trailing short units that exactly duplicate an earlier unit are popped
 * (the replay's short lead-in sentence, orphaned headers). One or two drops
 * just lose those units. Measured on the incident text, long-unit
 * best-match similarity is bimodal — fresh sentences <= 0.4, loop repeats
 * >= 0.8 — so fresh replies pass untouched. Paraphrased re-statements
 * (0.5–0.7) are deliberately out of scope: lexical machinery can't collapse
 * paraphrase, and the C-58 loop-breaker now stops the nudge spiral that
 * produced them at the source.
 */
export function stripInternalRepeats(text: string): string {
  if (!text || text.length < 300) return text;
  // Sentence-ish units, each keeping its trailing whitespace so surviving
  // units rejoin with original spacing. Headers / list items without
  // sentence punctuation terminate at newlines.
  const units = text.match(/[^.!?…\n]*[.!?…]+["')\]]*\s*|[^\n]+\n+|[^\n]+$/g);
  if (!units || units.length < 2) return text;
  const keptNorms: string[] = [];
  const keptSets: Set<string>[] = [];
  const kept: string[] = [];
  let dropped = 0;
  let keptAtFirstDrop = -1;
  for (const unit of units) {
    const n = normPara(unit);
    if (n.length >= 80) {
      const words = unitWordSet(unit);
      let dup = false;
      for (let i = 0; i < keptNorms.length; i++) {
        const prev = keptNorms[i];
        if (prev.includes(n) || n.includes(prev)) { dup = true; break; }
        const prevWords = keptSets[i];
        if (prevWords.size >= 8 && words.size >= 8) {
          let inter = 0;
          for (const w of words) if (prevWords.has(w)) inter++;
          const union = words.size + prevWords.size - inter;
          if (union > 0 && inter / union >= 0.8) { dup = true; break; }
        }
      }
      if (dup) {
        dropped++;
        if (keptAtFirstDrop < 0) keptAtFirstDrop = kept.length;
        if (dropped >= 3) break; // degeneration confirmed
        continue;
      }
      keptNorms.push(n);
      keptSets.push(words);
    }
    kept.push(unit);
  }
  if (dropped === 0) return text;
  let out = kept;
  if (dropped >= 3 && keptAtFirstDrop >= 0) {
    // Cut back to the first loop signal, then pop trailing exact duplicates
    // of earlier units (the replay's short lead-in, orphaned headers).
    out = kept.slice(0, keptAtFirstDrop);
    const norms = out.map(normPara);
    while (out.length > 0) {
      const last = norms[out.length - 1];
      if (last.length >= 10 && norms.slice(0, out.length - 1).includes(last)) {
        out.pop();
      } else break;
    }
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '').replace(/\s+$/, '');
}
