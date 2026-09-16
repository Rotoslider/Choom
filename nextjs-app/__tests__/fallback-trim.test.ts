/** 2026-09-16: a local fallback gets a transcript it can prefill in time. */
import { trimForLocalFallback } from '@/lib/fallback-trim';
import type { ChatMessage } from '@/lib/llm-client';

const est = (m: ChatMessage) => Math.ceil(((m.content as string) || '').length / 4) + 4;
const u = (t: string): ChatMessage => ({ role: 'user', content: t } as ChatMessage);
const a = (t: string, tools = false): ChatMessage => ({ role: 'assistant', content: t, ...(tools ? { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] } : {}) } as ChatMessage);
const tool = (t: string): ChatMessage => ({ role: 'tool', content: t, tool_call_id: 'c1', name: 'x' } as ChatMessage);

describe('trimForLocalFallback', () => {
  const sys: ChatMessage = { role: 'system', content: 'S'.repeat(400) } as ChatMessage;
  const big = 'x'.repeat(4000); // ~1000 tokens each
  const msgs = [sys, u(big), a(big), u(big), a(big, true), tool(big), a(big), u('latest question')];

  test('keeps the newest whole groups within the budget and marks the cut', () => {
    const r = trimForLocalFallback(msgs, 2600, est);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.messages[0]).toBe(sys);
    expect(r.messages[1].role).toBe('user');
    expect(String(r.messages[1].content)).toContain('left out');
    expect(r.messages[r.messages.length - 1].content).toBe('latest question');
    expect(r.tokensAfter).toBeLessThanOrEqual(2600 + 50);
    // the kept history starts on a user message, never on a tool result
    expect(r.messages[2].role).toBe('user');
  });

  test('a tool result never survives without the assistant turn that called it', () => {
    const r = trimForLocalFallback([sys, u(big), a(big, true), tool(big), u('now')], 1500, est);
    const roles = r.messages.map(m => m.role);
    if (roles.includes('tool')) expect(roles[roles.indexOf('tool') - 1]).toBe('assistant');
  });

  test('a transcript that already fits is returned untouched', () => {
    const small = [sys, u('hi'), a('hello'), u('how are you')];
    const r = trimForLocalFallback(small, 20_000, est);
    expect(r.messages).toBe(small); expect(r.dropped).toBe(0);
  });

  test('the loop applies it only to local, non-retry fallbacks and adopts the trimmed transcript on success', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8') as string;
    expect(src).toContain('if (fbIsLocal && !fb.sameModelRetry) {');
    expect(src).toContain('client: fbClient, messages: fbMessages,');
    expect(src).toContain('if (fbMessages !== currentMessages) {');
    // a cloud prefill timeout gets one same-model retry; stalls and dead connections still escalate
    expect(src).toContain("const prefillTimeout = /connected but no content/.test(errMsg);");
    expect(src).toContain('&& !prefillTimeout) {');
    // LLM streams are not subject to the 300 s default body timeout
    const client = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'llm-client.ts'), 'utf-8') as string;
    expect(client).toContain('new Agent({ bodyTimeout: 0, headersTimeout: 0 })');
    expect(client).not.toMatch(/await fetch\(url, \{\s*method: 'POST'/);
  });
});
