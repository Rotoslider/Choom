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
type Reply = { deltas: Delta[]; finish?: string; usage?: { prompt_tokens: number; completion_tokens: number } };

const chunk = (delta: Delta, finish_reason: string | null = null): ChatCompletionChunk => ({
  id: 'c', object: 'chat.completion.chunk', created: 0, model: 'scripted',
  choices: [{ index: 0, delta: delta as ChatCompletionChunk['choices'][0]['delta'], finish_reason }],
} as ChatCompletionChunk);

function scriptedClient(replies: Reply[]) {
  const calls: Array<{ messages: unknown[]; toolChoice: unknown; tools: string[] }> = [];
  return {
    calls,
    client: {
      async *streamChat(messages: unknown[], tools: unknown, _signal: AbortSignal, toolChoice: unknown, onConnected?: () => void) {
        calls.push({ messages: [...messages], toolChoice, tools: (tools as ToolDefinition[]).map(t => t.name) });
        onConnected?.();
        const reply = replies.shift();
        if (!reply) throw new Error(`scripted client: no reply left for call #${calls.length}`);
        for (let i = 0; i < reply.deltas.length; i++) {
          const last = i === reply.deltas.length - 1;
          yield chunk(reply.deltas[i], last ? (reply.finish ?? 'stop') : null);
        }
        if (reply.deltas.length === 0) yield chunk({}, reply.finish ?? 'stop');
        if (reply.usage) yield { id: 'u', object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [], usage: reply.usage } as unknown as ChatCompletionChunk;
      },
    },
  };
}

const text = (s: string): Reply => ({ deltas: [{ content: s }] });
const empty: Reply = { deltas: [] };
const reasoningOnly = (s: string): Reply => ({ deltas: [{ reasoning_content: s }] });
const toolCall = (name: string, id: string, preamble = '', args: Record<string, unknown> = {}): Reply => ({
  deltas: [
    ...(preamble ? [{ content: preamble }] : []),
    { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
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
  opts: { message?: string; settings?: Partial<LLMSettings>; toolExposure?: 'full' | 'skills' } = {},
): AgenticLoopParams {
  const llmSettings: LLMSettings = { ...defaultLLMSettings, endpoint: 'https://api.example.com/v1', model: 'primary', ...opts.settings };
  const message = opts.message ?? 'Scheduled follow-up: say good morning.';
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
      { role: 'user', content: message },
    ],
    activeTools: TOOLS,
    toolExposure: opts.toolExposure,
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
    message,
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

/**
 * 2026-09-12, Gemma 4 31B on a scheduler grounding prompt: the intent detector
 * saw "workspace_list_files" in the prompt, narrowed the forced first call to
 * that single tool and injected "do NOT use other tools", while the prompt asked
 * her to ground with six. She deliberated over the contradiction for two
 * minutes on reasoning_content, never acted, and the Qwen-3.6 reasoning salvage
 * then made "The user wants me to… I need to: 1. search_memories…" her reply.
 */
describe('reasoning channel and forcing on a multi-tool grounding prompt', () => {
  const GROUND = 'Before your task, ground yourself. Call search_memories to recall recent conversations. You also have get_weather and get_calendar_events if relevant. Then say good morning.';
  const GEMMA_THINKING = 'The user wants me to wake up and ground myself before saying good morning.\nI need to:\n1. `search_memories` to recall recent conversations.\n2. `get_weather` for current conditions.\nWait, the [Tool guidance] block says to call workspace_list_files only. However, the main prompt asks for multiple tools…';

  test('a prompt that names several tools is forced broadly, never narrowed to one with guidance', async () => {
    const primary = scriptedClient([
      toolCall('search_memories', 'tc1'),
      text('Good morning! All grounded.'),
    ]);
    await runAgenticLoop(buildParams(primary, { client: scriptedClient([]) }, [], { message: GROUND }));
    expect(primary.calls[0].toolChoice).toBe('required');
    expect(primary.calls[0].tools).toEqual(['search_memories', 'get_weather', 'get_calendar_events']);
    const guidance = primary.calls[0].messages.some(m => String((m as { content?: string }).content).startsWith('[Tool guidance]'));
    expect(guidance).toBe(false);
  });

  test('broad intent with no mapped tool is not forced at all', async () => {
    const primary = scriptedClient([text('I can draft that email for you — what should it say?')]);
    await runAgenticLoop(buildParams(primary, { client: scriptedClient([]) }, [], { message: 'draft an email to the neighbor about the fence' }));
    expect(primary.calls[0].toolChoice).toBeUndefined();
  });

  test('Gemma-style deliberation on reasoning_content is nudged to act, not used as the reply', async () => {
    const primary = scriptedClient([
      reasoningOnly(GEMMA_THINKING),
      toolCall('search_memories', 'tc1'),
      text('Good morning, Donny. Grounded and ready.'),
    ]);
    const outcome = await runAgenticLoop(buildParams(primary, { client: scriptedClient([]) }, [],
      { message: GROUND, settings: { enableThinking: false } }));
    expect(primary.calls).toHaveLength(3);
    const nudge = primary.calls[1].messages.at(-1) as { role: string; content: string };
    expect(nudge.role).toBe('user');
    expect(nudge.content).toMatch(/^\[System\] You thought through the task/);
    expect(outcome.fullContent).not.toContain('The user wants me to');
    expect(outcome.fullContent).toContain('Grounded and ready');
    expect(outcome.allToolCalls.map(t => t.name)).toEqual(['search_memories']);
  });

  test('deliberation cut off by max_tokens raises the limit before nudging', async () => {
    const primary = scriptedClient([
      { deltas: [{ reasoning_content: GEMMA_THINKING }], finish: 'length' },
      text('Good morning.'),
    ]);
    const params = buildParams(primary, { client: scriptedClient([]) }, [], { message: GROUND, settings: { enableThinking: false, maxTokens: 4096 } });
    await runAgenticLoop(params);
    expect(params.llmSettings.maxTokens).toBe(8192);
    const nudge = primary.calls[1].messages.at(-1) as { content: string };
    expect(nudge.content).toMatch(/ran past the output limit/);
  });

  test('a model flagged replyInReasoning (Qwen 3.6) still gets its reasoning-channel reply salvaged', async () => {
    const primary = scriptedClient([reasoningOnly('Good morning, Donny! Everything is quiet up here.')]);
    const outcome = await runAgenticLoop(buildParams(primary, { client: scriptedClient([]) }, [],
      { message: 'say good morning', settings: { enableThinking: false, replyInReasoning: true } }));
    expect(primary.calls).toHaveLength(1);
    expect(outcome.fullContent).toContain('Everything is quiet up here');
  });

  test('a conversational reasoning-channel reply from an unflagged model is still salvaged', async () => {
    const primary = scriptedClient([reasoningOnly('Good morning, Donny! Coffee is on and the sun is up.')]);
    const outcome = await runAgenticLoop(buildParams(primary, { client: scriptedClient([]) }, [],
      { message: 'say good morning', settings: { enableThinking: false } }));
    expect(outcome.fullContent).toContain('Coffee is on');
  });
});

/**
 * Skills mode (Phase 2): the loop owns the tools array, so it is the loop that
 * adds a skill's definitions after open_skill succeeds, and that opens a skill
 * when the model narrates a tool it cannot see.
 */
describe('skills-mode tool exposure in the loop', () => {
  const { getAllToolsFromSkills } = jest.requireActual('@/lib/tool-definitions') as typeof import('@/lib/tool-definitions');
  const exec = jest.requireMock('@/lib/tool-execution') as { executeToolCall: jest.Mock };

  beforeAll(() => { getAllToolsFromSkills(); }); // load the real registry

  test('a successful open_skill adds that skill\'s tools for the next call', async () => {
    exec.executeToolCall.mockImplementationOnce(async (tc: { id: string; name: string }) => ({
      toolCallId: tc.id, name: tc.name, result: { success: true, skill: 'music-assistant', tools_loaded: ['music_play'] },
    }));
    const primary = scriptedClient([
      toolCall('open_skill', 'tc1', '', { skill: 'music-assistant' }),
      toolCall('music_play', 'tc2', '', { query: 'some jazz' }),
      text('Playing it now.'),
    ]);
    const params = buildParams(primary, { client: scriptedClient([]) }, [], { message: 'put some music on', toolExposure: 'skills' });
    params.activeTools = [{ name: 'open_skill', description: 'open', parameters: { type: 'object', properties: {} } }];
    const outcome = await runAgenticLoop(params);
    expect(primary.calls[0].tools).toEqual(['open_skill']);
    expect(primary.calls[1].tools).toContain('music_play');
    expect(outcome.allToolCalls.map(t => t.name)).toEqual(['open_skill', 'music_play']);
  });

  test('narrating an unloaded tool opens its skill and asks for the call, instead of scolding', async () => {
    const primary = scriptedClient([
      text('Let me check music_now_playing for you.'),
      toolCall('music_now_playing', 'tc1', '', { player: 'shop' }),
      text('Nothing is playing right now.'),
    ]);
    const params = buildParams(primary, { client: scriptedClient([]) }, [], { message: 'what is playing?', toolExposure: 'skills' });
    params.activeTools = [{ name: 'search_memories', description: 'm', parameters: { type: 'object', properties: {} } }];
    const outcome = await runAgenticLoop(params);
    expect(primary.calls[1].tools).toContain('music_now_playing');
    const note = primary.calls[1].messages.at(-1) as { content: string };
    expect(note.content).toMatch(/now loaded: music-assistant/);
    expect(outcome.fullContent).toContain('Nothing is playing');
  });
});

/**
 * Found while testing skills mode (2026-09-12): when a turn's ONLY tool call
 * was dropped for empty arguments, the synthetic error was recorded but the
 * loop then saw "no tool calls" and ended the turn — the model never got to
 * retry, and the user got nothing.
 */
describe('a tool call dropped for empty arguments is retried', () => {
  test('the model is told what was missing and gets another iteration', async () => {
    const primary = scriptedClient([
      toolCall('music_play', 'tc1'), // {} — music_play requires a query
      toolCall('music_play', 'tc2', '', { query: 'some jazz' }),
      text('Playing it now.'),
    ]);
    const params = buildParams(primary, { client: scriptedClient([]) }, [], { message: 'play something' });
    params.activeTools = [{ name: 'music_play', description: 'play', parameters: { type: 'object', properties: { query: { type: 'string', description: 'q' } }, required: ['query'] } }];
    const outcome = await runAgenticLoop(params);
    expect(primary.calls).toHaveLength(3);
    const note = primary.calls[1].messages.at(-1) as { content: string };
    expect(note.content).toMatch(/without any arguments|requires: query/);
    expect(outcome.allToolCalls.map(t => t.name)).toEqual(['music_play']);
    expect(outcome.fullContent).toContain('Playing it now');
  });
});

describe('token estimate calibration (Phase 3)', () => {
  test('the real prompt count from the provider rescales the compaction budget', async () => {
    const primary = scriptedClient([
      { deltas: [{ content: 'Hello!' }], usage: { prompt_tokens: 4000, completion_tokens: 5 } },
    ]);
    const params = buildParams(primary, { client: scriptedClient([]) }, [], { message: 'x'.repeat(40_000) });
    const before = params.compactionService.getTokenScale();
    await runAgenticLoop(params);
    const after = params.compactionService.getTokenScale();
    expect(before).toBe(1);
    // chars/4 said ~10k for a 40k-char message; the provider counted 4k.
    expect(after).toBeLessThan(0.6);
    expect(after).toBeGreaterThan(0.3);
  });
});

/**
 * 2026-09-12: a 4B model called search_memories 100 iterations running with a
 * paraphrased query each time (107 calls, 2.4M prompt tokens). The dedup
 * loop-breaker keys on identical arguments, so it never fired.
 */
describe('same-tool streak guard', () => {
  test('six iterations of one tool draws a nudge; ten disables it and the turn finishes', async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < 14; i++) replies.push(toolCall('search_memories', `tc${i}`, '', { query: `rack build variant ${i}` }));
    replies.push(text('Here is what I found about the rack.'));
    const primary = scriptedClient(replies);
    const params = buildParams(primary, { client: scriptedClient([]) }, [], { message: 'tell me about the rack build' });
    params.maxIterations = 30;
    const outcome = await runAgenticLoop(params);
    // Nudge after the 6th call (visible to the 7th), block after the 10th.
    const msgsBefore7th = primary.calls[6].messages.map(m => String((m as { content?: string }).content));
    expect(msgsBefore7th.some(c => c.includes('6 times in a row'))).toBe(true);
    const msgsBefore11th = primary.calls[10].messages.map(m => String((m as { content?: string }).content));
    expect(msgsBefore11th.some(c => c.includes('unavailable for the rest of this turn'))).toBe(true);
    // The 11th call is refused (tool blocked — the attempt is recorded with an
    // error result) and the loop still reaches a reply.
    const blocked = params.allToolResults.filter(r => r.name === 'search_memories' && r.error);
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    // She kept calling the disabled tool; after 13 in a row every tool is gone
    // and the next call is text-only.
    expect(primary.calls[13].tools).toEqual([]);
    const strip = primary.calls[13].messages.map(m => String((m as { content?: string }).content));
    expect(strip.some(c => c.includes('Tools are off for the rest of this turn'))).toBe(true);
    expect(outcome.fullContent).toContain('Here is what I found');
  });
});

describe('pre-fallback nudge strip (Phase 4)', () => {
  test('behaviour nudges are stripped for the fallback; loop-state notices are kept', async () => {
    // Primary narrates (draws a nudge), then dies; the retry must not inherit
    // "[System] You described…" but must still see a state notice.
    const primary = scriptedClient([
      text('Let me check the weather for you.'),
      empty,
    ]);
    const retry = scriptedClient([text('It is 84 and sunny.')]);
    const params = buildParams(primary, { client: retry }, [], { message: 'what is the weather like?' });
    // A state notice the loop would have pushed earlier in the turn.
    params.currentMessages.push({ role: 'user', content: '[System] Tools are off for the rest of this turn. Reply to the user now, in your own voice, using what you already found.' });
    await runAgenticLoop(params);
    const retryMsgs = retry.calls[0].messages.map(m => String((m as { content?: string }).content));
    expect(retryMsgs.some(c => c.startsWith('[System] You '))).toBe(false);
    expect(retryMsgs.some(c => c.startsWith('[Tool guidance]'))).toBe(false);
    expect(retryMsgs.some(c => c.startsWith('[System] Tools are off'))).toBe(true);
  });
});

/**
 * 2026-09-12: after tool calls, a would-be final reply that repeated an earlier
 * line of the turn was dropped by the buffered dedup and the turn ended on the
 * stale narration ("Let me try that room again…"). Now she is asked once for a
 * real reply.
 */
describe('a final reply dropped as a repeat is retried', () => {
  test('the user gets a real reply, not the earlier narration', async () => {
    const primary = scriptedClient([
      toolCall('search_memories', 'tc1', 'Let me check the room first.', { query: 'room' }),
      text('Let me check the room first.'),          // repeat of the preamble → dropped
      text('Aloy is already in the room; I left her the plan.'),
    ]);
    const params = buildParams(primary, { client: scriptedClient([]) }, [], { message: 'start a room with Aloy' });
    const outcome = await runAgenticLoop(params);
    expect(primary.calls).toHaveLength(3);
    const nudge = primary.calls[2].messages.at(-1) as { content: string };
    expect(nudge.content).toMatch(/repeated an earlier line of this turn and was dropped/);
    expect(outcome.fullContent).toContain('I left her the plan');
  });
});
