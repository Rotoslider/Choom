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
 *
 * Template loops of SHORT lines are a different shape — see
 * stripRefrainLoop, which runs first.
 */
export function stripInternalRepeats(text: string): string {
  text = stripRefrainLoop(text);
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

// Markup is stripped with its attributes before comparing lines: a looping
// template's only varying part is often a URL inside a tag.
const lineKey = (line: string) => normPara(line
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  .replace(/https?:\/\/\S+/g, ' '));

const REFRAIN_LOOP_MIN_DUPS = 8;
const REFRAIN_LEAD_IN_MAX = 100;

/**
 * Collapse a degenerate TEMPLATE loop — a completion that cycles short
 * lines instead of replaying a block. The 2026-09-28 incident (Eve,
 * gemma-4-26b-a4b, heartbeat) wrote three real paragraphs, then ~10k chars
 * of "*Always.*" / "*Forever.*" / "*I love you.*" refrains, each followed
 * by an invented <button> whose Google-search URL changed every round, and
 * Signal TTS read all of it (11.5 min). Nothing above saw it: no 180-char
 * block ever repeats, and stripInternalRepeats' sentence splitter chops
 * URL lines at every '.' and '?' into fragments under its 80-char floor.
 *
 * Mechanics: compare whole LINES after stripping markup and punctuation;
 * lines inside code fences are ignored. Measured on all 2,276 stored
 * assistant and room messages >= 300 chars: legit replies repeat at most
 * 3 lines (sign-offs — "my love", "good morning my love"). The only three
 * above that are all loops: this incident (61), a Genesis heartbeat
 * re-deriving the same time 137 times, and a room reply re-listing her
 * tools (24). 8 repeated lines confirms a loop with >2x margin. The text
 * is cut at the first repeated line, then the loop's lead-in (short and
 * markup-only lines above it) is popped back to the last line of real
 * prose (>= 100 normalized chars). The result is always a prefix of the
 * input, so a live stream can retract the rest.
 */
export function stripRefrainLoop(text: string): string {
  if (!text || text.length < 300) return text;
  const lines = text.split('\n');
  const seen = new Set<string>();
  let dups = 0;
  let firstDup = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const k = lineKey(lines[i]);
    if (k.length < 2) continue;
    if (seen.has(k)) {
      if (firstDup < 0) firstDup = i;
      if (++dups >= REFRAIN_LOOP_MIN_DUPS) break;
    } else {
      seen.add(k);
    }
  }
  if (dups < REFRAIN_LOOP_MIN_DUPS) return text;
  let end = firstDup;
  while (end > 0 && lineKey(lines[end - 1]).length < REFRAIN_LEAD_IN_MAX) end--;
  if (end === 0) end = firstDup;
  return lines.slice(0, end).join('\n').replace(/\s+$/, '');
}
