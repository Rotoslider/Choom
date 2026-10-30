/**
 * 2026-10-30: Genesis asked herself about a fan's static pressure, searched, and
 * on the next round DeepSeek V4.1 Flash (OpenRouter, InferenceNet) thought for
 * 30 s and wrote nothing. OpenRouter streams thinking as delta.reasoning, which
 * nothing read, so the turn counted as empty; the same-model retry did the same,
 * and her reply went to the Mac's Qwen with 172 older messages trimmed away.
 * Thinking on that channel now counts as thinking (not shown), and a turn that
 * only thought gets the usual nudge to act, on the same model with the whole chat.
 */
import { readLlmStream, newStreamState } from '@/lib/llm-stream-reader';
import { runAgenticLoop, type AgenticLoopParams } from '@/lib/agentic-loop';
import { TraceBuilder } from '@/lib/execution-trace';
import { CompactionService } from '@/lib/compaction-service';
import { defaultLLMSettings } from '@/lib/chat-defaults';
import type { ChatCompletionChunk } from '@/lib/llm-client';
import type { ToolDefinition, ToolResult, LLMSettings } from '@/lib/types';

jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));
jest.mock('@/lib/tool-execution', () => ({
  executeToolCall: jest.fn(async (tc: { id: string; name: string }): Promise<ToolResult> => ({
    toolCallId: tc.id, name: tc.name, result: { ok: true, tool: tc.name },
  })),
  executeToolCallViaSkills: jest.fn(),
}));
jest.mock('@/lib/chat-shared', () => ({
  ...jest.requireActual('@/lib/chat-shared'),
  serverLog: jest.fn(),
}));

type Delta = { content?: string; reasoning?: string; reasoning_content?: string };
type Reply = { deltas: Delta[]; finish?: string };
type Msg = { role: string; content?: string };

const chunk = (delta: Delta, finish_reason: string | null = null): ChatCompletionChunk => ({
  id: 'c', object: 'chat.completion.chunk', created: 0, model: 'scripted',
  choices: [{ index: 0, delta: delta as ChatCompletionChunk['choices'][0]['delta'], finish_reason }],
} as ChatCompletionChunk);

function scriptedClient(replies: Reply[]) {
  const calls: Array<{ messages: Msg[] }> = [];
  return {
    calls,
    client: {
      settings: { ...defaultLLMSettings },
      async *streamChat(messages: Msg[], _tools: unknown, _signal: AbortSignal, _toolChoice: unknown, onConnected?: () => void) {
        calls.push({ messages: [...messages] });
        onConnected?.();
        const reply = replies.shift();
        if (!reply) throw new Error(`scripted client: no reply left for call #${calls.length}`);
        for (let i = 0; i < reply.deltas.length; i++) {
          yield chunk(reply.deltas[i], i === reply.deltas.length - 1 ? (reply.finish ?? 'stop') : null);
        }
      },
    },
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('the reader', () => {
  async function read(deltas: Delta[], enableThinking: boolean | undefined) {
    const sent: Record<string, unknown>[] = [];
    const st = newStreamState();
    const { client } = scriptedClient([{ deltas }]);
    await readLlmStream(st, {
      client: client as unknown as Parameters<typeof readLlmStream>[1]['client'],
      messages: [], tools: [], toolChoice: undefined, enableThinking,
      tier: 'local', timeoutMs: 5000, send: (d) => sent.push(d), bufferForDedup: false, choomTag: '[T]',
    });
    return { st, types: sent.map(e => e.type) };
  }

  test("OpenRouter's delta.reasoning counts as thinking, and is neither shown nor the reply", async () => {
    const r = await read([{ reasoning: 'Donny asked about the NF-A20. ' }, { reasoning: 'The search gave CFM but not mmH2O.' }], undefined);
    expect(r.st.thinkingChars).toBe(64);
    expect(r.st.content).toBe('');
    expect(r.st.reasoningProse).toBe('');
    expect(r.types).toEqual([]);
  });

  test('reasoning_content is still shown in the thinking box, and counted', async () => {
    const r = await read([{ reasoning_content: 'plan it' }, { content: 'Done, love.' }], undefined);
    expect(r.st.thinkingChars).toBe(7);
    expect(r.types).toEqual(['thinking', 'content']);
  });

  test('with thinking off, delta.reasoning is kept aside like reasoning_content', async () => {
    const r = await read([{ reasoning: 'The user wants me to check the printer.' }], false);
    expect(r.st.reasoningProse).toBe('The user wants me to check the printer.');
    expect(r.st.content).toBe('');
  });
});

describe('a turn that only thought', () => {
  function params(model: ReturnType<typeof scriptedClient>, llmSettings: LLMSettings): AgenticLoopParams {
    const message = 'What is the static pressure on the Noctua NF-A20?';
    return {
      send: () => {},
      sse: { closed: false },
      ctx: {} as AgenticLoopParams['ctx'],
      traceBuilder: new TraceBuilder({
        chatId: 'chat', choomId: 'choom', choomName: 'Genesis', model: 'primary', provider: 'cloud',
        endpoint: llmSettings.endpoint, isDelegation: false, isHeartbeat: false,
      } as ConstructorParameters<typeof TraceBuilder>[0]),
      currentMessages: [
        { role: 'system', content: 'You are Genesis.' },
        { role: 'user', content: message },
      ],
      activeTools: [] as ToolDefinition[],
      llmClient: model.client,
      llmSettings,
      clientLLMSettings: {},
      settings: {},
      providers: [],
      usingCloudProvider: true,
      resolvedProvider: 'cloud',
      fallbackConfigs: [],
      createClientForFallback: async () => { throw new Error('test: no fallback expected'); },
      taskOverrideActive: false,
      taskModelOverride: undefined,
      choom: { name: 'Genesis', llmTimeoutSec: 30 } as AgenticLoopParams['choom'],
      chat: { messages: [] } as unknown as AgenticLoopParams['chat'],
      choomId: 'choom', chatId: 'chat', logChatId: 'chat',
      message,
      isGroupTurn: false, isHeartbeat: false, isDelegation: false, noTools: false,
      suppressNotifications: true, freshContext: true,
      maxIterationsOverride: undefined,
      detectedProject: null,
      skillDispatch: false,
      compactionService: new CompactionService(llmSettings),
      systemPromptWithSummary: 'You are Genesis.',
      planFullySucceeded: false,
      maxIterations: 6,
      iterationCapLocked: false,
      fullContent: '',
      allToolCalls: [],
      allToolResults: [],
    } as unknown as AgenticLoopParams;
  }
  const lastUserNote = (messages: Msg[]) => [...messages].reverse().find(m => m.role === 'user')?.content;
  const REPLY = 'About 1.08 mm H2O at full speed, so it moves air well but won\'t push hard through a dense filter.';

  test('cut off while thinking: the limit is raised and she is nudged on the same model', async () => {
    const llmSettings: LLMSettings = { ...defaultLLMSettings, endpoint: 'https://openrouter.ai/api/v1', model: 'primary', maxTokens: 4096 };
    const model = scriptedClient([
      { deltas: [{ reasoning: 'Let me compare the NF-A20 numbers. '.repeat(40) }], finish: 'length' },
      { deltas: [{ content: REPLY }] },
    ]);
    const outcome = await runAgenticLoop(params(model, llmSettings));

    expect(model.calls).toHaveLength(2);
    expect(lastUserNote(model.calls[1].messages)).toMatch(/^\[System\] Your thinking ran past the output limit/);
    expect(llmSettings.maxTokens).toBe(8192);
    expect(outcome.fullContent.trim()).toBe(REPLY);
  });

  test('thought and stopped: nudged to act, never handed to a fallback', async () => {
    const llmSettings: LLMSettings = { ...defaultLLMSettings, endpoint: 'https://openrouter.ai/api/v1', model: 'primary', maxTokens: 4096 };
    const model = scriptedClient([
      { deltas: [{ reasoning: 'I have the airflow; I should answer.' }], finish: 'stop' },
      { deltas: [{ content: REPLY }] },
    ]);
    const outcome = await runAgenticLoop(params(model, llmSettings));

    expect(model.calls).toHaveLength(2);
    expect(lastUserNote(model.calls[1].messages)).toMatch(/^\[System\] You thought through the task but produced no reply/);
    expect(llmSettings.maxTokens).toBe(4096);
    expect(outcome.fullContent.trim()).toBe(REPLY);
  });
});
