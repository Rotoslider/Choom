/**
 * Anthropic adapter: the request each Claude model accepts (no temperature or
 * forced tool call on current models), thinking blocks carried through the tool
 * loop, cached prompt tokens counted, keep-alive chunks while the model thinks.
 */
import {
  AnthropicClient,
  claudeModelTraits,
  withReplayedThinking,
  usageFromAnthropic,
  forgetThinking,
} from '@/lib/anthropic-client';
import type { ChatMessage, ChatCompletionChunk } from '@/lib/llm-client';
import type { LLMSettings, ToolDefinition } from '@/lib/types';

const TOOLS: ToolDefinition[] = [{
  name: 'get_time',
  description: 'Get the time in a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
} as unknown as ToolDefinition];

function sse(events: object[]): { ok: true; body: { getReader(): unknown } } {
  const text = events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes })),
        releaseLock: () => {},
      }),
    },
  };
}

const TOOL_TURN = [
  { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 4, cache_read_input_tokens: 2400, cache_creation_input_tokens: 100, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-A' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_A', name: 'get_time', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"Tokyo"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 4, cache_read_input_tokens: 2400, cache_creation_input_tokens: 100, output_tokens: 90 } },
  { type: 'message_stop' },
];

const END_TURN = [
  { type: 'message_start', message: { id: 'msg_2', model: 'claude-opus-5-5', usage: { input_tokens: 2 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is 14:05.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
];

let bodies: Record<string, unknown>[] = [];
let headers: Record<string, string>[] = [];
let replies: object[][] = [];

beforeEach(() => {
  forgetThinking();
  bodies = [];
  headers = [];
  replies = [];
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    headers.push(init?.headers as Record<string, string>);
    return sse(replies.shift() || END_TURN);
  }) as unknown as typeof fetch;
});

function client(model: string, endpoint = 'https://api.anthropic.com', extra: Partial<LLMSettings> = {}) {
  return new AnthropicClient({ model, temperature: 0.7, topP: 0.9, maxTokens: 32000, ...extra } as LLMSettings, 'k', endpoint);
}

async function drain(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const USER: ChatMessage[] = [
  { role: 'system', content: 'You are Genesis.' },
  { role: 'user', content: 'What time is it in Tokyo?' },
];

describe('claudeModelTraits', () => {
  it.each([
    ['claude-opus-5-5', false, false, false, true, true],
    ['claude-opus-5', false, true, false, true, false],
    ['claude-sonnet-5', false, true, false, false, false],
    ['claude-sonnet-5-5', false, false, false, true, true],
    ['claude-fable-5-1', false, false, false, true, true],
    ['claude-haiku-5-5', false, false, false, false, false],
    ['claude-opus-4-8', false, true, false, false, false],
    ['claude-opus-4-6', true, true, false, false, false],
    ['claude-sonnet-4-5-20250929', true, true, true, false, false],
    ['claude-haiku-4-5', true, true, true, false, false],
    ['claude-opus-4-20250514', true, true, true, false, false],
    ['anthropic/claude-opus-4.5', true, true, true, false, false],
    ['claude-3-7-sonnet-20250219', true, true, true, false, false],
    ['some-future-name', false, false, false, false, false],
  ])('%s', (model, sampling, forcedToolChoice, prefill, serverFallback, thinkingBinding) => {
    expect(claudeModelTraits(model as string)).toEqual({ sampling, forcedToolChoice, prefill, serverFallback, thinkingBinding });
  });
});

describe('request body', () => {
  it('Opus 5.5: no sampling, auto instead of forced, caching, fallback and thinking binding', async () => {
    await drain(client('claude-opus-5-5').streamChat(USER, TOOLS, undefined, 'required'));
    const b = bodies[0];
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
    expect(b.tool_choice).toEqual({ type: 'auto' });
    expect(b.cache_control).toEqual({ type: 'ephemeral' });
    expect(b.fallbacks).toBe('default');
    expect(b.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(b.max_tokens).toBe(32000);
    expect(b.system).toBe('You are Genesis.');
    expect(headers[0]['anthropic-beta']).toBe('server-side-fallback-2026-07-01,thinking-binding-controls-2026-08-01');
  });

  it('Opus 5: forced tool call still allowed, no thinking field', async () => {
    await drain(client('claude-opus-5').streamChat(USER, TOOLS, undefined, 'required'));
    expect(bodies[0].tool_choice).toEqual({ type: 'any' });
    expect(bodies[0].temperature).toBeUndefined();
    expect(bodies[0].thinking).toBeUndefined();
    expect(headers[0]['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
  });

  it('older model through a proxy: temperature only, no Anthropic-only fields', async () => {
    await drain(client('claude-sonnet-4-5', 'https://openrouter.ai/api').streamChat(USER, TOOLS, undefined, 'required'));
    const b = bodies[0];
    expect(b.temperature).toBe(0.7);
    expect(b.top_p).toBeUndefined();
    expect(b.tool_choice).toEqual({ type: 'any' });
    expect(b.cache_control).toBeUndefined();
    expect(b.fallbacks).toBeUndefined();
    expect(headers[0]['anthropic-beta']).toBeUndefined();
  });

  it('never ends on an assistant message for a model without prefill, and skips empty messages', async () => {
    await drain(client('claude-opus-5-5').streamChat([
      ...USER,
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'Half a thought' },
    ], TOOLS));
    const msgs = bodies[0].messages as { role: string; content: unknown }[];
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2].content).toBe('Continue.');
  });

  it('chat() (non-streaming) uses the same rules', async () => {
    global.fetch = jest.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 2 } }) };
    }) as unknown as typeof fetch;
    const r = await client('claude-opus-5-5').chat(USER);
    expect(bodies[0].temperature).toBeUndefined();
    expect(bodies[0].stream).toBe(false);
    expect(r.content).toBe('Hi');
    expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 7 } });
  });
});

describe('stream', () => {
  it('keeps the reader alive while thinking, streams text and the tool call, counts cached tokens', async () => {
    replies = [TOOL_TURN];
    const chunks = await drain(client('claude-opus-5-5').streamChat(USER, TOOLS));
    const deltas = chunks.map(c => c.choices[0].delta);
    const empties = chunks.filter(c => !c.choices[0].finish_reason && Object.keys(c.choices[0].delta).length === 0);
    expect(empties.length).toBeGreaterThanOrEqual(4); // message_start, thinking start, ping, thinking + signature deltas
    expect(deltas.map(d => d.content).filter(Boolean).join('')).toBe('Checking.');
    const toolChunks = deltas.filter(d => d.tool_calls).map(d => d.tool_calls![0]);
    expect(toolChunks[0]).toMatchObject({ index: 0, id: 'toolu_A', function: { name: 'get_time' } });
    expect(toolChunks[1]).toMatchObject({ index: 0, function: { arguments: '{"city":"Tokyo"}' } });
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe('tool_calls');
    expect(last.usage).toEqual({ prompt_tokens: 2504, completion_tokens: 90, total_tokens: 2594, prompt_tokens_details: { cached_tokens: 2400 } });
  });

  it('sends the thinking block back with the tool call on the next round', async () => {
    replies = [TOOL_TURN, END_TURN];
    const c = client('claude-opus-5-5');
    await drain(c.streamChat(USER, TOOLS));
    await drain(c.streamChat([
      ...USER,
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'toolu_A', type: 'function', function: { name: 'get_time', arguments: '{"city":"Tokyo"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_A', content: 'Tokyo: 14:05' },
    ], TOOLS));
    const msgs = bodies[1].messages as { role: string; content: { type: string; signature?: string; text?: string; id?: string }[] }[];
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(msgs[1].content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'SIG-A' });
    expect(msgs[1].content[1].text).toBe('Checking.');
    expect(msgs[1].content[2].id).toBe('toolu_A');
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_A' });
  });

  it('does not replay thinking through a proxy', async () => {
    replies = [TOOL_TURN, END_TURN];
    const c = client('claude-opus-5-5', 'https://openrouter.ai/api');
    await drain(c.streamChat(USER, TOOLS));
    await drain(c.streamChat([
      ...USER,
      { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_A', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'toolu_A', content: 'x' },
    ], TOOLS));
    const msgs = bodies[1].messages as { content: { type: string }[] }[];
    expect(msgs[1].content.map(b => b.type)).toEqual(['tool_use']);
  });

  it('drops what came before a mid-reply fallback', async () => {
    replies = [[
      { type: 'message_start', message: { id: 'm', model: 'claude-opus-5-5', usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'OLD' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } },
      { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '', signature: 'NEW' } },
      { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_B', name: 'get_time', input: {} } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    ], END_TURN];
    const c = client('claude-opus-5-5');
    await drain(c.streamChat(USER, TOOLS));
    await drain(c.streamChat([
      ...USER,
      { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_B', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'toolu_B', content: 'x' },
    ], TOOLS));
    const msgs = bodies[1].messages as { content: { type: string; signature?: string }[] }[];
    expect(msgs[1].content.map(b => b.signature ?? b.type)).toEqual(['NEW', 'tool_use']);
  });
});

describe('withReplayedThinking', () => {
  const t = (s: string) => ({ type: 'thinking' as const, thinking: '', signature: s });
  const use = { type: 'tool_use' as const, id: 'x', name: 'n', input: {} };
  it('keeps a progress note between the text and the tool call', () => {
    const out = withReplayedThinking([t('1'), { type: 'text' }, t('2'), { type: 'tool_use' }], 'Hi', [use]);
    expect(out.map(b => b.signature ?? b.type)).toEqual(['1', 'text', '2', 'tool_use']);
  });
  it('puts the loop text before the tools when the model wrote none', () => {
    const out = withReplayedThinking([t('1'), { type: 'tool_use' }], 'Hi', [use]);
    expect(out.map(b => b.signature ?? b.type)).toEqual(['1', 'text', 'tool_use']);
  });
  it('no text, no text block', () => {
    const out = withReplayedThinking([t('1'), { type: 'text' }, { type: 'tool_use' }], '', [use]);
    expect(out.map(b => b.signature ?? b.type)).toEqual(['1', 'tool_use']);
  });
});

describe('usageFromAnthropic', () => {
  it('nothing counted, nothing reported', () => {
    expect(usageFromAnthropic({})).toBeUndefined();
    expect(usageFromAnthropic(undefined)).toBeUndefined();
  });
});
