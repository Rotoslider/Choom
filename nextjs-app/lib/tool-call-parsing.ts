/**
 * Tool-call parsing and recovery for models that do not emit clean tool_calls.
 *
 * Every function here exists because some model, somewhere, expressed a tool
 * call as prose or malformed JSON instead of using the structured API:
 *
 *   - Hermes/Qwen        <tool_call>{...}</tool_call> in the content stream
 *   - Gemma              ```tool_code / <function=name>{...}</function>
 *   - Mistral            [TOOL_CALLS] name{...}
 *   - Bracket dialects   [name(arg="x")]
 *   - Truncated JSON     arguments cut off mid-value by a token limit
 *
 * Two jobs, kept separate:
 *   1. STREAM FILTERS (create*Filter) — stateful, incremental. They strip the
 *      tool-call syntax out of streamed text so the user never sees raw markup,
 *      while capturing the calls. Feed chunks in; call flush() at end of stream.
 *   2. EXTRACTORS / RESCUERS — pure, whole-string. They recover a tool call
 *      from a completed message after the fact.
 *
 * Extracted verbatim from app/api/chat/route.ts. Every function was already
 * pure (no request state, no DB, no closure over the handler), so this is a
 * move, not a rewrite — behaviour is unchanged. It is ~1,050 lines of the most
 * fiddly, most regex-dense, most testable code in the route, and it was sitting
 * in the middle of the request handler where none of it could be unit-tested.
 */

// Attempt JSON repair for malformed tool call arguments from local models.
// Uses a state machine to properly track string context so braces/brackets
// inside strings are not miscounted (common when content contains code).
export function tryRepairJSON(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  let s = raw.trim();

  // State machine: track whether we're inside a JSON string value
  // Also detect where the first root-level object ends, so we can
  // truncate concatenated objects like "{}{}" or '{"a":1}{"b":2}'
  let inString = false;
  let braceDepth = 0;
  let bracketDepth = 0;
  let firstObjectEnd = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped character
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') inString = true;
      else if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0 && bracketDepth === 0 && firstObjectEnd === -1) {
          firstObjectEnd = i;
        }
      }
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
    }
  }

  // If the first root object closed before the end of the string,
  // there's trailing garbage (e.g. "{}{}", '{"a":1}extra'). Truncate.
  if (firstObjectEnd !== -1 && firstObjectEnd < s.length - 1) {
    s = s.slice(0, firstObjectEnd + 1);
    try { return JSON.parse(s); } catch { /* fall through to other repairs */ }
  }

  // Close unterminated string (e.g. truncated "content": "# E)
  if (inString) {
    // Remove trailing incomplete escape sequence (lone backslash at end)
    s = s.replace(/\\$/, '');
    s += '"';
  }

  // Remove trailing commas before closing brackets/braces
  s = s.replace(/,\s*$/g, '');

  // Close open structures
  if (bracketDepth > 0) s += ']'.repeat(bracketDepth);
  if (braceDepth > 0) s += '}'.repeat(braceDepth);

  // Clean up trailing commas inside structures
  s = s.replace(/,\s*}/g, '}');
  s = s.replace(/,\s*]/g, ']');

  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Create a streaming filter that strips <think>...</think> blocks emitted by
 * reasoning models (Qwen 3.x, DeepSeek-R1, etc.). Call filter() on each content
 * chunk; it returns only the visible (non-thinking) portion. Maintains state
 * across calls so tags that span chunk boundaries are handled correctly.
 */
export function createThinkFilter(): (text: string) => string {
  let inThinkBlock = false;

  return function filter(text: string): string {
    if (!text) return '';
    let result = '';
    let pos = 0;

    while (pos < text.length) {
      if (inThinkBlock) {
        const closeIdx = text.indexOf('</think>', pos);
        if (closeIdx !== -1) {
          inThinkBlock = false;
          pos = closeIdx + 8; // '</think>'.length
        } else {
          break; // rest is inside think block — discard
        }
      } else {
        const openIdx = text.indexOf('<think>', pos);
        if (openIdx !== -1) {
          result += text.slice(pos, openIdx);
          inThinkBlock = true;
          pos = openIdx + 7; // '<think>'.length
        } else {
          result += text.slice(pos);
          break;
        }
      }
    }

    return result;
  };
}

/**
 * Streaming filter that strips <tool_call>...</tool_call> XML blocks from content.
 * Some local models emit tool calls as XML text instead of structured tool_calls.
 * This captures the XML for later parsing into real tool calls while hiding the
 * raw XML from the user (both web UI and Signal).
 */
export function createToolCallXmlFilter(): {
  filter: (text: string) => string;
  getCaptured: () => string[];
  flush: () => string;
} {
  let inBlock = false;
  let currentBlock = '';
  let pendingBuffer = ''; // holds partial tag prefixes across chunks
  const captured: string[] = [];

  const OPEN_TAG = '<tool_call>';
  const CLOSE_TAG = '</tool_call>';

  function filter(text: string): string {
    if (!text && !pendingBuffer) return '';

    // Prepend any buffered partial tag from previous chunk
    text = pendingBuffer + (text || '');
    pendingBuffer = '';

    let result = '';
    let pos = 0;

    while (pos < text.length) {
      if (inBlock) {
        const closeIdx = text.indexOf(CLOSE_TAG, pos);
        if (closeIdx !== -1) {
          currentBlock += text.slice(pos, closeIdx);
          captured.push(currentBlock);
          currentBlock = '';
          inBlock = false;
          pos = closeIdx + CLOSE_TAG.length;
        } else {
          // The CLOSING tag needs the same split-across-chunks handling as the
          // opening one. Without it, a chunk boundary anywhere inside
          // "</tool_call>" — and it is commonly several tokens ("</", "tool",
          // "_call", ">") — meant the close was never matched. The filter then
          // stayed inBlock forever: every following token was swallowed into
          // the block instead of being shown (the Choom simply went silent
          // after a tool call), and the captured block came out polluted with
          // "</tool_call>" plus the trailing prose, so parsing the arguments
          // failed too. Hold back a trailing partial close tag instead.
          const remaining = text.slice(pos);
          const lastLt = remaining.lastIndexOf('<');
          if (lastLt !== -1 && lastLt >= remaining.length - CLOSE_TAG.length) {
            const tail = remaining.slice(lastLt);
            if (CLOSE_TAG.startsWith(tail)) {
              currentBlock += remaining.slice(0, lastLt);
              pendingBuffer = tail;
              break;
            }
          }
          currentBlock += remaining;
          break; // rest is inside block — buffer it
        }
      } else {
        const openIdx = text.indexOf(OPEN_TAG, pos);
        if (openIdx !== -1) {
          result += text.slice(pos, openIdx);
          inBlock = true;
          currentBlock = '';
          pos = openIdx + 11; // '<tool_call>'.length
        } else {
          // No complete <tool_call> found. Check if the text ends with a
          // partial prefix of <tool_call> split across streaming chunks
          // (e.g. chunk ends with "<tool" and next chunk starts with "_call>").
          const remaining = text.slice(pos);
          const lastLt = remaining.lastIndexOf('<');
          if (lastLt !== -1 && lastLt >= remaining.length - OPEN_TAG.length) {
            const tail = remaining.slice(lastLt);
            if (OPEN_TAG.startsWith(tail)) {
              // Tail is a valid prefix of <tool_call> — buffer it
              result += remaining.slice(0, lastLt);
              pendingBuffer = tail;
            } else {
              result += remaining;
            }
          } else {
            result += remaining;
          }
          break;
        }
      }
    }

    return result;
  }

  function flush(): string {
    // Release any buffered partial tag that never completed
    let buf = pendingBuffer;
    pendingBuffer = '';
    // If stream ended while inside a block, capture whatever we have
    // so parseXmlToolCalls can attempt to parse the truncated tool call
    if (inBlock) {
      // A pending fragment held while inBlock is a partial CLOSING tag, i.e.
      // block content — not text for the user. Returning it here would print
      // a stray "</too" into the chat.
      if (buf) {
        currentBlock += buf;
        buf = '';
      }
      if (currentBlock) {
        captured.push(currentBlock);
        currentBlock = '';
      }
      inBlock = false;
    }
    return buf;
  }

  return { filter, getCaptured: () => captured, flush };
}

/**
 * Streaming filter that strips JSON tool-call arrays emitted as plain text
 * by local models.  Catches patterns like:
 *
 *   [
 *   {"name": "remember", "parameters": {"title": "..."}}
 *   ]
 *
 * Works identically to createToolCallXmlFilter(): buffers potential blocks
 * during streaming, validates on close, and either captures (tool call) or
 * releases (normal text).
 */
export function createJsonToolCallFilter(): {
  filter: (text: string) => string;
  getCaptured: () => { id: string; name: string; arguments: Record<string, unknown> }[];
  flush: () => string;
} {
  let inBlock = false;
  let buffer = '';
  let bracketDepth = 0;
  let seenBrace = false;          // saw `{` after opening `[`
  let pendingBracket = '';        // `[` (+ whitespace) at end of chunk
  const captured: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

  /** Try to parse a complete `[…]` string as a tool-call array. */
  function tryCapture(block: string): boolean {
    try {
      const parsed = JSON.parse(block);
      if (!Array.isArray(parsed)) return false;
      let any = false;
      for (const item of parsed) {
        if (item && typeof item.name === 'string' && /^[a-zA-Z0-9_-]+$/.test(item.name)) {
          captured.push({
            id: `jsontc_${Date.now()}_${captured.length}`,
            name: item.name,
            arguments: item.parameters || item.arguments || {},
          });
          any = true;
        }
      }
      return any;
    } catch {
      return false;
    }
  }

  function filter(text: string): string {
    if (!text && !pendingBracket) return '';

    text = pendingBracket + (text || '');
    pendingBracket = '';

    let result = '';
    let i = 0;

    while (i < text.length) {
      if (inBlock) {
        const ch = text[i];
        buffer += ch;

        if (ch === '[') {
          bracketDepth++;
        } else if (ch === ']') {
          bracketDepth--;
          if (bracketDepth === 0) {
            // Block complete
            if (tryCapture(buffer)) {
              // Swallowed — don't emit
            } else {
              result += buffer;
            }
            buffer = '';
            inBlock = false;
            seenBrace = false;
          }
        } else if (!seenBrace && ch === '{') {
          seenBrace = true;
        } else if (!seenBrace && !/\s/.test(ch)) {
          // First non-whitespace after `[` isn't `{` — not a tool call
          result += buffer;
          buffer = '';
          inBlock = false;
        }

        // Safety valve: huge buffer means this isn't a tool call
        if (inBlock && buffer.length > 10000) {
          result += buffer;
          buffer = '';
          inBlock = false;
          seenBrace = false;
        }

        i++;
      } else {
        if (text[i] === '[') {
          // Only intercept `[` that starts on its own line (or at text start)
          const before = i > 0 ? text[i - 1] : '\n';
          if (before === '\n' || before === '\r' || i === 0) {
            const rest = text.slice(i + 1);
            if (rest.length === 0 || /^\s*$/.test(rest)) {
              // `[` at/near end of chunk — buffer for next chunk
              pendingBracket = text.slice(i);
              break;
            }
            const peek = rest.match(/^\s*(.)/s);
            if (peek && peek[1] === '{') {
              inBlock = true;
              bracketDepth = 1;
              buffer = '[';
              seenBrace = false;
              i++;
              continue;
            }
          }
        }
        result += text[i];
        i++;
      }
    }

    return result;
  }

  function flush(): string {
    let remaining = pendingBracket;
    pendingBracket = '';

    if (inBlock && buffer) {
      // Last-chance parse (e.g. stream ended right after `]`)
      if (!tryCapture(buffer)) {
        remaining = buffer + remaining;
      }
      buffer = '';
      inBlock = false;
      seenBrace = false;
    }

    return remaining;
  }

  return { filter, getCaptured: () => captured, flush };
}

/**
 * Streaming filter for Gemma 4 26B's text-emitted tool calls. Gemma's tokenizer
 * has special-token markers for tool calls, but when served via LM Studio those
 * tokens come out as literal text with a broken shape:
 *
 *   <|tool_call>call:send_notification{message:<|"|>hello world<|"|>}<tool_call|>
 *
 * Note the asymmetric markers (`<|tool_call>` open, `<tool_call|>` close) and
 * the `<|"|>` pseudo-quote delimiter. Without this filter, the block leaks
 * into visible output AND the tool never executes — the model then confabulates
 * that it sent the notification when it didn't.
 *
 * Like the XML/JSON filters, this buffers partial markers across chunks so
 * streaming doesn't split a block mid-marker.
 */
export function createGemmaToolCallFilter(): {
  filter: (text: string) => string;
  getCaptured: () => { id: string; name: string; arguments: Record<string, unknown> }[];
  flush: () => string;
} {
  let pendingBuffer = '';
  const captured: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

  const OPEN = '<|tool_call>';
  const CLOSE = '<tool_call|>';

  function tryParseBlock(inner: string): boolean {
    // Block shape: call:NAME{args}
    const m = inner.match(/^\s*call\s*:\s*([A-Za-z0-9_]+)\s*\{([\s\S]*)\}\s*$/);
    if (!m) return false;
    const name = m[1];
    // Normalize Gemma's <|"|> pseudo-quote to a real quote before parsing
    const argsStr = m[2].replace(/<\|"\|>/g, '"');

    const args: Record<string, unknown> = {};

    // Lenient key-value extraction:
    // 1. Quoted string values: key:"value" (handles commas / spaces inside)
    const kvString = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let kv: RegExpExecArray | null;
    while ((kv = kvString.exec(argsStr)) !== null) {
      args[kv[1]] = kv[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }

    // 2. Numeric / bool / null values: key:123, key:true, key:null
    const kvPrimitive = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?\d+(?:\.\d+)?|true|false|null)\b/g;
    let kvn: RegExpExecArray | null;
    while ((kvn = kvPrimitive.exec(argsStr)) !== null) {
      if (args[kvn[1]] !== undefined) continue; // don't overwrite a string capture
      const v = kvn[2];
      if (v === 'true') args[kvn[1]] = true;
      else if (v === 'false') args[kvn[1]] = false;
      else if (v === 'null') args[kvn[1]] = null;
      else args[kvn[1]] = Number(v);
    }

    // Only capture when we successfully extracted at least one arg. Empty-args
    // Gemma blocks are dangerous — the route.ts pre-flight check would then
    // have to catch them, and a silently-captured call with no params tends
    // to fail downstream in confusing ways. Let legit no-arg calls come
    // through the structured tool_calls API instead.
    if (Object.keys(args).length > 0) {
      captured.push({
        id: `gemmatc_${Date.now()}_${captured.length}`,
        name,
        arguments: args,
      });
      return true;
    }
    return false;
  }

  function filter(text: string): string {
    if (!text && !pendingBuffer) return '';
    text = pendingBuffer + (text || '');
    pendingBuffer = '';

    let result = '';
    let pos = 0;

    while (pos < text.length) {
      const openIdx = text.indexOf(OPEN, pos);

      if (openIdx === -1) {
        // No opening marker. Check if the tail could be a partial prefix
        // split across streaming chunks (e.g., "...<|tool" in one chunk,
        // "_call>..." in the next).
        const remaining = text.slice(pos);
        const lastLt = remaining.lastIndexOf('<');
        if (lastLt !== -1 && (remaining.length - lastLt) <= OPEN.length) {
          const tail = remaining.slice(lastLt);
          if (OPEN.startsWith(tail)) {
            result += remaining.slice(0, lastLt);
            pendingBuffer = tail;
            break;
          }
        }
        result += remaining;
        break;
      }

      // Emit any text before the open marker
      result += text.slice(pos, openIdx);

      // Find the matching close marker
      const contentStart = openIdx + OPEN.length;
      const closeIdx = text.indexOf(CLOSE, contentStart);
      if (closeIdx === -1) {
        // Block not complete — buffer from the open marker onward.
        // Safety valve: if the buffer grows huge, something's wrong —
        // release it as normal text so we don't leak memory.
        const bufferedLen = text.length - openIdx;
        if (bufferedLen > 20000) {
          result += text.slice(openIdx);
        } else {
          pendingBuffer = text.slice(openIdx);
        }
        break;
      }

      const block = text.slice(contentStart, closeIdx);
      const parsed = tryParseBlock(block);
      if (!parsed) {
        // Parse failed. Swallow the block to avoid leaking broken syntax to
        // the user, but log so we can see unhandled Gemma shapes in dev.
        console.warn(`   ⚠️  Gemma tool_call block didn't parse: ${block.slice(0, 120)}`);
      }
      pos = closeIdx + CLOSE.length;
    }

    return result;
  }

  function flush(): string {
    const buf = pendingBuffer;
    pendingBuffer = '';
    // If the buffer starts with a partial/incomplete Gemma block, drop it —
    // don't leak broken `<|tool_call>...` into the user-visible output.
    if (buf.startsWith('<') && (OPEN.startsWith(buf) || buf.startsWith(OPEN))) {
      if (buf.startsWith(OPEN)) {
        console.warn(`   ⚠️  Gemma tool_call block never completed (stream ended) — dropping ${buf.length} chars`);
      }
      return '';
    }
    return buf;
  }

  return { filter, getCaptured: () => captured, flush };
}

// Find the index of the brace/bracket that closes the one at `start`, respecting
// strings and escapes. Returns -1 if unbalanced.
function matchBalanced(s: string, start: number, open: string, close: string): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Salvage MISTRAL tool calls that leaked as TEXT. When LM Studio's Mistral chat
 * template doesn't convert them to structured `tool_calls`, the model's native
 * token sequence prints verbatim, e.g.:
 *
 *   [TOOL_CALLS]generate_image<SPECIAL_32>{"prompt":"…","self_portrait":true}
 *   [TOOL_CALLS][{"name":"get_weather","arguments":{}}]   (array form)
 *
 * Neither survives the XML/JSON/Gemma/bracket parsers (the `[TOOL_CALLS]` /
 * `<SPECIAL_n>` wrapper breaks them), so the tool never runs. This extracts both
 * shapes (validating the name against the active tool list) and returns the calls
 * plus the content with those spans removed.
 */
export function extractMistralToolCalls(
  content: string,
  knownToolNames: Set<string>,
): { calls: { id: string; name: string; arguments: Record<string, unknown> }[]; cleaned: string } {
  const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
  if (!content || content.indexOf('[TOOL_CALLS]') === -1) return { calls, cleaned: content };
  const removeRanges: Array<[number, number]> = [];
  const marker = /\[TOOL_CALLS\]\s*/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(content)) !== null) {
    const i = m.index + m[0].length;
    // Array form: [TOOL_CALLS][{"name":…,"arguments":…}, …]
    if (content[i] === '[') {
      const end = matchBalanced(content, i, '[', ']');
      if (end > i) {
        try {
          const arr = JSON.parse(content.slice(i, end + 1));
          if (Array.isArray(arr)) {
            let any = false;
            for (const it of arr) {
              if (it && typeof it.name === 'string' && knownToolNames.has(it.name)) {
                calls.push({ id: `mistraltc_${Date.now()}_${calls.length}`, name: it.name, arguments: (it.arguments || it.parameters || {}) as Record<string, unknown> });
                any = true;
              }
            }
            if (any) { removeRanges.push([m.index, end + 1]); continue; }
          }
        } catch { /* fall through */ }
      }
    }
    // Name form: [TOOL_CALLS]tool_name<SPECIAL_n>{json}  (special tokens optional)
    const nameMatch = /^([a-zA-Z_]\w*)\s*(?:<[^>\n]*>\s*|\[ARGS\]\s*)*/.exec(content.slice(i));
    if (nameMatch) {
      const name = nameMatch[1];
      const j = i + nameMatch[0].length;
      if (content[j] === '{' && knownToolNames.has(name)) {
        const end = matchBalanced(content, j, '{', '}');
        if (end > j) {
          try {
            const args = JSON.parse(content.slice(j, end + 1)) as Record<string, unknown>;
            calls.push({ id: `mistraltc_${Date.now()}_${calls.length}`, name, arguments: args });
            removeRanges.push([m.index, end + 1]);
          } catch { /* not valid JSON args */ }
        }
      }
    }
  }
  let cleaned = content;
  for (let k = removeRanges.length - 1; k >= 0; k--) {
    const [s, e] = removeRanges[k];
    cleaned = cleaned.slice(0, s) + cleaned.slice(e);
  }
  return { calls, cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * Salvage qwen's UNFORCED freestyle tool calls. Without tool_choice=required,
 * qwen3.6 sometimes writes a tool call as markdown rather than a structured call:
 *
 *   [generate_image
 *     prompt="three figures in morning light"
 *     size="large"
 *     self_portrait=false
 *   ]
 *
 * None of the structured parsers (XML/JSON/Gemma) catch this, so it prints as
 * prose and the tool never runs (the "Genesis described an image but no image"
 * bug). This extracts `[known_tool key="val" …]` blocks and returns the calls
 * plus the content with those blocks removed. Heavily guarded against false
 * positives: the bracketed word MUST be a real active tool name, and there must
 * be at least one `key=value` pair — so prose like `[Donny]:` or
 * `[image shared to the room …]` is never matched.
 */
export function extractBracketToolCalls(
  content: string,
  knownToolNames: Set<string>,
): { calls: { id: string; name: string; arguments: Record<string, unknown> }[]; cleaned: string } {
  const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
  if (!content || content.indexOf('[') === -1) return { calls, cleaned: content };

  // attrRe matches a single  key="val" | key='val' | key=true|false|number  pair.
  const attrRe = /([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|true|false|-?\d+(?:\.\d+)?)/g;
  const parseAttrs = (segment: string): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    attrRe.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(segment)) !== null) {
      const key = a[1];
      const raw = a[2];
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        args[key] = raw.slice(1, -1).replace(/\\(["'\\])/g, '$1');
      } else if (raw === 'true' || raw === 'false') {
        args[key] = raw === 'true';
      } else {
        args[key] = Number(raw);
      }
    }
    return args;
  };

  const removeRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;

  // Form A: [ tool_name <newline> key=val key="val" ... ]  — attrs INSIDE the
  // brackets, may span newlines.
  const blockRe = /\[[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*[\n\r][\s\S]*?\]/g;
  while ((m = blockRe.exec(content)) !== null) {
    const name = m[1];
    if (!knownToolNames.has(name)) continue;
    const args = parseAttrs(m[0]);
    if (Object.keys(args).length === 0) continue; // no key=value pairs → not a tool call
    calls.push({ id: `bracket_${Date.now()}_${calls.length}`, name, arguments: args });
    removeRanges.push([m.index, m.index + m[0].length]);
  }

  // Form B: *[tool_name]* key="val" key="val" ...  — the tool name in brackets
  // (optionally wrapped in markdown asterisks) followed by attrs OUTSIDE the
  // brackets on the same line. This is how Qwen sometimes "speaks" a tool call
  // inline, e.g.  *[remember]* title="…" content="…"  — without salvaging it,
  // the raw syntax leaks into the delivered/spoken message instead of executing.
  const labeledRe = /(\*{0,3})\[[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*\]\1[ \t]*((?:[a-zA-Z_][a-zA-Z0-9_]*[ \t]*=[ \t]*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|true|false|-?\d+(?:\.\d+)?)[ \t,]*)+)/g;
  while ((m = labeledRe.exec(content)) !== null) {
    const name = m[2];
    if (!knownToolNames.has(name)) continue;
    const args = parseAttrs(m[3]);
    if (Object.keys(args).length === 0) continue;
    calls.push({ id: `label_${Date.now()}_${calls.length}`, name, arguments: args });
    removeRanges.push([m.index, m.index + m[0].length]);
  }

  // Strip every matched span from the saved/spoken text. The two forms can
  // interleave by position, so sort ascending and merge any overlap before
  // removing back-to-front (keeps earlier indices valid; avoids corruption).
  removeRanges.sort((p, q) => p[0] - q[0]);
  const merged: Array<[number, number]> = [];
  for (const r of removeRanges) {
    const last = merged[merged.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let cleaned = content;
  for (let i = merged.length - 1; i >= 0; i--) {
    const [s, e] = merged[i];
    cleaned = cleaned.slice(0, s) + cleaned.slice(e);
  }
  return { calls, cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * Parse captured <tool_call> XML blocks into structured tool calls.
 * Handles three formats:
 *   1. JSON body (Hermes): {"name":"tool_name","arguments":{...}}
 *   2. Anthropic-style: <function=tool_name><parameter=key>value</parameter>...</function>
 *      (observed from Qwen 3.6 35B-A3B emitting via reasoning_content)
 *   3. arg_key/arg_value: tool_name<arg_key>k</arg_key><arg_value>v</arg_value>...
 */
export function parseXmlToolCalls(
  xmlBlocks: string[],
): { id: string; name: string; arguments: Record<string, unknown> }[] {
  const results: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

  // Coerce a string value to boolean/number when it looks like one. Used by
  // formats 2 and 3 below (JSON format already has typed values).
  const coerce = (raw: string): unknown => {
    const trimmed = raw.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed !== '' && !isNaN(Number(trimmed))) return Number(trimmed);
    return raw; // preserve original whitespace for strings (callers may want it)
  };

  for (let i = 0; i < xmlBlocks.length; i++) {
    const xml = xmlBlocks[i].trim();

    // Format 1: JSON body — {"name": "tool_name", "arguments": {...}}
    const jsonMatch = xml.match(/^\s*(\{[\s\S]*\})\s*$/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.name) {
          results.push({
            id: `xmltc_${Date.now()}_${i}`,
            name: parsed.name,
            arguments: parsed.arguments || parsed.params || {},
          });
          continue;
        }
      } catch { /* fall through */ }
    }

    // Format 2: Anthropic-style nested tags — <function=NAME><parameter=KEY>VALUE</parameter>...</function>
    // Some local model templates (Qwen 3.6 35B-A3B) emit this shape inside a
    // <tool_call> wrapper. The wrapper is already stripped by the streaming
    // filter; we receive just the <function=...>...</function> body here.
    const fnMatch = xml.match(/<function\s*=\s*([\w.-]+)\s*>/);
    if (fnMatch) {
      const name = fnMatch[1];
      const args: Record<string, unknown> = {};
      const paramRegex = /<parameter\s*=\s*([\w.-]+)\s*>([\s\S]*?)<\/parameter>/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRegex.exec(xml)) !== null) {
        args[pm[1]] = coerce(pm[2].trim());
      }
      if (Object.keys(args).length > 0) {
        results.push({ id: `xmltc_${Date.now()}_${i}`, name, arguments: args });
        continue;
      }
    }

    // Format 3: arg_key/arg_value pairs — tool_name<arg_key>k</arg_key><arg_value>v</arg_value>...
    const nameMatch = xml.match(/^\s*(\w+)/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const args: Record<string, unknown> = {};
    const argRegex = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
    let match;
    while ((match = argRegex.exec(xml)) !== null) {
      args[match[1].trim()] = coerce(match[2]);
    }

    if (name && Object.keys(args).length > 0) {
      results.push({ id: `xmltc_${Date.now()}_${i}`, name, arguments: args });
    }
  }

  return results;
}

/**
 * Rescue workspace_write_file tool calls with broken JSON arguments.
 * Models often fail to properly escape code content in JSON strings, producing
 * arguments like raw code mixed with partial JSON. This extracts the path and
 * content from the mangled arguments using regex patterns.
 */
export function tryRescueWriteFile(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.length < 10) return null;

  // Strategy 1: Extract path from JSON-like prefix, treat rest as content
  // Pattern: {"path": "some/file.ext", "content": "...broken code..."
  const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/);
  if (pathMatch) {
    const filePath = pathMatch[1];
    // Find where content value starts
    const contentKeyMatch = raw.match(/"content"\s*:\s*"/);
    if (contentKeyMatch && contentKeyMatch.index !== undefined) {
      const contentStart = contentKeyMatch.index + contentKeyMatch[0].length;
      // Everything after "content": " is the raw content (may have broken escaping)
      let content = raw.slice(contentStart);
      // Strip trailing "} or similar JSON artifacts
      content = content.replace(/"\s*\}\s*$/, '');
      // Unescape what we can
      content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      if (content.length > 0) {
        console.log(`   🔧 Rescued workspace_write_file: path="${filePath}", content=${content.length} chars`);
        return { path: filePath, content };
      }
    }
  }

  // Strategy 2: Path embedded in raw code dump — find path-like patterns
  // Model output: raw code... {"path": "file.ext"... (JSON mixed into end)
  const latePathMatch = raw.match(/\{"path"\s*:\s*"([^"]+)"/);
  if (latePathMatch && latePathMatch.index !== undefined) {
    const filePath = latePathMatch[1];
    // Everything before the JSON is likely the content
    const content = raw.slice(0, latePathMatch.index);
    if (content.length > 10) {
      console.log(`   🔧 Rescued workspace_write_file (late path): path="${filePath}", content=${content.length} chars`);
      return { path: filePath, content };
    }
  }

  // Strategy 3: No JSON structure at all, but we know it's workspace_write_file.
  // Check if the raw string looks like code with a recognizable file path in the
  // first or last few lines (models sometimes include the filename as a comment).
  // The trailing (?=\s|$) anchor prevents URL-shaped matches: "github.com" used
  // to capture as "github.c" because \S+ greedy-backtracked into the .c branch.
  // We also reject anything containing :// (URL) or whitespace before the path.
  const firstLine = raw.split('\n')[0] || '';
  const fileExtMatch = firstLine.match(/(?:\/\/|#|--)\s*(?:File:\s*)?(\S+\.(?:ino|py|ts|js|cpp|c|h|yaml|yml|json|md))(?=\s|$)/i);
  if (fileExtMatch && !/:\/\//.test(fileExtMatch[1])) {
    console.log(`   🔧 Rescued workspace_write_file (comment path): path="${fileExtMatch[1]}", content=${raw.length} chars`);
    return { path: fileExtMatch[1], content: raw };
  }

  return null;
}

/**
 * Generic rescue for any tool call with content-heavy fields (title+content,
 * name+body, etc.) where JSON was truncated mid-value. Extracts all parseable
 * key-value pairs from the broken JSON using regex.
 *
 * Handles patterns like: {"title": "My Report", "content": "# Intro...
 * where the last string value is truncated and the JSON is invalid.
 */
export function tryRescueContentTool(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.length < 10) return null;

  const result: Record<string, unknown> = {};

  // Extract all complete "key": "value" pairs (value fully closed with ")
  const completePairs = raw.matchAll(/"([a-zA-Z_]\w*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
  for (const match of completePairs) {
    let value = match[2];
    // Unescape JSON string escapes
    value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    result[match[1]] = value;
  }

  // Extract complete "key": number/boolean/null pairs
  const literalPairs = raw.matchAll(/"([a-zA-Z_]\w*)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?)/g);
  for (const match of literalPairs) {
    const val = match[2];
    if (val === 'true') result[match[1]] = true;
    else if (val === 'false') result[match[1]] = false;
    else if (val === 'null') result[match[1]] = null;
    else result[match[1]] = Number(val);
  }

  // Try to rescue the last truncated string value (the one that was cut off)
  // Find the last "key": " that doesn't have a matching close quote
  const lastKeyMatch = [...raw.matchAll(/"([a-zA-Z_]\w*)"\s*:\s*"/g)].pop();
  if (lastKeyMatch && lastKeyMatch.index !== undefined) {
    const key = lastKeyMatch[1];
    const valueStart = lastKeyMatch.index + lastKeyMatch[0].length;
    // Check if this key already has a complete value (was captured above)
    if (!result[key] || (typeof result[key] === 'string' && (result[key] as string).length === 0)) {
      let truncatedValue = raw.slice(valueStart);
      // Strip trailing broken JSON artifacts
      truncatedValue = truncatedValue.replace(/\\$/, ''); // trailing backslash
      truncatedValue = truncatedValue.replace(/"\s*[}\]]*\s*$/, ''); // trailing close
      // Unescape
      truncatedValue = truncatedValue.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (truncatedValue.length > 0) {
        result[key] = truncatedValue;
      }
    }
  }

  // Must have extracted at least one field to be useful
  if (Object.keys(result).length === 0) return null;

  console.log(`   🔧 Rescued tool call via content extraction: ${JSON.stringify(Object.keys(result))}`);
  return result;
}

// Extract tool calls from the LLM's text when it describes tool actions but doesn't
// emit structured tool_calls (common with local models that ignore tool_choice=required).
// Instead of nudging and hoping the model will emit structured calls, we parse what
// it already said and construct the call directly.
export function extractToolCallFromText(
  llmText: string,
  userMessage: string,
  availableToolNames: Set<string>,
): { id: string; name: string; arguments: Record<string, unknown> } | null {
  const lower = llmText.toLowerCase();
  const trimmed = llmText.trim();

  // First try: raw tool call syntax — model emits "tool_name{json}" or "tool_name {json}" as text
  // Common with Mistral Large 3 and other models that echo tool call format without using structured calls
  const rawCallMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{[\s\S]*\})\s*$/);
  if (rawCallMatch) {
    const toolName = rawCallMatch[1];
    if (availableToolNames.has(toolName)) {
      try {
        const args = JSON.parse(rawCallMatch[2]);
        return {
          id: `extracted_${Date.now()}`,
          name: toolName,
          arguments: args,
        };
      } catch { /* JSON parse failed, continue to other patterns */ }
    }
  }

  // Second try: look for JSON tool call blocks in the text (some models emit these inline)
  // Matches patterns like: {"name": "generate_image", "arguments": {...}}
  // or ```json\n{"name": "tool", ...}\n```
  const jsonBlockMatch = llmText.match(/```(?:json)?\s*\n?\s*(\{[\s\S]*?"name"\s*:\s*"(\w+)"[\s\S]*?\})\s*\n?\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed.name && availableToolNames.has(parsed.name)) {
        return {
          id: `extracted_${Date.now()}`,
          name: parsed.name,
          arguments: parsed.arguments || parsed.params || {},
        };
      }
    } catch { /* continue to pattern matching */ }
  }

  // Second try: intent-based extraction from natural language
  // Generate image — the most common failure case
  if (availableToolNames.has('generate_image') &&
    /(?:generat|creat|mak|produc|render|draw|design|craft)\w*\s+(?:\d+\s+)?(?:unique\s+|some\s+|a\s+|an\s+|the\s+|your\s+|my\s+)?(?:image|selfie|portrait|picture|photo|illustration|artwork)/i.test(lower)) {
    return {
      id: `extracted_${Date.now()}`,
      name: 'generate_image',
      arguments: { prompt: userMessage },
    };
  }

  // Get weather
  if (availableToolNames.has('get_weather') &&
    /(?:check|get|fetch|look\w* up)\w*\s+(?:the\s+)?(?:weather|forecast|temperature)/i.test(lower)) {
    // Extract location if mentioned, otherwise call with no args (uses configured home location)
    const locationMatch = llmText.match(/(?:weather|forecast)\s+(?:in|for|at)\s+["']?([A-Z][a-zA-Z\s,]+)/);
    return {
      id: `extracted_${Date.now()}`,
      name: 'get_weather',
      arguments: locationMatch ? { location: locationMatch[1].trim() } : {},
    };
  }

  // Web search
  if (availableToolNames.has('web_search') &&
    /(?:search|look\w* up|find\w* out|google|query)\w*\s+(?:the\s+web\s+)?(?:for\s+|about\s+)?/i.test(lower)) {
    return {
      id: `extracted_${Date.now()}`,
      name: 'web_search',
      arguments: { query: userMessage },
    };
  }

  // Analyze image
  if (availableToolNames.has('analyze_image') &&
    /(?:analyz|examin|describ|look\s+at|inspect)\w*\s+(?:the\s+|this\s+|that\s+|your\s+)?(?:image|photo|picture)/i.test(lower)) {
    // Try to extract image_id from text
    const idMatch = llmText.match(/image[_\s]?id[:\s=]+["']?([a-zA-Z0-9_-]+)/i);
    if (idMatch) {
      return {
        id: `extracted_${Date.now()}`,
        name: 'analyze_image',
        arguments: { image_id: idMatch[1] },
      };
    }
  }

  // Create reminder
  if (availableToolNames.has('create_reminder') &&
    /(?:remind|set\w*\s+(?:a\s+)?reminder|creat\w*\s+(?:a\s+)?reminder)/i.test(lower)) {
    // Try to extract time from the text
    const timeMatch = llmText.match(/(?:at|for)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))/i);
    const textMatch = llmText.match(/remind\w*\s+(?:you\s+)?(?:to\s+|about\s+)?["']?(.+?)["']?\s*(?:at|for|\.|$)/i);
    const args: Record<string, unknown> = { text: textMatch ? textMatch[1].trim() : userMessage };
    if (timeMatch) {
      // Normalize to colon format: "8pm" → "8:00 PM"
      let t = timeMatch[1].trim();
      const bare = t.match(/^(\d{1,2})\s*(AM|PM)$/i);
      if (bare) t = `${bare[1]}:00 ${bare[2].toUpperCase()}`;
      args.time = t;
    }
    return {
      id: `extracted_${Date.now()}`,
      name: 'create_reminder',
      arguments: args,
    };
  }

  // Send notification
  if (availableToolNames.has('send_notification') &&
    /(?:send|push)\w*\s+(?:a\s+)?(?:notification|message|alert)/i.test(lower)) {
    const msgMatch = llmText.match(/(?:message|notification|alert)[:\s]+["'](.+?)["']/i);
    return {
      id: `extracted_${Date.now()}`,
      name: 'send_notification',
      arguments: { message: msgMatch ? msgMatch[1] : userMessage },
    };
  }

  // Workspace list files
  if (availableToolNames.has('workspace_list_files') &&
    /(?:list|check|browse|show|view)\w*\s+(?:the\s+)?(?:files?|folder|directory|project)/i.test(lower)) {
    const folderMatch = llmText.match(/(?:in|from|folder|project)\s+["']?([a-zA-Z0-9_\-/]+)/i);
    return {
      id: `extracted_${Date.now()}`,
      name: 'workspace_list_files',
      arguments: folderMatch ? { path: folderMatch[1] } : {},
    };
  }

  // Delegate to another choom
  if (availableToolNames.has('delegate_to_choom') &&
    /(?:delegat|ask|send|forward|pass)\w*\s+(?:this\s+)?(?:to|task)\s+/i.test(lower)) {
    const choomMatch = llmText.match(/(?:to|ask)\s+(Genesis|Anya|Optic|Aloy|Nyx)\b/i);
    if (choomMatch) {
      return {
        id: `extracted_${Date.now()}`,
        name: 'delegate_to_choom',
        arguments: { choom_name: choomMatch[1], task: userMessage },
      };
    }
  }

  // Home assistant - turn on/off
  if (availableToolNames.has('ha_call_service') &&
    /(?:turn|switch)\s+(?:on|off)\s+(?:the\s+)?/i.test(lower)) {
    // Can't reliably extract entity_id from natural language, skip
    return null;
  }

  // Remember / save memory — broad matching for LLM text describing a save/store action
  // Also check user message for explicit remember requests the LLM acknowledged but didn't tool-call
  const userLower = userMessage.toLowerCase();
  const describesRemember = /(?:(?:remember|sav|stor|not|record|keep|memoriz)\w*\s+(?:that|this|it|your |the |my )|(?:i'?ll |let me |i'?m going to )(?:remember|save|store|note|record|keep)|(?:i'?ve |i have )?(?:stored|saved|noted|recorded|memorized|remembered)\s+(?:that|this|it|your|the)|use (?:the )?remember)/i.test(lower);
  const userAskedRemember = /(?:(?:please |can you |you should )remember (?:that|this|my|i |the |for )|(?<!i )(?<!i'll )remember (?:that |this |my |i |the |for )|(?:don'?t |never )forget |(?:save|store|note|keep) (?:this|that|my|the |it )|use (?:the )?remember)/i.test(userLower);
  if (availableToolNames.has('remember') && (describesRemember || userAskedRemember)) {
    // Try to extract a meaningful title from the user message
    const titleMatch = userMessage.match(/(?:remember|save|store|note|keep|don'?t forget)\s+(?:that\s+)?(.{5,60}?)(?:\.|$)/i);
    const title = titleMatch ? titleMatch[1].trim().slice(0, 60) : 'User memory';
    return {
      id: `extracted_${Date.now()}`,
      name: 'remember',
      arguments: { title, content: userMessage },
    };
  }

  // Search memories
  if (availableToolNames.has('search_memories') &&
    /(?:search|check|look\w* (?:through|in)|recall)\s+(?:my\s+)?(?:memor|notes|knowledge)/i.test(lower)) {
    return {
      id: `extracted_${Date.now()}`,
      name: 'search_memories',
      arguments: { query: userMessage },
    };
  }

  return null;
}
