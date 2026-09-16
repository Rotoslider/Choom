/**
 * Shrink a conversation for a LOCAL fallback model (2026-09-16).
 *
 * A 1:1 chat sized for DeepSeek's million-token window reached Gemma 4 31B
 * on the Mac as a 58k-token prompt. At ~190 prompt tokens/s that is five
 * minutes of prefill; Node's default body timeout cut the socket at 300 s
 * ("terminated") and the turn escalated again. A fallback exists to get a
 * reply out, not to preserve every old message, so before a local fallback
 * the transcript is cut to the newest messages that fit `maxTokens`, whole
 * assistant+tool groups at a time, with a one-line notice where the cut is.
 */
import type { ChatMessage } from '@/lib/llm-client';

export const LOCAL_FALLBACK_PROMPT_TOKENS = 20_000;

export interface TrimResult {
  messages: ChatMessage[];
  dropped: number;
  tokensBefore: number;
  tokensAfter: number;
}

const NOTICE = '[Earlier parts of this conversation were left out so a smaller local model can answer quickly. Reply to the most recent messages.]';

/**
 * Keep messages[0] (the system prompt) and the newest messages up to
 * `maxTokens`, never separating a tool result from the assistant turn that
 * called it. `estimate(m)` returns a message's token cost.
 */
export function trimForLocalFallback(messages: ChatMessage[], maxTokens: number, estimate: (m: ChatMessage) => number): TrimResult {
  const total = messages.reduce((s, m) => s + estimate(m), 0);
  if (messages.length < 3 || total <= maxTokens) return { messages, dropped: 0, tokensBefore: total, tokensAfter: total };

  const system = messages[0];
  const rest = messages.slice(1);
  // Group: an assistant message with tool_calls owns the tool messages that follow it.
  const groups: ChatMessage[][] = [];
  for (const m of rest) {
    const last = groups[groups.length - 1];
    if (m.role === 'tool' && last && last[0].role === 'assistant' && (last[0] as { tool_calls?: unknown }).tool_calls) last.push(m);
    else groups.push([m]);
  }
  let budget = maxTokens - estimate(system) - Math.ceil(NOTICE.length / 4);
  const kept: ChatMessage[][] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i].reduce((s, m) => s + estimate(m), 0);
    if (cost > budget && kept.length > 0) break;
    kept.unshift(groups[i]);
    budget -= cost;
    if (budget <= 0) break;
  }
  let flat = kept.flat();
  // Never start the kept history on a tool result or an assistant turn a
  // strict template would reject; drop leading non-user messages.
  while (flat.length && flat[0].role !== 'user') flat = flat.slice(1);
  if (!flat.length) flat = [rest[rest.length - 1]];
  const out: ChatMessage[] = [system, { role: 'user', content: NOTICE } as ChatMessage, ...flat];
  const dropped = rest.length - flat.length;
  return { messages: out, dropped, tokensBefore: total, tokensAfter: out.reduce((s, m) => s + estimate(m), 0) };
}
