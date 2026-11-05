/**
 * Anthropic API Client Adapter
 * Translates Anthropic Messages API into OpenAI-compatible ChatCompletionChunk format
 * so the agentic tool loop in route.ts works unchanged.
 *
 * Current Claude models (Opus 4.7 on, every Claude 5 model) reject temperature and
 * top_p, and Opus 5.5 / Sonnet 5.5 / Fable 5.1 reject a forced tool call. They think
 * before they answer and before tool calls, silently (no deltas while thinking), and
 * their thinking blocks are sent back with the tool calls they came with, so the
 * model keeps its reasoning through a tool loop. claudeModelTraits says which
 * request fields a model takes.
 */

import type { LLMSettings, ToolDefinition, ToolCall } from './types';
import { openRouterAttributionHeaders } from './utils';
import type { ChatMessage, ChatCompletionChunk, TokenUsageData } from './llm-client';

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  thinking?: string;
  signature?: string;
  data?: string;
}

// ============================================================================
// What each Claude model accepts
// ============================================================================

export interface ClaudeModelTraits {
  /** temperature / top_p accepted. Opus 4.7 and later (every Claude 5 model) answer them with a 400. */
  sampling: boolean;
  /** tool_choice "any" accepted. Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 answer it with a 400. */
  forcedToolChoice: boolean;
  /** A final assistant message (prefill) accepted. Removed from the 4.6 models on. */
  prefill: boolean;
  /** Anthropic's server-side refusal fallback (`fallbacks: "default"`). */
  serverFallback: boolean;
  /** thinking.block_binding accepted ("preserved thinking" models). */
  thinkingBinding: boolean;
}

const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const THINKING_BINDING_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']);

/**
 * Reads the family and version out of a Claude model id ("claude-opus-5-5",
 * "claude-sonnet-4-5-20250929", OpenRouter's "anthropic/claude-opus-4.5").
 * An id it can't read is treated as a current model: newer models only drop
 * request fields, so the current request shape is the safe guess.
 */
export function claudeModelTraits(model: string): ClaudeModelTraits {
  const id = (model || '').toLowerCase().replace(/^anthropic[./]/, '').replace(/\./g, '-');
  if (/^claude-(2|3|instant)/.test(id)) {
    return { sampling: true, forcedToolChoice: true, prefill: true, serverFallback: false, thinkingBinding: false };
  }
  const m = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d))?(?:-\d{8}|-latest)?$/);
  if (!m) {
    return { sampling: false, forcedToolChoice: false, prefill: false, serverFallback: false, thinkingBinding: false };
  }
  const version = Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  const base = `claude-${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
  return {
    sampling: version < 4.7,
    forcedToolChoice: version < 5.1,
    prefill: version < 4.6,
    serverFallback: SERVER_FALLBACK_MODELS.has(base),
    thinkingBinding: THINKING_BINDING_MODELS.has(base),
  };
}

/** Anthropic's own API (beta features, prompt caching), as opposed to a compatible proxy. */
function isAnthropicApi(endpoint: string): boolean {
  return /^https?:\/\/api\.anthropic\.com(\/|$)/.test(endpoint);
}

// ============================================================================
// Thinking blocks kept for the tool loop
// ============================================================================

const isThinkingBlock = (b: AnthropicContentBlock) => b.type === 'thinking' || b.type === 'redacted_thinking';

// A response that ends in tool calls is remembered here: its blocks in order,
// thinking blocks in full, text and tool calls as markers. The loop sends the
// tool calls back as an OpenAI-style assistant message, and convertMessages
// puts the thinking back around them (looked up by tool call id).
const thinkingByToolUse = new Map<string, AnthropicContentBlock[]>();
const THINKING_MEMORY_LIMIT = 500;

function rememberThinking(order: AnthropicContentBlock[], toolUseIds: string[]): void {
  if (toolUseIds.length === 0 || !order.some(isThinkingBlock)) return;
  const kept = order.slice();
  for (const id of toolUseIds) {
    thinkingByToolUse.delete(id);
    thinkingByToolUse.set(id, kept);
  }
  while (thinkingByToolUse.size > THINKING_MEMORY_LIMIT) {
    const oldest = thinkingByToolUse.keys().next().value;
    if (oldest === undefined) break;
    thinkingByToolUse.delete(oldest);
  }
}

/** Tests only. */
export function forgetThinking(): void {
  thinkingByToolUse.clear();
}

/**
 * The assistant message as the model wrote it: its thinking blocks where they
 * were, the loop's text at the first text block, the loop's tool calls at the
 * first tool call.
 */
export function withReplayedThinking(
  order: AnthropicContentBlock[],
  text: string,
  toolUses: AnthropicContentBlock[],
): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = [];
  let textPlaced = !text;
  let toolsPlaced = toolUses.length === 0;
  for (const block of order) {
    if (isThinkingBlock(block)) {
      out.push(block);
    } else if (block.type === 'text' && !textPlaced) {
      out.push({ type: 'text', text });
      textPlaced = true;
    } else if (block.type === 'tool_use' && !toolsPlaced) {
      if (!textPlaced) {
        out.push({ type: 'text', text });
        textPlaced = true;
      }
      out.push(...toolUses);
      toolsPlaced = true;
    }
  }
  if (!textPlaced) out.push({ type: 'text', text });
  if (!toolsPlaced) out.push(...toolUses);
  return out;
}

// ============================================================================
// Response helpers
// ============================================================================

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Anthropic counts cached prompt tokens apart from input_tokens; the loop wants them in the prompt total. */
export function usageFromAnthropic(u: AnthropicUsage | undefined): TokenUsageData | undefined {
  if (!u) return undefined;
  const cacheRead = u.cache_read_input_tokens || 0;
  const prompt = (u.input_tokens || 0) + cacheRead + (u.cache_creation_input_tokens || 0);
  const completion = u.output_tokens || 0;
  if (!prompt && !completion) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

function finishReasonFor(stopReason: string | undefined): string {
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return 'length';
  return 'stop';
}

// ============================================================================
// Client
// ============================================================================

export class AnthropicClient {
  private endpoint: string;
  private apiKey: string;
  private settings: LLMSettings;

  constructor(settings: LLMSettings, apiKey: string, endpoint?: string) {
    this.endpoint = endpoint || 'https://api.anthropic.com';
    this.apiKey = apiKey;
    this.settings = settings;
  }

  /**
   * Convert OpenAI-format tools to Anthropic format
   */
  private convertTools(tools: ToolDefinition[]): AnthropicTool[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: t.parameters.properties,
        required: t.parameters.required,
      },
    }));
  }

  /**
   * Convert OpenAI-format messages to Anthropic format.
   * - Extracts system messages into separate system parameter
   * - Converts tool role messages to user role with tool_result content blocks
   * - Merges consecutive same-role messages (Anthropic requires strict alternation)
   * - Puts remembered thinking blocks back with the tool calls they came with
   * - Skips empty messages (a 400) and, for models without prefill, never ends on an assistant message
   */
  private convertMessages(
    messages: ChatMessage[],
    traits: ClaudeModelTraits,
    replayThinking: boolean,
  ): { system: string; messages: AnthropicMessage[] } {
    let system = '';
    const converted: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n\n' : '') + msg.content;
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results become user messages with tool_result content blocks
        const block: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || '',
          content: msg.content,
        };
        // Try to merge with previous user message
        const last = converted[converted.length - 1];
        if (last && last.role === 'user') {
          if (typeof last.content === 'string') {
            last.content = [{ type: 'text', text: last.content }, block];
          } else {
            (last.content as AnthropicContentBlock[]).push(block);
          }
        } else {
          converted.push({ role: 'user', content: [block] });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        const toolUses: AnthropicContentBlock[] = [];
        // Convert tool_calls to tool_use content blocks
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input: unknown = {};
            try {
              input = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
            } catch { /* keep empty */ }
            toolUses.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }

        const remembered = replayThinking && msg.tool_calls
          ? msg.tool_calls.map(tc => thinkingByToolUse.get(tc.id)).find(Boolean)
          : undefined;
        const contentBlocks: AnthropicContentBlock[] = remembered
          ? withReplayedThinking(remembered, msg.content || '', toolUses)
          : [...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []), ...toolUses];
        if (contentBlocks.length === 0) continue;

        // Merge consecutive assistant messages
        const last = converted[converted.length - 1];
        if (last && last.role === 'assistant') {
          if (typeof last.content === 'string') {
            last.content = [{ type: 'text', text: last.content }, ...contentBlocks];
          } else {
            (last.content as AnthropicContentBlock[]).push(...contentBlocks);
          }
        } else {
          converted.push({
            role: 'assistant',
            content: contentBlocks.length === 1 && contentBlocks[0].type === 'text'
              ? contentBlocks[0].text!
              : contentBlocks,
          });
        }
        continue;
      }

      // User messages
      if (!msg.content || !msg.content.trim()) continue;
      const last = converted[converted.length - 1];
      if (last && last.role === 'user') {
        // Merge consecutive user messages
        if (typeof last.content === 'string') {
          last.content = last.content + '\n\n' + msg.content;
        } else {
          (last.content as AnthropicContentBlock[]).push({ type: 'text', text: msg.content });
        }
      } else {
        converted.push({ role: 'user', content: msg.content });
      }
    }

    // Ensure first message is from user (Anthropic requirement)
    if (converted.length > 0 && converted[0].role !== 'user') {
      converted.unshift({ role: 'user', content: '.' });
    }
    // A conversation ending on an assistant message is a prefill, which current models answer with a 400
    if (!traits.prefill && converted.length > 0 && converted[converted.length - 1].role === 'assistant') {
      converted.push({ role: 'user', content: 'Continue.' });
    }

    return { system, messages: converted };
  }

  /** The request body and the beta headers it needs. */
  private buildRequest(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    toolChoice: 'auto' | 'required' | 'none' | undefined,
    stream: boolean,
  ): { body: Record<string, unknown>; betas: string[] } {
    const traits = claudeModelTraits(this.settings.model);
    const official = isAnthropicApi(this.endpoint);
    const { system, messages: anthropicMessages } = this.convertMessages(messages, traits, official);

    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages: anthropicMessages,
      max_tokens: this.settings.maxTokens || 4096,
      stream,
    };

    // Older models: temperature or top_p, never both. Current ones reject both.
    if (traits.sampling) {
      if (this.settings.temperature !== undefined && this.settings.temperature !== null) {
        body.temperature = this.settings.temperature;
      } else if (this.settings.topP !== undefined && this.settings.topP !== null) {
        body.top_p = this.settings.topP;
      } else {
        body.temperature = 0.7;
      }
    }

    if (system) {
      body.system = system;
    }

    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
      if (toolChoice === 'required' && traits.forcedToolChoice) {
        body.tool_choice = { type: 'any' };
      } else if (toolChoice === 'none') {
        body.tool_choice = { type: 'none' };
      } else {
        // 'required' on a model that can't be forced: auto (the loop's narration nudge covers a skipped call)
        body.tool_choice = { type: 'auto' };
      }
    }

    const betas: string[] = [];
    if (official) {
      // Cache the whole prompt: each tool-loop round re-reads it at a tenth of the price or less
      body.cache_control = { type: 'ephemeral' };
      if (traits.serverFallback) {
        // A safety-classifier decline is answered by the model Anthropic recommends instead of nothing
        body.fallbacks = 'default';
        betas.push('server-side-fallback-2026-07-01');
      }
      if (traits.thinkingBinding) {
        // Thinking replayed after the loop edited earlier messages is dropped, not a 400
        body.thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
        betas.push('thinking-binding-controls-2026-08-01');
      }
    }

    return { body, betas };
  }

  private headers(betas: string[]): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      ...(betas.length > 0 ? { 'anthropic-beta': betas.join(',') } : {}),
      ...openRouterAttributionHeaders(this.endpoint),
    };
  }

  /**
   * Streaming chat that yields OpenAI-format ChatCompletionChunk objects.
   * Parses Anthropic SSE stream and translates events. While the model thinks
   * (no text yet), empty chunks keep the stream reader's stall timer alive.
   */
  async *streamChat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required' | 'none',
    onConnected?: () => void,
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const { body, betas } = this.buildRequest(messages, tools, toolChoice, true);

    const url = `${this.endpoint}/v1/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(betas),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic request failed: ${response.status} - ${error}`);
    }
    onConnected?.();

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolIndex = -1;
    let messageId = '';
    let usage: AnthropicUsage = {};
    const order: AnthropicContentBlock[] = [];
    const blockAt = new Map<number, AnthropicContentBlock>();
    const toolUseIds: string[] = [];
    const keepAlive = () => this.makeChunk(messageId, {}, null);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmed.slice(6));
          } catch {
            continue;
          }

          const eventType = event.type as string;

          if (eventType === 'ping') {
            yield keepAlive();
            continue;
          }

          if (eventType === 'message_start') {
            const msg = event.message as { id?: string; model?: string; usage?: AnthropicUsage };
            messageId = msg?.id || `msg_${Date.now()}`;
            usage = { ...(msg?.usage || {}) };
            if (msg?.model && msg.model !== this.settings.model) {
              console.log(`   🔀 Anthropic: ${this.settings.model} declined, ${msg.model} answered (server-side fallback)`);
            }
            yield keepAlive();
          }

          if (eventType === 'content_block_start') {
            const index = event.index as number;
            const block = event.content_block as Omit<AnthropicContentBlock, 'type'> & { type: string; from?: { model?: string }; to?: { model?: string } };
            if (block?.type === 'fallback') {
              // A classifier declined part-way and another model carries on. What came
              // before the switch is not sent back (Anthropic's echo rule).
              console.log(`   🔀 Anthropic: ${block.from?.model ?? '?'} declined mid-reply, ${block.to?.model ?? '?'} carries on`);
              order.length = 0;
            } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
              const kept: AnthropicContentBlock = block.type === 'thinking'
                ? { type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' }
                : { type: 'redacted_thinking', data: block.data };
              blockAt.set(index, kept);
              order.push(kept);
              yield keepAlive();
            } else if (block?.type === 'text') {
              order.push({ type: 'text' });
            } else if (block?.type === 'tool_use') {
              order.push({ type: 'tool_use' });
              if (block.id) toolUseIds.push(block.id);
              currentToolIndex++;
              yield this.makeChunk(messageId, {
                tool_calls: [{
                  index: currentToolIndex,
                  id: block.id,
                  type: 'function',
                  function: { name: block.name, arguments: '' },
                }],
              }, null);
            }
          }

          if (eventType === 'content_block_delta') {
            const index = event.index as number;
            const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string };

            if (delta.type === 'text_delta' && delta.text) {
              yield this.makeChunk(messageId, { content: delta.text }, null);
            }

            if (delta.type === 'input_json_delta' && delta.partial_json) {
              // Tool call argument streaming
              yield this.makeChunk(messageId, {
                tool_calls: [{
                  index: currentToolIndex,
                  function: { arguments: delta.partial_json },
                }],
              }, null);
            }

            if (delta.type === 'thinking_delta' || delta.type === 'signature_delta') {
              const kept = blockAt.get(index);
              if (kept && delta.type === 'thinking_delta') kept.thinking = (kept.thinking || '') + (delta.thinking || '');
              if (kept && delta.type === 'signature_delta') kept.signature = (kept.signature || '') + (delta.signature || '');
              yield keepAlive();
            }
          }

          // Message complete
          if (eventType === 'message_delta') {
            const delta = event.delta as { stop_reason?: string; stop_details?: { category?: string | null } | null };
            Object.assign(usage, (event.usage as AnthropicUsage | undefined) || {});
            if (delta?.stop_reason) {
              if (delta.stop_reason === 'refusal') {
                console.warn(`   🛑 Anthropic: ${this.settings.model} declined (category ${delta.stop_details?.category ?? 'none given'})`);
              }
              rememberThinking(order, toolUseIds);
              const chunk = this.makeChunk(messageId, {}, finishReasonFor(delta.stop_reason));
              const tokenUsage = usageFromAnthropic(usage);
              if (tokenUsage) chunk.usage = tokenUsage;
              yield chunk;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Non-streaming chat for summarization and other single-shot calls.
   * Returns the same shape as LLMClient.chat().
   */
  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[]
  ): Promise<{ content: string; toolCalls: ToolCall[] | null; finishReason: string; usage?: TokenUsageData }> {
    const { body, betas } = this.buildRequest(messages, tools, 'auto', false);

    const url = `${this.endpoint}/v1/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(betas),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic request failed: ${response.status} - ${error}`);
    }

    const data = await response.json();

    let content = '';
    let toolCalls: ToolCall[] | null = null;
    let order: AnthropicContentBlock[] = [];
    const toolUseIds: string[] = [];

    for (const block of (data.content || [])) {
      if (block.type === 'fallback') {
        order = [];
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        order.push(block);
      } else if (block.type === 'text') {
        content += block.text;
        order.push({ type: 'text' });
      } else if (block.type === 'tool_use') {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input || {},
        });
        order.push({ type: 'tool_use' });
        toolUseIds.push(block.id);
      }
    }
    rememberThinking(order, toolUseIds);

    if (data.stop_reason === 'refusal') {
      console.warn(`   🛑 Anthropic: ${this.settings.model} declined (category ${data.stop_details?.category ?? 'none given'})`);
    }

    return { content, toolCalls, finishReason: finishReasonFor(data.stop_reason), usage: usageFromAnthropic(data.usage) };
  }

  /** Create an OpenAI-format ChatCompletionChunk */
  private makeChunk(
    id: string,
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    },
    finishReason: string | null
  ): ChatCompletionChunk {
    return {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.settings.model,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    };
  }
}
