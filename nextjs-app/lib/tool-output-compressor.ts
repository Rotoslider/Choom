// Freshness-tiered tool-output compression.
//
// The agentic loop re-sends every prior tool result on every iteration. The
// FRESH result (the one the model is about to act on) must stay full — but the
// STALE copies, which the model already consumed, can be trimmed hard. This
// module does that trimming deterministically (no LLM call), preserving the
// signal a small model can't reconstruct:
//   • error outputs are kept VERBATIM (never compress away a failure/stack trace)
//   • JSON arrays keep their first few rows + a count of what was dropped
//   • long string fields keep a head + tail with a byte count in between
//
// Everything trimmed is replaced with a visible marker so a Choom can SEE that
// data was dropped, and so we never double-compress an already-compressed result.

// Substring present in every marker we emit — used to detect already-compressed
// content (idempotency) and to let a Choom notice trimming happened.
export const COMPRESSION_MARKER = 'omitted to save context';

const omitted = (n: number, what: string) => `…[${n} ${what} ${COMPRESSION_MARKER}]`;

// Error signal we must never trim — small models can't rebuild a stack trace or
// the exact failure text, so a stale result that still carries one stays full.
const ERROR_RE =
  /\b(error|errno|exception|traceback|stack\s?trace|fatal|failed|failure|denied|unauthoriz|forbidden|not found|status\s?[45]\d\d|timed?\s?out)\b/i;

const KEEP_ARRAY_ITEMS = 3; // keep the first N items of a long array
const MAX_STRING_FIELD = 240; // trim string fields longer than this (head+tail)
const MIN_COMPRESS_LEN = 600; // skip payloads smaller than this — nothing to gain

function truncateString(s: string): string {
  if (s.length <= MAX_STRING_FIELD) return s;
  const head = Math.floor(MAX_STRING_FIELD * 0.7);
  const tail = MAX_STRING_FIELD - head;
  return `${s.slice(0, head)} ${omitted(s.length - MAX_STRING_FIELD, 'chars')} ${s.slice(s.length - tail)}`;
}

function compressValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > KEEP_ARRAY_ITEMS) {
      const kept: unknown[] = value.slice(0, KEEP_ARRAY_ITEMS).map(compressValue);
      kept.push(omitted(value.length - KEEP_ARRAY_ITEMS, 'more items'));
      return kept;
    }
    return value.map(compressValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? truncateString(v) : compressValue(v);
    }
    return out;
  }
  if (typeof value === 'string') return truncateString(value);
  return value;
}

/**
 * Compress a single (stale) tool-result payload. Returns the original unchanged
 * with savedChars=0 when there's nothing safe to gain (small, already
 * compressed, or carrying an error). savedChars is the actual byte reduction.
 */
export function compressStaleToolResult(content: string): { content: string; savedChars: number } {
  if (!content || content.length < MIN_COMPRESS_LEN) return { content, savedChars: 0 };
  if (content.includes(COMPRESSION_MARKER)) return { content, savedChars: 0 }; // already compressed
  if (ERROR_RE.test(content)) return { content, savedChars: 0 }; // preserve error signal verbatim

  try {
    // Structured JSON → schema-aware trim (rows + long fields).
    const out = JSON.stringify(compressValue(JSON.parse(content)));
    const savedChars = content.length - out.length;
    return savedChars > 0 ? { content: out, savedChars } : { content, savedChars: 0 };
  } catch {
    // Plain text → head + tail.
    const head = Math.floor(MIN_COMPRESS_LEN * 0.5);
    const tail = Math.floor(MIN_COMPRESS_LEN * 0.25);
    if (content.length <= head + tail) return { content, savedChars: 0 };
    const out = `${content.slice(0, head)}\n${omitted(content.length - head - tail, 'chars')}\n${content.slice(content.length - tail)}`;
    const savedChars = content.length - out.length;
    return savedChars > 0 ? { content: out, savedChars } : { content, savedChars: 0 };
  }
}
