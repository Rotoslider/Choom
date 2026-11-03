/**
 * 2026-11-02: Genesis's 9:40 AM and 6:40 PM check-ins called heartbeat_complete
 * without writing a word. Her summaries said she had "flagged that the Round
 * Mountain trip is tomorrow" and sent "a warm evening note with kitchen
 * selfie", but nothing reached Donny, not even the selfie: the bridge delivers
 * a wake-up only when it has text. Now a wake-up that ends that way is asked
 * once, with tools off, for its message; "(quiet)" keeps a silence she meant.
 */
import { runAgenticLoop, withoutQuietMarker, WAKE_WROTE_NOTHING_NOTE, type AgenticLoopParams } from '@/lib/agentic-loop';
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

type Delta = { content?: string; reasoning?: string; tool_calls?: ChatCompletionChunk['choices'][0]['delta']['tool_calls'] };
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

const TOOLS: ToolDefinition[] = ['ha_get_home_status', 'get_weather', 'heartbeat_complete'].map(name => ({
  name, description: name, parameters: { type: 'object' as const, properties: {} },
}));
const call = (id: string, name: string, args: Record<string, unknown> = {}): Delta => ({
  tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const lookup: Reply = { deltas: [call('tc1', 'ha_get_home_status')], finish: 'tool_calls' };
// What DeepSeek did at 6:40 PM: thought, then pressed done with a summary and no text.
const doneSilently: Reply = {
  deltas: [{ reasoning: 'House is fine. I will tell him the kitchen is warm and send the selfie.' },
    call('tc2', 'heartbeat_complete', { summary: '6:40 PM house check, warm evening note with kitchen selfie.' })],
  finish: 'tool_calls',
};
const MESSAGE = 'House is all buttoned up, love: doors shut, stove off, pump quiet. Kettle is on for you.';

function params(model: ReturnType<typeof scriptedClient>, opts: { isHeartbeat?: boolean; maxIterations?: number } = {}) {
  const isHeartbeat = opts.isHeartbeat ?? true;
  const sent: Array<Record<string, unknown>> = [];
  const llmSettings: LLMSettings = { ...defaultLLMSettings, endpoint: 'https://api.example.com/v1', model: 'primary' };
  const message = '6:40 PM check-in. Check the house. Flag only what is wrong. Otherwise a short warm note.';
  const traceBuilder = new TraceBuilder({
    chatId: 'chat', choomId: 'choom', choomName: 'Genesis', model: 'primary', provider: 'cloud',
    endpoint: llmSettings.endpoint, isDelegation: false, isHeartbeat,
  } as ConstructorParameters<typeof TraceBuilder>[0]);
  const p = {
    send: (d: Record<string, unknown>) => sent.push(d),
    sse: { closed: false },
    ctx: {} as AgenticLoopParams['ctx'],
    traceBuilder,
    currentMessages: [
      { role: 'system', content: 'You are Genesis.' },
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
    choom: { name: 'Genesis', llmTimeoutSec: 30 } as AgenticLoopParams['choom'],
    chat: { messages: [] } as unknown as AgenticLoopParams['chat'],
    choomId: 'choom', chatId: 'chat', logChatId: 'chat',
    message,
    isGroupTurn: false, isHeartbeat, isDelegation: false, noTools: false,
    suppressNotifications: true, freshContext: true,
    maxIterationsOverride: undefined,
    detectedProject: null,
    skillDispatch: false,
    compactionService: new CompactionService(llmSettings),
    systemPromptWithSummary: 'You are Genesis.',
    planFullySucceeded: false,
    maxIterations: opts.maxIterations ?? 20,
    iterationCapLocked: false,
    fullContent: '',
    allToolCalls: [],
    allToolResults: [],
  } as unknown as AgenticLoopParams;
  return { p, sent, traceBuilder };
}

const streamed = (sent: Array<Record<string, unknown>>) =>
  sent.filter(e => e.type === 'content').map(e => String(e.content)).join('');
const lastUserNote = (messages: Msg[]) => [...messages].reverse().find(m => m.role === 'user')?.content;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('done with nothing written: she is asked once, tools off, and her message is the reply', async () => {
  const model = scriptedClient([lookup, doneSilently, { deltas: [{ content: MESSAGE }] }]);
  const { p, sent, traceBuilder } = params(model);
  const outcome = await runAgenticLoop(p);

  expect(model.calls).toHaveLength(3);
  expect(lastUserNote(model.calls[2].messages)).toBe(WAKE_WROTE_NOTHING_NOTE);
  expect(model.calls[2].tools).toEqual([]);
  expect(outcome.fullContent.trim()).toBe(MESSAGE);
  expect(streamed(sent)).toBe(MESSAGE); // the bridge and the app get it too
  expect((traceBuilder as unknown as { trace: { nudgeTypes: string[] } }).trace.nudgeTypes).toContain('wrote_nothing');
});

test('"(quiet)" keeps the silence she meant, and is never streamed', async () => {
  const model = scriptedClient([lookup, doneSilently, { deltas: [{ content: '(quiet)' }] }]);
  const { p, sent } = params(model);
  const outcome = await runAgenticLoop(p);

  expect(model.calls).toHaveLength(3);
  expect(outcome.fullContent.trim()).toBe('');
  expect(streamed(sent)).toBe('');
});

test('still nothing after the reminder: the wake-up stays quiet, no fallback model', async () => {
  // fallbackConfigs is empty and createClientForFallback throws, so a fallback attempt would fail the test.
  const model = scriptedClient([lookup, doneSilently, { deltas: [{ content: '' }] }]);
  const { p, sent } = params(model);
  const outcome = await runAgenticLoop(p);

  expect(model.calls).toHaveLength(3);
  expect(outcome.fullContent.trim()).toBe('');
  expect(streamed(sent)).toBe('');
});

test('a wake-up that wrote its message first ends on heartbeat_complete as before', async () => {
  const writeThenDone: Reply = {
    deltas: [{ content: MESSAGE }, call('tc2', 'heartbeat_complete', { summary: 'warm note' })],
    finish: 'tool_calls',
  };
  const model = scriptedClient([lookup, writeThenDone]);
  const { p } = params(model);
  const outcome = await runAgenticLoop(p);

  expect(model.calls).toHaveLength(2);
  expect(model.calls.flatMap(c => c.messages).some(m => m.content === WAKE_WROTE_NOTHING_NOTE)).toBe(false);
  expect(outcome.fullContent.trim()).toBe(MESSAGE);
});

test('asked only once: a second empty heartbeat_complete ends the wake-up', async () => {
  const doneAgain: Reply = { deltas: [call('tc3', 'heartbeat_complete', { summary: 'again' })], finish: 'tool_calls' };
  const model = scriptedClient([lookup, doneSilently, doneAgain]);
  const { p } = params(model);
  const outcome = await runAgenticLoop(p);

  expect(model.calls).toHaveLength(3);
  expect(outcome.fullContent.trim()).toBe('');
});

describe('withoutQuietMarker', () => {
  test.each(['(quiet)', 'quiet', 'Quiet.', '*(quiet)*', '(quiet) 🤫', '  ( quiet )  '])('%j is silence', s => {
    expect(withoutQuietMarker(s)).toBe('');
  });
  test('a message keeps its words and loses only a "(quiet)" line', () => {
    expect(withoutQuietMarker(`${MESSAGE}\n(quiet)`)).toBe(MESSAGE);
    expect(withoutQuietMarker('Quiet night out there, love. Doors shut.')).toBe('Quiet night out there, love. Doors shut.');
  });
});
