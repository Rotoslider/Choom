// Freshness-tiered tool-output compression.
//
// The agentic loop re-sends every prior tool result on every iteration. The
// FRESH result (the one the model is about to act on) must stay full — but the
// STALE copies, which the model already consumed, can be trimmed hard. This
// module does that trimming deterministically (no LLM call), preserving the
// signal a small model can't reconstruct:
//   • error outputs are kept VERBATIM (never compress away a failure/stack trace)
//   • JSON arrays of records keep their first few rows + a count of what was dropped
//   • arrays of plain lines (ids, names, moves) keep every line
//   • long string fields keep a head + tail with a byte count in between
//   • results a Choom works FROM over the next steps (KEEP_WHOLE) are never trimmed
//
// Everything trimmed is replaced with a visible marker so a Choom can SEE that
// data was dropped, and so we never double-compress an already-compressed result.

// Substring present in every marker we emit — used to detect already-compressed
// content (idempotency) and to let a Choom notice trimming happened.
export const COMPRESSION_MARKER = 'omitted to save context';

// `again`: the result came from a read-only tool, so the marker can tell her that the same call shows
// the rest (never for a tool that changes something: calling it again would do it again).
const omitted = (n: number, what: string, again = false) =>
  `…[${n} ${what} ${COMPRESSION_MARKER}${again ? `; make the same call again to see ${what === 'chars' ? 'all of it' : 'them all'}` : ''}]`;

// Results a Choom works FROM over the next steps: the file she is tidying, the folder she deletes in,
// the ids she cancels or rewords, the closet she picks a move from, the rooms and devices she names.
// Trimmed a step later, she acted on three items or 240 characters of them. On Nov 5, 2026 Genesis
// saw 3 of her 14 follow-ups ("…[11 more items omitted]"), Eve 3 of her 35 glass moves (so she
// couldn't tell she had a twirl), and Eve deleted camera frames from a folder listing cut to 240
// characters. Over the week before, these tools came to about 8% of what trimming saved.
export const KEEP_WHOLE = new Set([
  'workspace_read_file', 'workspace_list_files',
  'list_self_followups', 'glass_closet',
  'list_my_rooms', 'ha_list_entities',
]);

// Error signal we must never trim — small models can't rebuild a stack trace or
// the exact failure text, so a stale result that still carries one stays full.
const ERROR_RE =
  /\b(error|errno|exception|traceback|stack\s?trace|fatal|failed|failure|denied|unauthoriz|forbidden|not found|status\s?[45]\d\d|timed?\s?out)\b/i;

const KEEP_ARRAY_ITEMS = 3; // keep the first N items of a long array
const MAX_STRING_FIELD = 240; // trim string fields longer than this (head+tail)
const MIN_COMPRESS_LEN = 600; // skip payloads smaller than this — nothing to gain

function truncateString(s: string, again = false): string {
  if (s.length <= MAX_STRING_FIELD) return s;
  const head = Math.floor(MAX_STRING_FIELD * 0.7);
  const tail = MAX_STRING_FIELD - head;
  return `${s.slice(0, head)} ${omitted(s.length - MAX_STRING_FIELD, 'chars', again)} ${s.slice(s.length - tail)}`;
}

function compressValue(value: unknown, again = false): unknown {
  if (Array.isArray(value)) {
    // A list of plain lines (moves, ids, names, states) is the answer itself and costs little; only
    // lists of records (memories, forecast hours, search hits) lose rows.
    const records = !value.every((v) => typeof v === 'string');
    if (records && value.length > KEEP_ARRAY_ITEMS) {
      const kept: unknown[] = value.slice(0, KEEP_ARRAY_ITEMS).map((v) => compressValue(v, again));
      kept.push(omitted(value.length - KEEP_ARRAY_ITEMS, 'more items', again));
      return kept;
    }
    return value.map((v) => compressValue(v, again));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? truncateString(v, again) : compressValue(v, again);
    }
    return out;
  }
  if (typeof value === 'string') return truncateString(value, again);
  return value;
}

/**
 * Compress a single (stale) tool-result payload. Returns the original unchanged
 * with savedChars=0 when there's nothing safe to gain (small, already
 * compressed, carrying an error, or from a KEEP_WHOLE tool). savedChars is the
 * actual byte reduction. `tool` is the tool that returned it; `readOnly` says the
 * same call can safely be made again to see what was trimmed.
 */
export function compressStaleToolResult(
  content: string,
  opts: { tool?: string; readOnly?: boolean } = {},
): { content: string; savedChars: number } {
  if (opts.tool && KEEP_WHOLE.has(opts.tool)) return { content, savedChars: 0 };
  if (!content || content.length < MIN_COMPRESS_LEN) return { content, savedChars: 0 };
  const again = !!opts.readOnly;
  if (content.includes(COMPRESSION_MARKER)) return { content, savedChars: 0 }; // already compressed
  if (ERROR_RE.test(content)) return { content, savedChars: 0 }; // preserve error signal verbatim

  try {
    // Structured JSON → schema-aware trim (rows + long fields).
    const out = JSON.stringify(compressValue(JSON.parse(content), again));
    const savedChars = content.length - out.length;
    return savedChars > 0 ? { content: out, savedChars } : { content, savedChars: 0 };
  } catch {
    // Plain text → head + tail.
    const head = Math.floor(MIN_COMPRESS_LEN * 0.5);
    const tail = Math.floor(MIN_COMPRESS_LEN * 0.25);
    if (content.length <= head + tail) return { content, savedChars: 0 };
    const out = `${content.slice(0, head)}\n${omitted(content.length - head - tail, 'chars', again)}\n${content.slice(content.length - tail)}`;
    const savedChars = content.length - out.length;
    return savedChars > 0 ? { content: out, savedChars } : { content, savedChars: 0 };
  }
}
