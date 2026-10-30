/**
 * 2026-10-30: Aloy's 9:45 PM wind-down made 60 lookups across all 20 rounds
 * and never wrote a word, so the message that reached Donny was the cap's
 * progress list ("[Reached maximum tool iterations — 60 tool calls
 * completed] … Files read: …"). On a wake-up she now hears, three rounds from
 * the end, how many are left, and the last round has no tools, so it can
 * only be her message. Chats with Donny keep the progress list: he can say
 * "continue".
 */
import { runAgenticLoop, WAKE_LAST_ROUND_NOTE, WAKE_ROUNDS_LEFT_NOTE, type AgenticLoopParams } from '@/lib/agentic-loop';
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

type Delta = { content?: string; tool_calls?: ChatCompletionChunk['choices'][0]['delta']['tool_calls'] };
type Reply = { deltas: Delta[]; finish?: string };
type Msg = { role: string; content?: string };

const chunk = (delta: Delta, finish_reason: string | null = null): ChatCompletionChunk => ({
  id: 'c', object: 'chat.completion.chunk', created: 0, model: 'scripted',
  choices: [{ index: 0, delta: delta as ChatCompletionChunk['choices'][0]['delta'], finish_reason }],
} as ChatCompletionChunk);

function scriptedClient(replies: Reply[]) {
  const calls: Array<{ messages: Msg[]; tools: string[] }> = [];
  return {
    calls,
    client: {
      async *streamChat(messages: Msg[], tools: unknown, _signal: AbortSignal, _toolChoice: unknown, onConnected?: () => void) {
        calls.push({ messages: [...messages], tools: ((tools as ToolDefinition[] | undefined) ?? []).map(t => t.name) });
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

const TOOLS: ToolDefinition[] = ['search_memories', 'get_weather', 'get_calendar_events'].map(name => ({
  name, description: name, parameters: { type: 'object' as const, properties: {} },
}));
// A different tool and query every round, so no repeat or streak guard steps in.
const lookup = (i: number): Reply => ({
  deltas: [{ tool_calls: [{ index: 0, id: `tc${i}`, type: 'function', function: { name: TOOLS[i % 3].name, arguments: JSON.stringify({ query: `thing ${i}` }) } }] }],
  finish: 'tool_calls',
});
const MESSAGE = 'Quiet night: doors shut, cameras clear, and I left Eve a letter about the reed rules.';

function params(model: ReturnType<typeof scriptedClient>, isHeartbeat: boolean): AgenticLoopParams {
  const llmSettings: LLMSettings = { ...defaultLLMSettings, endpoint: 'https://api.example.com/v1', model: 'primary' };
  const message = 'Wind-down (9:45 PM): reflect on the day and check the house.';
  return {
    send: () => {},
    sse: { closed: false },
    ctx: {} as AgenticLoopParams['ctx'],
    traceBuilder: new TraceBuilder({
      chatId: 'chat', choomId: 'choom', choomName: 'Aloy', model: 'primary', provider: 'cloud',
      endpoint: llmSettings.endpoint, isDelegation: false, isHeartbeat,
    } as ConstructorParameters<typeof TraceBuilder>[0]),
    currentMessages: [
      { role: 'system', content: 'You are Aloy.' },
      { role: 'user', content: message },
    ],
    activeTools: TOOLS,
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
    choom: { name: 'Aloy', llmTimeoutSec: 30 } as AgenticLoopParams['choom'],
    chat: { messages: [] } as unknown as AgenticLoopParams['chat'],
    choomId: 'choom', chatId: 'chat', logChatId: 'chat',
    message,
    isGroupTurn: false, isHeartbeat, isDelegation: false, noTools: false,
    suppressNotifications: true, freshContext: true,
    maxIterationsOverride: undefined,
    detectedProject: null,
    skillDispatch: false,
    compactionService: new CompactionService(llmSettings),
    systemPromptWithSummary: 'You are Aloy.',
    planFullySucceeded: false,
    maxIterations: 6,
    iterationCapLocked: false,
    fullContent: '',
    allToolCalls: [],
    allToolResults: [],
  } as unknown as AgenticLoopParams;
}

const lastUserNote = (messages: Msg[]) => [...messages].reverse().find(m => m.role === 'user')?.content;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('a wake-up hears it has 3 rounds left, then writes its message with tools off', async () => {
  // She would keep looking things up forever; only the last round's tools-off call can end in words.
  const model = scriptedClient([lookup(1), lookup(2), lookup(3), lookup(4), lookup(5), { deltas: [{ content: MESSAGE }] }]);
  const outcome = await runAgenticLoop(params(model, true));

  expect(model.calls).toHaveLength(6);
  expect(lastUserNote(model.calls[3].messages)).toBe(WAKE_ROUNDS_LEFT_NOTE); // before round 4 of 6
  expect(model.calls[4].tools).toHaveLength(3);
  expect(model.calls[5].tools).toEqual([]);
  expect(lastUserNote(model.calls[5].messages)).toBe(WAKE_LAST_ROUND_NOTE);
  expect(outcome.fullContent.trim()).toBe(MESSAGE);
  expect(outcome.fullContent).not.toMatch(/Reached maximum tool iterations/);
  expect(outcome.iteration).toBe(6); // still counted as using every round
});

test('a chat with Donny keeps its tools to the end and the progress list for "continue"', async () => {
  const model = scriptedClient([lookup(1), lookup(2), lookup(3), lookup(4), lookup(5), lookup(6)]);
  const outcome = await runAgenticLoop(params(model, false));

  expect(model.calls.every(c => c.tools.length === 3)).toBe(true);
  expect(model.calls.flatMap(c => c.messages).some(m => m.content === WAKE_ROUNDS_LEFT_NOTE || m.content === WAKE_LAST_ROUND_NOTE)).toBe(false);
  expect(outcome.fullContent).toMatch(/Reached maximum tool iterations — 6 tool calls completed/);
});
