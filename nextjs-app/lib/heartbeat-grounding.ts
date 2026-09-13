/**
 * Pre-built grounding for wake-ups (the last item of the 2026-09-12 context
 * plan). Every self follow-up and cron heartbeat opened the same way — six or
 * seven sequential tool calls (weather, calendar, house, pending wake-ups,
 * inbox, memories, workspace) before the task, each a full LLM round trip
 * that re-sent the whole context: 8 of 16 calls and ~100k of 260k prompt
 * tokens on one real evening wake, minutes on a local model.
 *
 * Now the server runs those calls itself, in parallel, before the first model
 * call, and hands them to her as a completed tool exchange (assistant
 * tool_calls + tool results) so the transcript looks exactly as if she had
 * asked. The models already know not to repeat a call whose result is in
 * front of them; the scheduler's preamble says so too.
 */
import type { ToolCall, ToolResult, ToolDefinition } from '@/lib/types';
import type { ChatMessage } from '@/lib/llm-client';

export interface GroundingSpec {
  name: string;
  args: (taskGist: string) => Record<string, unknown>;
}

/**
 * Deliberately NOT here: list_self_followups (4.7k chars, and seeing her whole
 * ladder on every wake is what started the schedule churn — a grounded
 * DeepSeek wake tried to cancel a real pending entry it took for a duplicate)
 * and workspace_list_files (she reads a specific file when the task needs it).
 */
export const GROUNDING_SPECS: GroundingSpec[] = [
  { name: 'get_weather', args: () => ({}) },
  { name: 'get_calendar_events', args: () => ({ days_ahead: 3 }) },
  { name: 'ha_get_home_status', args: () => ({}) },
  { name: 'check_inbox', args: () => ({}) },
  { name: 'search_memories', args: gist => ({ query: gist, limit: 5 }) },
];

export const GROUNDING_TOOL_TIMEOUT_MS = 25_000;
const RESULT_CAP_CHARS = 6_000;

/**
 * The task itself, without the bridge's bracketed awareness lines, for the
 * memory query. "[You are waking up — it is …]" would only match memories
 * about waking up.
 */
export function taskGist(prompt: string, max = 300): string {
  // The bridge builds `awareness + "\n\n" + task`, so the task is the last
  // paragraph. (Filtering only bracketed lines let the awareness sentence
  // "Your grounding has already been gathered…" become the memory query.)
  const paras = prompt.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const task = paras.length ? paras[paras.length - 1] : prompt;
  const lines = task.split('\n').map(l => l.trim()).filter(l => l && !(l.startsWith('[') && l.endsWith(']')) && !l.startsWith('(Note:'));
  const text = (lines.length ? lines : [task]).join(' ').replace(/\s+/g, ' ');
  return text.slice(0, max);
}

export interface GroundingOutcome {
  /** Messages to append after the wake-up prompt: one assistant call + one tool result each. */
  messages: ChatMessage[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  /** What ran, for the log and the trace. */
  summary: Array<{ name: string; ms: number; chars: number; error?: string }>;
  skipped: string[];
}

function resultToContent(r: ToolResult): string {
  let content: string;
  if (r.error) {
    content = JSON.stringify({ success: false, error: r.error, ...(r.result && typeof r.result === 'object' ? r.result as Record<string, unknown> : {}) });
  } else {
    content = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
  }
  if (content.length > RESULT_CAP_CHARS) content = content.slice(0, RESULT_CAP_CHARS) + `…[truncated ${content.length - RESULT_CAP_CHARS} chars]`;
  return content;
}

/**
 * Run the grounding set. Tools missing from `activeTools` are skipped; a slow
 * or throwing tool becomes an error result rather than a stalled wake-up.
 */
export async function buildHeartbeatGrounding(opts: {
  prompt: string;
  activeTools: ToolDefinition[];
  execute: (tc: ToolCall) => Promise<ToolResult>;
  specs?: GroundingSpec[];
  timeoutMs?: number;
  now?: () => number;
}): Promise<GroundingOutcome> {
  const specs = opts.specs ?? GROUNDING_SPECS;
  const timeoutMs = opts.timeoutMs ?? GROUNDING_TOOL_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const available = new Set(opts.activeTools.map(t => t.name));
  const gist = taskGist(opts.prompt);
  const skipped: string[] = [];
  const calls: ToolCall[] = [];
  for (const spec of specs) {
    if (!available.has(spec.name)) { skipped.push(spec.name); continue; }
    calls.push({ id: `ground_${spec.name}_${Math.random().toString(36).slice(2, 8)}`, name: spec.name, arguments: spec.args(gist) });
  }
  const summary: GroundingOutcome['summary'] = [];
  const results = await Promise.all(calls.map(async (tc): Promise<ToolResult> => {
    const t0 = now();
    let r: ToolResult;
    try {
      r = await Promise.race<ToolResult>([
        opts.execute(tc),
        new Promise<ToolResult>(resolve => setTimeout(() => resolve({ toolCallId: tc.id, name: tc.name, result: null, error: `grounding call timed out after ${Math.round(timeoutMs / 1000)}s` }), timeoutMs)),
      ]);
    } catch (err) {
      r = { toolCallId: tc.id, name: tc.name, result: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (!r.toolCallId) r = { ...r, toolCallId: tc.id, name: tc.name };
    const content = resultToContent(r);
    summary.push({ name: tc.name, ms: now() - t0, chars: content.length, ...(r.error ? { error: r.error } : {}) });
    return r;
  }));

  const messages: ChatMessage[] = [];
  if (calls.length) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: calls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })),
    } as ChatMessage);
    for (const r of results) {
      messages.push({ role: 'tool', content: resultToContent(r), tool_call_id: r.toolCallId, name: r.name } as ChatMessage);
    }
  }
  return { messages, toolCalls: calls, toolResults: results, summary, skipped };
}
