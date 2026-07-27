/**
 * Tests for lib/tool-call-parsing.ts — the layer that recovers tool calls from
 * models that emit them as text instead of via the structured API.
 *
 * This was ~1,050 lines living inside the request handler in route.ts, so none
 * of it could be unit-tested; the existing "tests" grepped route.ts for
 * substrings like 'pendingBuffer' and 'OPEN_TAG.startsWith(tail)', which
 * assert nothing about behaviour and break the moment the code moves.
 *
 * The stream filters are the subtle part: they are fed arbitrary chunk
 * boundaries and must never leak raw markup to the user, never drop real
 * prose, and still capture the call.
 */
import {
  createToolCallXmlFilter,
  createThinkFilter,
  createJsonToolCallFilter,
  tryRepairJSON,
  extractMistralToolCalls,
  parseXmlToolCalls,
} from '../lib/tool-call-parsing';

/** Feed a string through a filter one chunk at a time, then flush. */
function stream(filter: { filter: (t: string) => string; flush: () => string }, chunks: string[]): string {
  return chunks.map(c => filter.filter(c)).join('') + filter.flush();
}

describe('createToolCallXmlFilter', () => {
  it('strips a whole tool_call block and captures its body', () => {
    const f = createToolCallXmlFilter();
    const out = stream(f, ['Sure thing. <tool_call>{"name":"get_weather"}</tool_call> Done.']);
    expect(out).toBe('Sure thing.  Done.');
    expect(f.getCaptured()).toEqual(['{"name":"get_weather"}']);
  });

  it('handles an open tag split across chunk boundaries', () => {
    // The exact case the old test tried to assert by grepping for a variable name.
    const f = createToolCallXmlFilter();
    const out = stream(f, ['Hello <tool', '_call>{"name":"x"}</tool_call> bye']);
    expect(out).toBe('Hello  bye');
    expect(f.getCaptured()).toEqual(['{"name":"x"}']);
  });

  it('handles a tag split one character at a time', () => {
    const f = createToolCallXmlFilter();
    const src = 'a<tool_call>{"name":"y"}</tool_call>b';
    const out = stream(f, src.split(''));
    expect(out).toBe('ab');
    expect(f.getCaptured()).toEqual(['{"name":"y"}']);
  });

  /**
   * Regression: the CLOSING tag had no split-across-chunks handling, only the
   * opening one did. "</tool_call>" is commonly several tokens ("</", "tool",
   * "_call", ">"), so a boundary inside it left the filter stuck inBlock:
   * everything after the tool call was swallowed instead of shown (the Choom
   * went silent after using a tool), and the captured block came out as
   * '{"n":1}</tool_call>post' — polluted, so argument parsing failed too.
   */
  describe.each([
    ['</tool | _call>', ['pre<tool_call>{"n":1}</tool', '_call>post']],
    ['</ | tool_call>', ['pre<tool_call>{"n":1}</', 'tool_call>post']],
    ['</tool_call | >', ['pre<tool_call>{"n":1}</tool_call', '>post']],
  ])('closing tag split as %s', (_label, chunks) => {
    it('shows the trailing text and captures a clean block', () => {
      const f = createToolCallXmlFilter();
      expect(stream(f, chunks as string[])).toBe('prepost');
      expect(f.getCaptured()).toEqual(['{"n":1}']);
    });
  });

  it('does not treat a < inside the block body as a close tag', () => {
    const f = createToolCallXmlFilter();
    const out = stream(f, ['<tool_call>{"expr":"5 < 10"}</tool_call>x']);
    expect(out).toBe('x');
    expect(f.getCaptured()).toEqual(['{"expr":"5 < 10"}']);
  });

  it('never leaks a partial closing tag into visible text', () => {
    // A fragment held back while inBlock is block content, not prose — it must
    // not surface as a stray "</to" in the chat on flush.
    const f = createToolCallXmlFilter();
    const out = stream(f, ['pre<tool_call>{"n":1}</to']);
    expect(out).toBe('pre');
    expect(out).not.toContain('</to');
  });

  it('does not swallow a lone < that is not a tool_call', () => {
    const f = createToolCallXmlFilter();
    expect(stream(f, ['5 < 10 and 3 > 2'])).toBe('5 < 10 and 3 > 2');
    expect(f.getCaptured()).toEqual([]);
  });

  it('does not swallow an unrelated tag that shares a prefix', () => {
    const f = createToolCallXmlFilter();
    expect(stream(f, ['<toolbox> is a word'])).toBe('<toolbox> is a word');
  });

  it('flush() releases a partial tag that never completed', () => {
    // Model stopped mid-tag: the user must still see the text, not lose it.
    const f = createToolCallXmlFilter();
    expect(stream(f, ['trailing <too'])).toBe('trailing <too');
  });

  it('flush() captures a block truncated by end-of-stream', () => {
    // Token limit hit mid-tool-call; capture what we have so the JSON repairer
    // downstream gets a chance at it.
    const f = createToolCallXmlFilter();
    const out = stream(f, ['<tool_call>{"name":"get_wea']);
    expect(out).toBe('');
    expect(f.getCaptured()).toEqual(['{"name":"get_wea']);
  });

  it('handles two tool calls in one stream', () => {
    const f = createToolCallXmlFilter();
    const out = stream(f, ['<tool_call>{"a":1}</tool_call>mid<tool_call>{"b":2}</tool_call>']);
    expect(out).toBe('mid');
    expect(f.getCaptured()).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('createThinkFilter', () => {
  it('removes a think block from the visible stream', () => {
    const f = createThinkFilter();
    const out = ['Hi <think>internal reasoning</think> there'].map(f).join('');
    expect(out).not.toContain('internal reasoning');
    expect(out).toContain('Hi');
    expect(out).toContain('there');
  });

  it('leaves ordinary text untouched', () => {
    const f = createThinkFilter();
    expect(['just a normal reply'].map(f).join('')).toBe('just a normal reply');
  });
});

describe('tryRepairJSON', () => {
  it('parses already-valid JSON', () => {
    expect(tryRepairJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it('closes an unterminated object', () => {
    expect(tryRepairJSON('{"path":"notes.md"')).toEqual({ path: 'notes.md' });
  });

  it('closes an unterminated string and object', () => {
    const r = tryRepairJSON('{"path":"notes.md","content":"hello wor');
    expect(r).not.toBeNull();
    expect(r!.path).toBe('notes.md');
  });

  it('does not miscount braces that appear inside a string', () => {
    // The whole reason this uses a state machine: code in a content field.
    const r = tryRepairJSON('{"content":"function f() { return 1; }","path":"a.js"}');
    expect(r).toEqual({ content: 'function f() { return 1; }', path: 'a.js' });
  });

  it('returns null for undefined/empty input', () => {
    expect(tryRepairJSON(undefined)).toBeNull();
    expect(tryRepairJSON('')).toBeNull();
  });
});

describe('extractMistralToolCalls', () => {
  it('returns the content untouched when there is no marker', () => {
    const r = extractMistralToolCalls('just talking', new Set(['get_weather']));
    expect(r.calls).toEqual([]);
    expect(r.cleaned).toBe('just talking');
  });

  it('ignores a marker naming an unknown tool', () => {
    const r = extractMistralToolCalls('[TOOL_CALLS] not_a_real_tool{"x":1}', new Set(['get_weather']));
    expect(r.calls).toEqual([]);
  });
});

describe('parseXmlToolCalls', () => {
  it('parses the JSON dialect', () => {
    const calls = parseXmlToolCalls(['{"name":"get_weather","arguments":{"location":"Rodeo,NM,US"}}']);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('get_weather');
    expect(calls[0].arguments).toEqual({ location: 'Rodeo,NM,US' });
  });

  it('ignores an unparseable block rather than throwing', () => {
    expect(() => parseXmlToolCalls(['<<<garbage>>>'])).not.toThrow();
  });
});

describe('createJsonToolCallFilter', () => {
  it('passes ordinary prose through unchanged', () => {
    const f = createJsonToolCallFilter();
    expect(stream(f, ['Just a normal sentence.'])).toBe('Just a normal sentence.');
    expect(f.getCaptured()).toEqual([]);
  });
});
