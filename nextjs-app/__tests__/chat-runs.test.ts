/**
 * 2026-10-30: a reply to Donny that fell to the Mac's Qwen ran 27 rounds about an old project, talking
 * on the glass as Genesis beside her answers to his later messages, and nothing could stop it. A newer
 * message from him in the same chat now ends the older reply (lib/chat-runs.ts), and the loop stops
 * before running any more of its tools or trying a fallback for it.
 */
import { startChatRun, chatRunsUnderWay } from '@/lib/chat-runs';
import { runAgenticLoop, type AgenticLoopParams } from '@/lib/agentic-loop';
import { executeToolCall } from '@/lib/tool-execution';
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

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  (executeToolCall as jest.Mock).mockClear();
});
afterEach(() => jest.restoreAllMocks());

describe('the registry', () => {
  test("his newer message ends the older reply in the same chat, and only there", () => {
    const old = jest.fn(), otherChat = jest.fn();
    const a = startChatRun('genesis', 'chat1', old, true);
    const b = startChatRun('genesis', 'chat2', otherChat, true);
    expect(a.ended).toBe(0);

    const c = startChatRun('genesis', 'chat1', jest.fn(), true);
    expect(c.ended).toBe(1);
    expect(old).toHaveBeenCalledTimes(1);
    expect(otherChat).not.toHaveBeenCalled();
    expect(chatRunsUnderWay('genesis', 'chat1')).toBe(1);

    a.finish(); // the ended reply winding down doesn't unregister the new one
    expect(chatRunsUnderWay('genesis', 'chat1')).toBe(1);
    c.finish();
    b.finish();
    expect(chatRunsUnderWay('genesis', 'chat1')).toBe(0);
    expect(chatRunsUnderWay('genesis', 'chat2')).toBe(0);
  });

  test('a note from the house or a scheduled turn never ends his reply', () => {
    const his = jest.fn();
    const a = startChatRun('genesis', 'chat3', his, true);
    const note = startChatRun('genesis', 'chat3', jest.fn(), false);
    expect(note.ended).toBe(0);
    expect(his).not.toHaveBeenCalled();
    expect(chatRunsUnderWay('genesis', 'chat3')).toBe(2);

    const next = startChatRun('genesis', 'chat3', jest.fn(), true); // his next message ends both
    expect(next.ended).toBe(2);
    [a, note, next].forEach(r => r.finish());
    expect(chatRunsUnderWay('genesis', 'chat3')).toBe(0);
  });
});

describe('the loop, once its reply has been ended', () => {
  type Delta = { content?: string; tool_calls?: ChatCompletionChunk['choices'][0]['delta']['tool_calls'] };
  const chunk = (delta: Delta, finish_reason: string | null = null): ChatCompletionChunk => ({
    id: 'c', object: 'chat.completion.chunk', created: 0, model: 'scripted',
    choices: [{ index: 0, delta: delta as ChatCompletionChunk['choices'][0]['delta'], finish_reason }],
  } as ChatCompletionChunk);
  const TOOLS: ToolDefinition[] = ['workspace_list_files', 'search_memories'].map(name => ({
    name, description: name, parameters: { type: 'object' as const, properties: {} },
  }));

  function params(sse: AgenticLoopParams['sse'], streamChat: (...a: unknown[]) => AsyncGenerator<ChatCompletionChunk>,
    createClientForFallback: jest.Mock, fallbacks: unknown[]): AgenticLoopParams {
    const llmSettings: LLMSettings = { ...defaultLLMSettings, endpoint: 'https://openrouter.ai/api/v1', model: 'primary' };
    const message = 'How much static pressure does the NF-A20 have?';
    return {
      send: () => {}, sse,
      ctx: {} as AgenticLoopParams['ctx'],
      traceBuilder: new TraceBuilder({
        chatId: 'chat', choomId: 'choom', choomName: 'Genesis', model: 'primary', provider: 'cloud',
        endpoint: llmSettings.endpoint, isDelegation: false, isHeartbeat: false,
      } as ConstructorParameters<typeof TraceBuilder>[0]),
      currentMessages: [{ role: 'system', content: 'You are Genesis.' }, { role: 'user', content: message }],
      activeTools: TOOLS,
      llmClient: { streamChat },
      llmSettings, clientLLMSettings: {}, settings: {}, providers: [],
      usingCloudProvider: true, resolvedProvider: 'cloud',
      fallbackConfigs: fallbacks, createClientForFallback,
      taskOverrideActive: false, taskModelOverride: undefined,
      choom: { name: 'Genesis', llmTimeoutSec: 30 } as AgenticLoopParams['choom'],
      chat: { messages: [] } as unknown as AgenticLoopParams['chat'],
      choomId: 'choom', chatId: 'chat', logChatId: 'chat', message,
      isGroupTurn: false, isHeartbeat: false, isDelegation: false, noTools: false,
      suppressNotifications: true, freshContext: true,
      maxIterationsOverride: undefined, detectedProject: null, skillDispatch: false,
      compactionService: new CompactionService(llmSettings),
      systemPromptWithSummary: 'You are Genesis.', planFullySucceeded: false,
      maxIterations: 6, iterationCapLocked: false,
      fullContent: '', allToolCalls: [], allToolResults: [],
    } as unknown as AgenticLoopParams;
  }

  test('ended while the model was answering: the tools it asked for never run', async () => {
    const sse: AgenticLoopParams['sse'] = { closed: false };
    let calls = 0;
    async function* streamChat(...a: unknown[]) {
      calls++;
      (a[4] as (() => void) | undefined)?.();
      sse.superseded = true; // his next message arrives mid-answer
      sse.closed = true;
      yield chunk({ tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'workspace_list_files', arguments: '{"path":"choom_commons/rooms"}' } }] }, 'tool_calls');
    }
    const fallback = jest.fn();
    await runAgenticLoop(params(sse, streamChat, fallback, []));

    expect(calls).toBe(1);
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test('ended and then the call failed: no fallback is tried for it', async () => {
    const sse: AgenticLoopParams['sse'] = { closed: false };
    async function* streamChat(...a: unknown[]): AsyncGenerator<ChatCompletionChunk> {
      (a[4] as (() => void) | undefined)?.();
      sse.superseded = true;
      sse.closed = true;
      yield chunk({}, 'stop'); // nothing at all: an empty response
    }
    const fallback = jest.fn(async () => { throw new Error('no fallback should be built'); });
    await runAgenticLoop(params(sse, streamChat, fallback, [{ label: 'Mac LM Studio/qwen', model: 'qwen', endpoint: 'http://localhost:1234/v1', provider: 'lmstudio' }]));

    expect(fallback).not.toHaveBeenCalled();
    expect(executeToolCall).not.toHaveBeenCalled();
  });
});
