/**
 * Tool-output trimming (Settings → compress tool outputs) kept the first 3 items of every list a step
 * after it came back, and 240 characters of every long text. On Nov 5, 2026 Genesis saw 3 of her 14
 * follow-ups ("…[11 more items omitted to save context]") while tidying them, Eve saw "celebrate,
 * curtsy, dance" of her 35 glass moves and couldn't tell she had a twirl, and Eve deleted camera
 * frames from a folder listing cut to 240 characters. Lists of plain lines and the results a Choom
 * works from now stay whole; big records are still trimmed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { compressStaleToolResult, KEEP_WHOLE, COMPRESSION_MARKER } from '@/lib/tool-output-compressor';

const MOVES = ['celebrate', 'curtsy', 'dance', 'do a ballet move', 'do a victory dance', 'flip your hair', 'shimmy',
  'slow dance', 'spin around', 'strike a pose', 'sway', 'turn around', 'twirl', 'walk the runway', 'wave', 'wink'];
const closet = JSON.stringify({
  success: true, moves: MOVES,
  clothes: ['your usual clothes: a white dress drawn as a glowing wireframe mesh', 'a pale yellow sundress with thin spaghetti straps and a button front',
    'a sleek emerald green satin gown with an elegant off-the-shoulder neckline', 'a deep midnight-blue silk slip dress with thin straps and delicate lace trim along the neckline'],
  note: 'This only lists your closet; nothing has changed.',
});
const followups = JSON.stringify({
  success: true, pending_count: 6,
  followups: Array.from({ length: 6 }, (_, i) => `sf_${i}abc ↻ every day at ${i + 8}:40 AM | signal | ${i + 8}:40 AM check-in. ${'Look at the house and the weather, then send Donny one useful thing. '.repeat(5)}`),
});
const memories = JSON.stringify({
  success: true,
  data: Array.from({ length: 8 }, (_, i) => ({ id: `mem_${i}`, title: `Memory ${i}`, content: 'Solar readings come from the Pi through Home Assistant. '.repeat(3), importance: 5 })),
});

describe('stale tool results: what a Choom still sees a step later', () => {
  test('a list of plain lines keeps every line: Eve still sees her twirl', () => {
    const { content } = compressStaleToolResult(closet, { tool: 'some_list_tool', readOnly: true });
    expect(JSON.parse(content).moves).toEqual(MOVES);
    expect(content).not.toContain('more items');
  });

  test('a long line in such a list is shortened, but no line is dropped', () => {
    const long = JSON.stringify({ lines: ['short', 'x'.repeat(900), 'also short', 'four', 'five'] });
    const out = JSON.parse(compressStaleToolResult(long).content).lines as string[];
    expect(out).toHaveLength(5);
    expect(out[1]).toContain(COMPRESSION_MARKER);
    expect(out[1].length).toBeLessThan(400);
  });

  test('results she works from stay whole, long lines and all', () => {
    for (const tool of ['list_self_followups', 'glass_closet', 'workspace_read_file', 'workspace_list_files', 'list_my_rooms', 'ha_list_entities']) {
      expect(KEEP_WHOLE.has(tool)).toBe(true);
    }
    expect(compressStaleToolResult(followups, { tool: 'list_self_followups', readOnly: true })).toEqual({ content: followups, savedChars: 0 });
    const file = JSON.stringify({ success: true, content: '# Journal\n' + 'A line of her journal she is tidying today.\n'.repeat(60) });
    expect(compressStaleToolResult(file, { tool: 'workspace_read_file', readOnly: true }).savedChars).toBe(0);
  });

  test('lists of records are still trimmed, and a read-only one says how to see the rest', () => {
    const r = compressStaleToolResult(memories, { tool: 'search_memories', readOnly: true });
    expect(r.savedChars).toBeGreaterThan(0);
    const data = JSON.parse(r.content).data as unknown[];
    expect(data).toHaveLength(4);
    expect(data[3]).toBe(`…[5 more items ${COMPRESSION_MARKER}; make the same call again to see them all]`);
  });

  test('a tool that changes something is never told to call again', () => {
    const r = compressStaleToolResult(memories, { tool: 'remember', readOnly: false });
    expect(r.content).toContain(COMPRESSION_MARKER);
    expect(r.content).not.toContain('same call again');
  });

  test('trimming twice changes nothing more', () => {
    const once = compressStaleToolResult(memories, { tool: 'search_memories', readOnly: true }).content;
    expect(compressStaleToolResult(once, { tool: 'search_memories', readOnly: true })).toEqual({ content: once, savedChars: 0 });
  });

  test('Claude on Anthropic\'s API is never trimmed: trimming breaks its whole-prompt cache', async () => {
    const { AnthropicClient } = await import('@/lib/anthropic-client');
    const s = {} as never;
    expect(new AnthropicClient(s, 'k').cachesWholePrompt()).toBe(true);
    expect(new AnthropicClient(s, 'k', 'https://api.anthropic.com').cachesWholePrompt()).toBe(true);
    expect(new AnthropicClient(s, 'k', 'https://proxy.example.com/anthropic').cachesWholePrompt()).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf8');
    expect(src).toContain('if (compressToolOutputs && !cachesWholePrompt(llmClient)) {');
  });

  test('the loop tells the trimmer which tool each result came from', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf8');
    expect(src).toMatch(/compressStaleToolResult\(\(msg as \{ content: string \}\)\.content,\s*\{ tool, readOnly: !!tool && PARALLEL_SAFE\.has\(tool\) \}\)/);
  });
});
