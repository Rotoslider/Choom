/**
 * 2026-11-26, Eve at 6:10 PM: she wrote her whole reply (streamed and spoken),
 * then a nudge made her call a tool ("not the clear ones" read as a memory
 * claim), and after the tool she wrote the reply again. The paragraph check
 * cut the copy from 2,145 to 1,056 chars; the reworded paragraphs went out and
 * Donny heard them twice. Now: no nudge for that line, a note after the tool
 * round that her reply already went out, the reworded sentences dropped, and
 * nothing more to say is the end of the turn.
 */
import { runAgenticLoop, DELIVERED_REPLY_NOTE, type AgenticLoopParams } from '@/lib/agentic-loop';
import { TraceBuilder } from '@/lib/execution-trace';
import { CompactionService } from '@/lib/compaction-service';
import { defaultLLMSettings } from '@/lib/chat-defaults';
import type { ChatCompletionChunk } from '@/lib/llm-client';
import type { ToolDefinition, ToolResult, LLMSettings } from '@/lib/types';

jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));
jest.mock('@/lib/tool-execution', () => ({
  executeToolCall: jest.fn(async (tc: { id: string; name: string }): Promise<ToolResult> => ({
    toolCallId: tc.id, name: tc.name, result: { success: true, message: 'Saved.' },
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
  const calls: Array<{ messages: Msg[] }> = [];
  return {
    calls,
    client: {
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

const TOOLS: ToolDefinition[] = ['remember', 'get_weather'].map(name => ({
  name, description: name, parameters: { type: 'object' as const, properties: {} },
}));
const remember: Delta = { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: 'remember', arguments: '{"title":"Tower climb","content":"Donny climbed the tower in 15 mph wind."}' } }] };

const REPLY = [
  "[warm] You climbed a tower you don't like being on, in fifteen mile an hour wind, and got it done.",
  "That's the kind of thing where the fear doesn't go away and you go up anyway, and I want that on the record.",
  '',
  'Use black UV-rated ties, not the clear ones. Southern New Mexico sun eats nylon, and clear ties go brittle in a season.',
  '',
  "And Genesis cooking dinner out of what was in the pantry, with times and temperatures, and it came out good — [warm] that's a good thing to find out about your family on a Thursday.",
  '',
  "[softly] Now go have your frozen yogurt. It's 56 and the wind's down to 3, and the day's done its work.",
].join('\n');
// What she wrote after the tool at 6:10 PM: the same paragraphs again, reworded, and one new line.
const AGAIN = [
  "And Genesis cooking dinner out of what was in the pantry, with her own times and temperatures, and it coming out good — [warm] that's a fine thing to learn about your family on a Thursday.",
  '',
  "It's saved, so I'll hold you to the calm day with someone there.",
  '',
  "[teasing] Now go have your frozen yogurt. It's 56 and the wind's down to 3, and the day's done its work.",
].join('\n');

function params(model: ReturnType<typeof scriptedClient>) {
  const sent: Array<Record<string, unknown>> = [];
  const llmSettings: LLMSettings = { ...defaultLLMSettings, endpoint: 'https://api.example.com/v1', model: 'primary' };
  const message = 'Today was fun. I climbed the tower in 15 mph wind and Genesis cooked dinner.';
  const traceBuilder = new TraceBuilder({
    chatId: 'chat', choomId: 'eve', choomName: 'Eve', model: 'primary', provider: 'cloud',
    endpoint: llmSettings.endpoint, isDelegation: false, isHeartbeat: false,
  } as ConstructorParameters<typeof TraceBuilder>[0]);
  const p = {
    send: (d: Record<string, unknown>) => sent.push(d),
    sse: { closed: false },
    ctx: {} as AgenticLoopParams['ctx'],
    traceBuilder,
    currentMessages: [{ role: 'system', content: 'You are Eve.' }, { role: 'user', content: message }],
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
    choom: { name: 'Eve', llmTimeoutSec: 30 } as AgenticLoopParams['choom'],
    chat: { messages: [] } as unknown as AgenticLoopParams['chat'],
    choomId: 'eve', chatId: 'chat', logChatId: 'chat',
    message,
    isGroupTurn: false, isHeartbeat: false, isDelegation: false, noTools: false,
    suppressNotifications: true, freshContext: true,
    maxIterationsOverride: undefined,
    detectedProject: null,
    skillDispatch: false,
    compactionService: new CompactionService(llmSettings),
    systemPromptWithSummary: 'You are Eve.',
    planFullySucceeded: false,
    maxIterations: 20,
    iterationCapLocked: false,
    fullContent: '',
    allToolCalls: [],
    allToolResults: [],
  } as unknown as AgenticLoopParams;
  return { p, sent };
}

const streamed = (sent: Array<Record<string, unknown>>) =>
  sent.filter(e => e.type === 'content').map(e => String(e.content)).join('');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('"not the clear ones" is a finished reply, not a memory claim: no forced tool call', async () => {
  const model = scriptedClient([{ deltas: [{ content: REPLY }] }]);
  const { p, sent } = params(model);
  const outcome = await runAgenticLoop(p);
  expect(model.calls).toHaveLength(1);
  expect(outcome.fullContent.trim()).toBe(REPLY);
  expect(streamed(sent)).toBe(REPLY);
});

test('written again after the tool: she is told it went out, and only the new line is sent', async () => {
  const model = scriptedClient([
    { deltas: [{ content: REPLY }, remember], finish: 'tool_calls' },
    { deltas: [{ content: AGAIN }] },
  ]);
  const { p, sent } = params(model);
  const outcome = await runAgenticLoop(p);

  expect(model.calls).toHaveLength(2);
  const notes = model.calls[1].messages.filter(m => m.role === 'user').map(m => m.content);
  expect(notes[notes.length - 1]).toBe(DELIVERED_REPLY_NOTE);
  const out = streamed(sent);
  expect(out.startsWith(REPLY)).toBe(true);
  expect(out.slice(REPLY.length).trim()).toBe("It's saved, so I'll hold you to the calm day with someone there.");
  expect(count(outcome.fullContent, 'family on a Thursday')).toBe(1);
  expect(count(outcome.fullContent, 'frozen yogurt')).toBe(1);
});

test('nothing to add after the tool ends the turn: no fallback, no nudge, no third copy', async () => {
  const model = scriptedClient([
    { deltas: [{ content: REPLY }, remember], finish: 'tool_calls' },
    { deltas: [{ content: '' }] },
  ]);
  const { p, sent } = params(model);
  const outcome = await runAgenticLoop(p);
  expect(model.calls).toHaveLength(2);
  expect(outcome.fullContent.trim()).toBe(REPLY);
  expect(streamed(sent)).toBe(REPLY);
});

test('a short "let me check" before the tool gets no note: the real reply comes after', async () => {
  const model = scriptedClient([
    { deltas: [{ content: 'Let me check the wind for Saturday.' }, { tool_calls: [{ index: 0, id: 'tc2', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }], finish: 'tool_calls' },
    { deltas: [{ content: 'Saturday is calm until two, then the front comes through.' }] },
  ]);
  const { p } = params(model);
  await runAgenticLoop(p);
  expect(model.calls[1].messages.some(m => m.content === DELIVERED_REPLY_NOTE)).toBe(false);
});
