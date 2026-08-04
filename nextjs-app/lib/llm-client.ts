import type { LLMSettings, ToolDefinition, ToolCall } from './types';
import { ensureEndpoint } from './utils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: 'function';
    function: ToolDefinition | Record<string, unknown>;
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  // Extended params (provider-specific)
  top_k?: number;
  repetition_penalty?: number;
  chat_template_kwargs?: Record<string, unknown>;
}

export interface TokenUsageData {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: TokenUsageData;
}

/**
 * Normalize a message array into a shape every provider accepts.
 *
 * The strictest consumers are local GGUF chat templates (Qwen/ChatML via
 * LM Studio / llama.cpp). Their Jinja does:
 *
 *   {%- if message.role == 'system' and not loop.first %}
 *       {{- raise_exception('System message must be at the beginning.') }}
 *
 * which turns any late system turn into a hard HTTP 400 for the whole
 * request — no output, no recovery, just a dead turn. Cloud providers are
 * more forgiving, so this normalizes to the strictest common denominator and
 * both local and remote models stay valid.
 *
 * Rules applied, in order:
 *  1. Drop assistant turns that are empty AND carry no tool_calls (Mistral et al. reject them).
 *  2. Merge every system message into a single leading system turn. Late
 *     system content is guidance, so it is appended to the head system
 *     prompt rather than dropped — the instruction still lands, it just
 *     lands somewhere the template accepts.
 *  3. Guarantee the conversation does not end on an assistant turn (NVIDIA
 *     and others set add_generation_prompt=True and require user-last).
 */
export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const systemParts: string[] = [];

  for (const m of messages) {
    if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) continue;
    if (m.role === 'system') {
      // Collect rather than emit — every system turn is folded into index 0 below.
      if (m.content?.trim()) systemParts.push(m.content.trim());
      continue;
    }
    out.push(m);
  }

  if (systemParts.length > 0) {
    out.unshift({ role: 'system', content: systemParts.join('\n\n') });
  }

  // A trailing assistant turn breaks providers that force a generation prompt.
  if (out.length > 0 && out[out.length - 1].role === 'assistant') {
    out.push({ role: 'user', content: 'Continue. Respond to the user based on the above context.' });
  }

  return out;
}

export class LLMClient {
  private endpoint: string;
  public settings: LLMSettings;
  private apiKey?: string;

  constructor(settings: LLMSettings, apiKey?: string) {
    this.endpoint = settings.endpoint;
    this.settings = settings;
    this.apiKey = apiKey;
  }

  async *streamChat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required' | 'none',
    onConnected?: () => void,
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const url = ensureEndpoint(this.endpoint, '/chat/completions');

    const sanitizedMessages = sanitizeMessages(messages);

    const body: ChatCompletionRequest & { stream_options?: { include_usage: boolean } } = {
      model: this.settings.model,
      messages: sanitizedMessages,
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
      stream: true,
      stream_options: { include_usage: true }, // Request usage data in final chunk
    };

    // Extended params (provider-specific, only sent when present)
    if (this.settings.topK !== undefined) body.top_k = this.settings.topK;
    if (this.settings.repetitionPenalty !== undefined) body.repetition_penalty = this.settings.repetitionPenalty;

    // enableThinking: only send chat_template_kwargs when explicitly set in profile
    if (this.settings.enableThinking !== undefined) {
      body.chat_template_kwargs = { enable_thinking: this.settings.enableThinking };
    }

    if (tools && tools.length > 0) {
      // Slim down tool definitions: truncate descriptions and strip parameter
      // descriptions to reduce token overhead for local models.
      body.tools = tools.map((t) => ({
        type: 'function' as const,
        function: slimToolDefinition(t),
      }));
      body.tool_choice = toolChoice || 'auto';
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM request failed: ${response.status} - ${error}`);
    }

    // Connection established — HTTP 200 received, server is alive and processing.
    // Notify the caller so they can switch from aggressive connection timeout
    // to generous prefill timeout.
    onConnected?.();

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            yield json as ChatCompletionChunk;
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[]
  ): Promise<{ content: string; toolCalls: ToolCall[] | null; finishReason: string; usage?: TokenUsageData }> {
    const url = ensureEndpoint(this.endpoint, '/chat/completions');

    const body: ChatCompletionRequest = {
      model: this.settings.model,
      messages: sanitizeMessages(messages),
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
      stream: false,
    };

    // Extended params (provider-specific, only sent when present)
    if (this.settings.topK !== undefined) body.top_k = this.settings.topK;
    if (this.settings.repetitionPenalty !== undefined) body.repetition_penalty = this.settings.repetitionPenalty;

    // enableThinking: only send chat_template_kwargs when explicitly set in profile
    if (this.settings.enableThinking !== undefined) {
      body.chat_template_kwargs = { enable_thinking: this.settings.enableThinking };
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function' as const,
        function: slimToolDefinition(t),
      }));
      body.tool_choice = 'auto';
    }

    const chatHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) chatHeaders['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM request failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`LLM returned unexpected response format: ${JSON.stringify(data).slice(0, 200)}`);
    }

    let toolCalls: ToolCall[] | null = null;
    if (choice.message.tool_calls) {
      toolCalls = choice.message.tool_calls.map((tc: {
        id: string;
        function: { name: string; arguments: string };
      }) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));
    }

    // Extract usage data if present
    const usage: TokenUsageData | undefined = data.usage ? {
      prompt_tokens: data.usage.prompt_tokens || 0,
      completion_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    } : undefined;

    return {
      content: choice.message.content || '',
      toolCalls,
      finishReason: choice.finish_reason,
      usage,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = ensureEndpoint(this.endpoint, '/models');
      const response = await fetch(url, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Slim down a tool definition for the API request. Still saves a large share
// of the schema tokens, but no longer starves the model (C-28): the old
// first-sentence/117-char cut + full param-doc strip delivered 30% of the
// authored description text and 0% of the parameter docs — deleting exactly
// the decision rules a 35B model cannot infer (measured: 43,245 chars of
// authored guidance never reached the model). Now: whole sentences up to
// 200 chars, and REQUIRED parameters keep their docs at up to 80 chars —
// measured at ~+5k tokens across the full 131-tool set, on prompts that
// run 80-90k in production.
export function slimToolDefinition(t: ToolDefinition): Record<string, unknown> {
  // Keep whole sentences while they fit in 200 chars.
  let desc = t.description;
  if (desc.length > 200) {
    let cut = -1;
    for (let i = desc.indexOf('. '); i !== -1 && i < 200; i = desc.indexOf('. ', i + 1)) {
      cut = i;
    }
    desc = cut > 0 ? desc.slice(0, cut + 1) : desc.slice(0, 197) + '...';
  }

  const required = new Set(t.parameters?.required ?? []);
  const slimProps: Record<string, Record<string, unknown>> = {};
  if (t.parameters?.properties) {
    for (const [key, param] of Object.entries(t.parameters.properties)) {
      const slim: Record<string, unknown> = { type: param.type };
      if (param.enum) slim.enum = param.enum;
      if (param.items) slim.items = param.items;
      if (param.default !== undefined) slim.default = param.default;
      // Required params keep their docs — "what goes here" is the difference
      // between a call that works and a param error (or a phantom narration).
      if (required.has(key) && typeof param.description === 'string' && param.description) {
        slim.description = param.description.length > 80
          ? param.description.slice(0, 77) + '...'
          : param.description;
      }
      slimProps[key] = slim;
    }
  }

  return {
    name: t.name,
    description: desc,
    parameters: {
      type: 'object',
      properties: slimProps,
      ...(t.parameters?.required ? { required: t.parameters.required } : {}),
    },
  };
}

// Helper to accumulate streaming tool calls
export function accumulateToolCalls(
  accumulated: Map<number, { id: string; name: string; arguments: string }>,
  delta: ChatCompletionChunk['choices'][0]['delta']
): void {
  if (!delta.tool_calls) return;

  for (const tc of delta.tool_calls) {
    const existing = accumulated.get(tc.index);
    if (existing) {
      // Append to existing — also fill in ID/name if they arrive in a later chunk
      if (tc.id && !existing.id) existing.id = tc.id;
      if (tc.function?.name && !existing.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
    } else {
      // New tool call — generate fallback ID if model emits empty/missing ID
      accumulated.set(tc.index, {
        id: tc.id || `tc_${Date.now()}_${tc.index}`,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '',
      });
    }
  }
}
