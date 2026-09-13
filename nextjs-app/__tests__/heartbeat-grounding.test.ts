/**
 * 2026-09-12: wake-up grounding is pre-built server-side as a completed tool
 * exchange instead of six sequential model round trips.
 */
import { buildHeartbeatGrounding, taskGist, GROUNDING_SPECS } from '@/lib/heartbeat-grounding';
import type { ToolCall, ToolDefinition } from '@/lib/types';

const tool = (name: string): ToolDefinition => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const PROMPT = `[You are waking up — it is Saturday, September 12 2026 at 09:01 PM.]
[Donny is at home (Lazy Kay Ln, Animas).]
(Note: "Lazy Kay Ln, Animas" is Donny's home address.)
Your grounding has already been gathered for you: …

Saturday evening wind-down ~9 PM MDT — gentle goodnight to Donny, house check, and a soft note about tomorrow.`;

describe('taskGist', () => {
  test('drops the bracketed awareness lines and keeps the task', () => {
    const g = taskGist(PROMPT);
    expect(g.startsWith('Saturday evening wind-down')).toBe(true);
    expect(g).not.toContain('Your grounding has already');
    expect(g).not.toContain('You are waking up');
    expect(taskGist('x'.repeat(500)).length).toBe(300);
  });
});

describe('buildHeartbeatGrounding', () => {
  test('runs the available specs in parallel, skips missing tools, and emits one assistant call + one tool result each', async () => {
    const active = ['get_weather', 'search_memories', 'check_inbox', 'generate_image', 'list_self_followups'].map(tool);
    const seen: ToolCall[] = [];
    const out = await buildHeartbeatGrounding({
      prompt: PROMPT, activeTools: active,
      execute: async tc => { seen.push(tc); return { toolCallId: tc.id, name: tc.name, result: { ok: tc.name } }; },
    });
    expect(seen.map(c => c.name)).toEqual(['get_weather', 'check_inbox', 'search_memories']);
    expect(out.skipped).toEqual(['get_calendar_events', 'ha_get_home_status']);
    const mem = seen.find(c => c.name === 'search_memories')!;
    expect(mem.arguments.query).toContain('Saturday evening wind-down');
    expect(out.messages).toHaveLength(4);
    expect(out.messages[0].role).toBe('assistant');
    expect((out.messages[0] as { tool_calls: unknown[] }).tool_calls).toHaveLength(3);
    expect(out.messages.slice(1).every(m => m.role === 'tool')).toBe(true);
    expect((out.messages[1] as { tool_call_id: string }).tool_call_id).toBe(seen[0].id);
    expect(out.messages[1].content).toBe('{"ok":"get_weather"}');
    expect(out.toolCalls).toHaveLength(3);
    expect(out.toolResults).toHaveLength(3);
  });

  test('a slow or throwing tool becomes an error result, not a stalled wake-up', async () => {
    const active = ['get_weather', 'ha_get_home_status'].map(tool);
    const out = await buildHeartbeatGrounding({
      prompt: PROMPT, activeTools: active, timeoutMs: 30,
      execute: async tc => {
        if (tc.name === 'get_weather') throw new Error('weather API down');
        await new Promise(r => setTimeout(r, 200));
        return { toolCallId: tc.id, name: tc.name, result: { late: true } };
      },
    });
    expect(out.summary.find(s => s.name === 'get_weather')?.error).toBe('weather API down');
    expect(out.summary.find(s => s.name === 'ha_get_home_status')?.error).toMatch(/timed out/);
    expect(out.messages[1].content).toContain('"success":false');
    expect(out.messages).toHaveLength(3);
  });

  test('no available tools → nothing to append', async () => {
    const out = await buildHeartbeatGrounding({ prompt: PROMPT, activeTools: [tool('generate_image')], execute: async () => { throw new Error('never'); } });
    expect(out.messages).toEqual([]);
    expect(out.skipped).toHaveLength(GROUNDING_SPECS.length);
  });

  test('oversized results are capped', async () => {
    const out = await buildHeartbeatGrounding({
      prompt: PROMPT, activeTools: [tool('ha_get_home_status')],
      execute: async tc => ({ toolCallId: tc.id, name: tc.name, result: 'x'.repeat(20_000) }),
    });
    expect(out.messages[1].content.length).toBeLessThan(6_100);
    expect(out.messages[1].content).toContain('truncated');
  });
});
