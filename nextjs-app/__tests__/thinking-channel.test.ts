/**
 * Thinking never reaches the reply (and so never the DB, Signal, or TTS).
 * It travels on its own 'thinking' stream event — display only (2026-09-17).
 */
import { readLlmStream, newStreamState } from '../lib/llm-stream-reader';
import type { ChatCompletionChunk } from '../lib/llm-client';

type Delta = { content?: string; reasoning_content?: string };
function fakeClient(deltas: Delta[]) {
  return {
    async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
      for (const delta of deltas) {
        yield { choices: [{ delta, finish_reason: null }] } as unknown as ChatCompletionChunk;
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] } as unknown as ChatCompletionChunk;
    },
  };
}

async function run(deltas: Delta[], enableThinking: boolean | undefined) {
  const sent: Record<string, unknown>[] = [];
  const st = newStreamState();
  await readLlmStream(st, {
    client: fakeClient(deltas) as unknown as Parameters<typeof readLlmStream>[1]['client'],
    messages: [], tools: [], toolChoice: undefined, enableThinking,
    tier: 'local', timeoutMs: 5000, send: (d) => sent.push(d), bufferForDedup: false, choomTag: '[T]',
  });
  const thinking = sent.filter(e => e.type === 'thinking').map(e => e.content).join('');
  const content = sent.filter(e => e.type === 'content').map(e => e.content).join('');
  return { st, thinking, content };
}

describe('thinking channel is display-only', () => {
  test('reasoning_content with thinking on streams as thinking events, never content', async () => {
    const r = await run([
      { reasoning_content: 'Let me parse what is happening: ' },
      { reasoning_content: 'Donny wants clear panels.' },
      { content: 'Clear panels it is, love.' },
    ], undefined);
    expect(r.thinking).toBe('Let me parse what is happening: Donny wants clear panels.');
    expect(r.content).toBe('Clear panels it is, love.');
    expect(r.st.content).toBe('Clear panels it is, love.');
    expect(r.st.content).not.toContain('Let me parse');
  });

  test('<think> blocks in content go to the thinking box and are stripped from the reply', async () => {
    const r = await run([{ content: '<think>plan: be warm</think>' }, { content: 'Hello, love.' }], undefined);
    expect(r.thinking).toBe('plan: be warm');
    expect(r.content).toBe('Hello, love.');
    expect(r.st.content).toBe('Hello, love.');
  });

  test('with thinking off, reasoning_content is buffered for the loop to judge, not streamed as the reply', async () => {
    const r = await run([{ reasoning_content: 'The user wants me to check the printer.' }], false);
    expect(r.content).toBe('');
    expect(r.st.content).toBe('');
    expect(r.st.reasoningProse).toBe('The user wants me to check the printer.');
  });
});
