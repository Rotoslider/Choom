/**
 * Regression: a scheduled follow-up died on iteration 2 (2026-09-12).
 *
 * Trace: iteration 1 called six tools, iteration 2 came back empty, the
 * same-model retry "succeeded" — and the turn ended with only the
 * iteration-1 preamble as output. Two defects in lib/agentic-loop.ts:
 *
 *  1. The post-fallback guard `!(fallbackActivated && nudgeCount === 0)` was
 *     added when the block it guarded was "accept text as final and break".
 *     The continuation nudges later moved INSIDE that block, so after any
 *     fallback the nudges were skipped and a retry that narrated its next
 *     step ("Now let me check...") ended the turn.
 *  2. The fallback stream reader kept only delta.content. A reasoning model
 *     whose reply came back on reasoning_content — or streamed nothing at
 *     all — was recorded as a successful fallback with an empty reply.
 *
 * These tests drive runAgenticLoop with a scripted LLM client and replay
 * that trace.
 */
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

// ---------------------------------------------------------------------------
// Scripted LLM client: each streamChat call consumes the next scripted reply.
// ---------------------------------------------------------------------------
type Delta = { content?: string; reasoning_content?: string; tool_calls?: ChatCompletionChunk['choices'][0]['delta']['tool_calls'] };
type Reply = { deltas: Delta[]; finish?: string };

const chunk = (delta: Delta, finish_reason: string | null = null): ChatCompletionChunk => ({
  id: 'c', object: 'chat.completion.chunk', created: 0, model: 'scripted',
  choices: [{ index: 0, delta: delta as ChatCompletionChunk['choices'][0]['delta'], finish_reason }],
} as ChatCompletionChunk);

function scriptedClient(replies: Reply[]) {
  const calls: Array<{ messages: unknown[]; toolChoice: unknown }> = [];
  return {
    calls,
    client: {
      async *streamChat(messages: unknown[], _tools: unknown, _signal: AbortSignal, toolChoice: unknown, onConnected?: () => void) {
        calls.push({ messages: [...messages], toolChoice });
        onConnected?.();
        const reply = replies.shift();
        if (!reply) throw new Error(`scripted client: no reply left for call #${calls.length}`);
        for (let i = 0; i < reply.deltas.length; i++) {
          const last = i === reply.deltas.length - 1;
          yield chunk(reply.deltas[i], last ? (reply.finish ?? 'stop') : null);
        }
        if (reply.deltas.length === 0) yield chunk({}, reply.finish ?? 'stop');
      },
    },
  };
}

const text = (s: string): Reply => ({ deltas: [{ content: s }] });
const empty: Reply = { deltas: [] };
const reasoningOnly = (s: string): Reply => ({ deltas: [{ reasoning_content: s }] });
const toolCall = (name: string, id: string, preamble = ''): Reply => ({
  deltas: [
    ...(preamble ? [{ content: preamble }] : []),
    { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '{}' } }] },
  ],
  finish: 'tool_calls',
});

const TOOLS: ToolDefinition[] = ['search_memories', 'get_weather', 'get_calendar_events'].map(name => ({
  name, description: name, parameters: { type: 'object' as const, properties: {} },
}));

/**
 * `retry` answers the same-model retry the loop prepends to the chain on its
 * own for a cloud primary (fallback #0). `fallbacks` are the configured
 * escalation models after it.
 */
function buildParams(
  primary: ReturnType<typeof scriptedClient>,
  retry: { client: ReturnType<typeof scriptedClient>; settings?: Partial<LLMSettings> },
  fallbacks: Array<{ label: string; client: ReturnType<typeof scriptedClient>; settings?: Partial<LLMSettings> }> = [],
): AgenticLoopParams {
  const llmSettings: LLMSettings = { ...defaultLLMSettings, endpoint: 'https://api.example.com/v1', model: 'primary' };
  const sent: Record<string, unknown>[] = [];
  const params = {
    send: (d: Record<string, unknown>) => { sent.push(d); },
    sse: { closed: false },
    ctx: {} as AgenticLoopParams['ctx'],
    traceBuilder: new TraceBuilder({
      chatId: 'chat', choomId: 'choom', choomName: 'Genesis', model: 'primary', provider: 'cloud',
      endpoint: llmSettings.endpoint, isDelegation: false, isHeartbeat: false,
    } as ConstructorParameters<typeof TraceBuilder>[0]),
    currentMessages: [
      { role: 'system', content: 'You are Genesis.' },
      { role: 'user', content: 'Scheduled follow-up: say good morning.' },
    ],
    activeTools: TOOLS,
    llmClient: primary.client,
    llmSettings,
    clientLLMSettings: {},
    settings: {},
    providers: [],
    usingCloudProvider: true,
    resolvedProvider: 'cloud',
    fallbackConfigs: fallbacks.map(fb => ({ model: fb.label, providerId: 'cloud', label: fb.label })),
    createClientForFallback: async (fb: { label: string; sameModelRetry?: boolean }) => {
      const match = fb.sameModelRetry ? retry : fallbacks.find(f => f.label === fb.label);
      if (!match) throw new Error(`test: no scripted client for fallback "${fb.label}"`);
      return { client: match.client.client, settings: { ...llmSettings, model: fb.label, ...match.settings } };
    },
    taskOverrideActive: false,
    taskModelOverride: undefined,
    choom: { name: 'Genesis', llmTimeoutSec: 30 } as AgenticLoopParams['choom'],
    chat: { messages: [] } as unknown as AgenticLoopParams['chat'],
    choomId: 'choom', chatId: 'chat', logChatId: 'chat',
    message: 'Scheduled follow-up: say good morning.',
    isGroupTurn: false, isHeartbeat: false, isDelegation: false, noTools: false,
    suppressNotifications: true, freshContext: false,
    maxIterationsOverride: undefined,
    detectedProject: null,
    skillDispatch: false,
    compactionService: new CompactionService(llmSettings),
    systemPromptWithSummary: 'You are Genesis.',
    planFullySucceeded: false,
    maxIterations: 10,
    iterationCapLocked: false,
    fullContent: '',
    allToolCalls: [],
    allToolResults: [],
  } as unknown as AgenticLoopParams;
  (params as unknown as { sent: Record<string, unknown>[] }).sent = sent;
  return params;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('agentic loop after a fallback', () => {
  test('a same-model retry that narrates its next step is nudged, not accepted as final', async () => {
    // Iteration 1: preamble + tool. Iteration 2: empty (primary).
    const primary = scriptedClient([
      toolCall('search_memories', 'tc1', 'Good morning, Donny! Let me ground myself first.'),
      empty,
    ]);
    // The retry narrates instead of acting. The phrasing is deliberately one
    // that ONLY the post-tool continuation checks (planningNext: "next step")
    // recognise — the separate no-tools-yet narration nudge keys on
    // "let me" / "checking" / "I'll" and would mask the guard bug.
    // After the nudge it does the work and finishes.
    const retry = scriptedClient([
      text('Next step is the calendar, then a proper good morning.'),
      toolCall('get_calendar_events', 'tc2'),
      text('Good morning! Nothing on the calendar today.'),
    ]);

    const outcome = await runAgenticLoop(buildParams(primary, { client: retry }));

    expect(primary.calls).toHaveLength(2);
    // Before the fix the loop ended right after the narration: 1 retry call, iteration 2.
    expect(retry.calls).toHaveLength(3);
    expect(outcome.iteration).toBeGreaterThan(2);
    expect(outcome.allToolCalls.map(t => t.name)).toEqual(['search_memories', 'get_calendar_events']);
    expect(outcome.fullContent).toContain('Nothing on the calendar today');
    // The narration was answered with a continuation nudge on the transcript.
    const nudged = retry.calls[1].messages.some(m => typeof (m as { content?: string }).content === 'string'
      && /^\[System\]/.test((m as { content: string }).content));
    expect(nudged).toBe(true);
  });

  test('a fallback whose reply arrives on reasoning_content is salvaged as the reply', async () => {
    const primary = scriptedClient([toolCall('search_memories', 'tc1'), empty]);
    const retry = scriptedClient([reasoningOnly('Good morning, Donny! Memories checked, all quiet.')]);

    const outcome = await runAgenticLoop(buildParams(primary, { client: retry, settings: { enableThinking: false } }));

    expect(retry.calls).toHaveLength(1);
    expect(outcome.fullContent).toContain('Memories checked, all quiet');
  });

  test('a Gemma 4 tool call leaked as text on a fallback is parsed and run, not shown', async () => {
    // Before the readers were merged the fallback reader had no Gemma filter
    // and the post-stream Gemma parser read the PRIMARY reader's filter — so
    // a Gemma fallback showed the raw block to the user and missed the call.
    const primary = scriptedClient([toolCall('search_memories', 'tc1'), empty]);
    const gemma = scriptedClient([
      text('Checking the calendar. <|tool_call>call:get_calendar_events{days:1}<tool_call|>'),
      text('Good morning! Calendar is clear.'),
    ]);

    const outcome = await runAgenticLoop(buildParams(primary, { client: gemma }));

    expect(outcome.allToolCalls.map(t => t.name)).toEqual(['search_memories', 'get_calendar_events']);
    expect(outcome.fullContent).not.toContain('<|tool_call>');
    expect(outcome.fullContent).toContain('Calendar is clear');
  });

  test('a fallback that streams nothing is a failed fallback — the chain moves on', async () => {
    const primary = scriptedClient([toolCall('search_memories', 'tc1'), empty]);
    const retry = scriptedClient([empty]);
    const escalation = scriptedClient([text('Good morning from the escalation model.')]);

    const outcome = await runAgenticLoop(buildParams(primary, { client: retry }, [
      { label: 'escalation', client: escalation },
    ]));

    expect(retry.calls).toHaveLength(1);
    // Before the fix the empty retry counted as success and the escalation model was never called.
    expect(escalation.calls).toHaveLength(1);
    expect(outcome.fullContent).toContain('Good morning from the escalation model');
  });
});
