/**
 * Phase 3 of the context plan (2026-09-12): honest budgets.
 *  - history is loaded newest-first (the old query returned the OLDEST 200)
 *  - the estimator is calibrated against the provider's real token count
 *  - aggressive compaction anchors on the CURRENT request, not the oldest one
 *  - pass 3 never leaves a tool result without its parent tool_calls
 *  - the request message is never stubbed
 */
import { readFileSync } from 'fs';
import path from 'path';
import { CompactionService } from '@/lib/compaction-service';
import { defaultLLMSettings } from '@/lib/chat-defaults';
import type { LLMSettings, ToolDefinition } from '@/lib/types';
import type { ChatMessage } from '@/lib/llm-client';

const settings = (contextLength: number): LLMSettings => ({ ...defaultLLMSettings, contextLength, maxTokens: 1000 });
const big = (n: number) => 'x'.repeat(n);
const asst = (id: string, name: string): ChatMessage => ({
  role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const tool = (id: string, name: string, chars: number): ChatMessage => ({ role: 'tool', tool_call_id: id, name, content: big(chars) });

describe('history is loaded newest-first', () => {
  test('the chat query takes the newest 200 and the route restores oldest-first order', () => {
    const route = readFileSync(path.join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8');
    expect(route).toContain("include: { messages: { orderBy: { createdAt: 'desc' }, take: 200 } }");
    expect(route).toContain('if (chat?.messages) chat.messages.reverse();');
  });
});

describe('calibration', () => {
  test('the real count scales every budget decision, smoothed and clamped', () => {
    const svc = new CompactionService(settings(100_000));
    const before = svc.calculateBudget(big(4000), []).fixedOverhead;
    // The provider counted half of what chars/4 predicted (tools were over-charged).
    expect(svc.calibrate(10_000, 20_000)).toBeCloseTo(0.5);
    const after = svc.calculateBudget(big(4000), []).fixedOverhead;
    expect(after).toBeLessThan(before);
    // A second observation is averaged in, not adopted wholesale.
    expect(svc.calibrate(20_000, 20_000)).toBeCloseTo(0.75);
    // Nonsense reports are ignored; extremes are clamped.
    expect(svc.calibrate(0, 20_000)).toBeCloseTo(0.75);
    svc.setTokenScale(9); expect(svc.getTokenScale()).toBe(2.5);
  });

  test('estimatePromptTokens is the raw base — unscaled', () => {
    const svc = new CompactionService(settings(100_000));
    const msgs: ChatMessage[] = [{ role: 'system', content: big(400) }, { role: 'user', content: big(400) }];
    const raw = svc.estimatePromptTokens(msgs, []);
    svc.setTokenScale(2);
    expect(svc.estimatePromptTokens(msgs, [])).toBe(raw);
  });
});

describe('within-turn compaction, pass 3', () => {
  const tools: ToolDefinition[] = [];
  function longTranscript(): ChatMessage[] {
    const m: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    m.push({ role: 'user', content: 'old question ' + big(2000) });
    m.push(asst('a1', 'web_search')); m.push(tool('a1', 'web_search', 6000));
    m.push({ role: 'assistant', content: 'old answer ' + big(2000) });
    m.push({ role: 'user', content: 'THE REQUEST: find the rack photo' });          // index 5
    m.push(asst('b1', 'search_memories')); m.push(tool('b1', 'search_memories', 6000));
    m.push(asst('c1', 'workspace_list_files')); m.push(tool('c1', 'workspace_list_files', 6000));
    m.push(asst('d1', 'analyze_image')); m.push(tool('d1', 'analyze_image', 6000));
    m.push(asst('e1', 'analyze_image')); m.push(tool('e1', 'analyze_image', 6000));
    return m;
  }

  test('a stubbed assistant takes its tool rows with it, and the request survives', () => {
    // Budget small enough that passes 1-3 all run (the preserved tail alone is
    // ~3k tokens; available here is ~2.4k).
    const svc = new CompactionService(settings(4000));
    const out = svc.compactWithinTurn(longTranscript(), 'sys', tools, 2, new Set(), 5);
    const msgs = out.messages;
    // Every tool row still has a parent assistant with a matching tool_call id.
    const parentIds = new Set(msgs.flatMap(m => m.role === 'assistant' && m.tool_calls ? m.tool_calls.map(tc => tc.id) : []));
    for (const m of msgs) if (m.role === 'tool') expect(parentIds.has(m.tool_call_id!)).toBe(true);
    // The current request is intact.
    expect(msgs.some(m => m.role === 'user' && m.content === 'THE REQUEST: find the rack photo')).toBe(true);
    // Something was actually dropped.
    expect(out.truncatedCount).toBeGreaterThan(0);
    expect(msgs.length).toBeLessThan(longTranscript().length);
  });
});

describe('aggressive compaction anchors on the current request', () => {
  test('with history present, the newest user message before the tool calls is kept, not the oldest', () => {
    const svc = new CompactionService(settings(100_000));
    const m: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    m.push({ role: 'user', content: 'yesterday: what is the weather?' });
    m.push({ role: 'assistant', content: 'Sunny.' });
    m.push({ role: 'user', content: 'today: find the rack photo and tell me about it' }); // index 3
    for (let i = 0; i < 4; i++) { m.push(asst(`t${i}`, 'workspace_list_files')); m.push(tool(`t${i}`, 'workspace_list_files', 4000)); }
    // Tiny budget so the 70% gate opens.
    const out = svc.compactAggressiveWithinTurn(m, 4, 3, 1000, 3);
    expect(out.tokensRecovered).toBeGreaterThan(0);
    expect(out.messages[1].content).toBe('today: find the rack photo and tell me about it');
    expect(out.requestIndex).toBe(1);
    // Same answer without the index hint: the last user message before the first tool call.
    const out2 = svc.compactAggressiveWithinTurn(m, 4, 3, 1000);
    expect(out2.messages[1].content).toBe('today: find the rack photo and tell me about it');
  });
});
