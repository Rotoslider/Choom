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
}

export class LLMClient {
  private endpoint: string;
  private settings: LLMSettings;
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
    toolChoice?: 'auto' | 'required' | 'none'
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const url = ensureEndpoint(this.endpoint, '/chat/completions');

    // Sanitize messages: some APIs (Mistral, etc.) reject assistant messages
    // with empty content and no tool_calls. Filter these out.
    const sanitizedMessages = messages.filter(m => {
      if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) return false;
      return true;
    });

    const body: ChatCompletionRequest = {
      model: this.settings.model,
      messages: sanitizedMessages,
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
      stream: true,
    };

    // Extended params (provider-specific, only sent when present)
    if (this.settings.topK !== undefined) body.top_k = this.settings.topK;
    if (this.settings.repetitionPenalty !== undefined) body.repetition_penalty = this.settings.repetitionPenalty;

    if (tools && tools.length > 0) {
      // Slim down tool definitions: truncate descriptions and strip parameter
      // descriptions to reduce token overhead for local models.
      body.tools = tools.map((t) => ({
        type: 'function' as const,
        function: slimToolDefinition(t),
      }));
      body.tool_choice = toolChoice || 'auto';

      // Disable thinking when tools are present — thinking models (Qwen 3.5, etc.)
      // burn timeout on reasoning and can confuse conversation context with tool
      // arguments. Tool calling doesn't benefit from chain-of-thought.
      if (this.settings.enableThinking !== false) {
        body.chat_template_kwargs = { enable_thinking: false };
      }
    } else if (this.settings.enableThinking !== undefined) {
      body.chat_template_kwargs = { enable_thinking: this.settings.enableThinking };
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
  ): Promise<{ content: string; toolCalls: ToolCall[] | null; finishReason: string }> {
    const url = ensureEndpoint(this.endpoint, '/chat/completions');

    const body: ChatCompletionRequest = {
      model: this.settings.model,
      messages,
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

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function' as const,
        function: slimToolDefinition(t),
      }));
      body.tool_choice = 'auto';
      // Disable thinking when tools are present (see streamChat for rationale)
      if (this.settings.enableThinking !== false) {
        body.chat_template_kwargs = { enable_thinking: false };
      }
    } else if (this.settings.enableThinking !== undefined) {
      body.chat_template_kwargs = { enable_thinking: this.settings.enableThinking };
    }
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

    return {
      content: choice.message.content || '',
      toolCalls,
      finishReason: choice.finish_reason,
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

// Slim down a tool definition for the API request: truncate description,
// strip parameter descriptions, and simplify enum lists. Saves ~40-60% of
// the tokens spent on tool schemas, which matters for local models.
function slimToolDefinition(t: ToolDefinition): Record<string, unknown> {
  // Truncate description to first sentence or 120 chars
  let desc = t.description;
  const sentenceEnd = desc.indexOf('. ');
  if (sentenceEnd > 0 && sentenceEnd < 120) {
    desc = desc.slice(0, sentenceEnd + 1);
  } else if (desc.length > 120) {
    desc = desc.slice(0, 117) + '...';
  }

  // Slim down parameter properties: keep type, enum, required but drop descriptions
  const slimProps: Record<string, Record<string, unknown>> = {};
  if (t.parameters?.properties) {
    for (const [key, param] of Object.entries(t.parameters.properties)) {
      const slim: Record<string, unknown> = { type: param.type };
      if (param.enum) slim.enum = param.enum;
      if (param.items) slim.items = param.items;
      if (param.default !== undefined) slim.default = param.default;
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
