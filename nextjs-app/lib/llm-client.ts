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
    function: ToolDefinition;
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
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

    const body: ChatCompletionRequest = {
      model: this.settings.model,
      messages,
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens,
      top_p: this.settings.topP,
      frequency_penalty: this.settings.frequencyPenalty,
      presence_penalty: this.settings.presencePenalty,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function' as const,
        function: t,
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

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function' as const,
        function: t,
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
    const choice = data.choices[0];

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

// Helper to accumulate streaming tool calls
export function accumulateToolCalls(
  accumulated: Map<number, { id: string; name: string; arguments: string }>,
  delta: ChatCompletionChunk['choices'][0]['delta']
): void {
  if (!delta.tool_calls) return;

  for (const tc of delta.tool_calls) {
    const existing = accumulated.get(tc.index);
    if (existing) {
      // Append to existing
      if (tc.function?.arguments) {
        existing.arguments += tc.function.arguments;
      }
    } else {
      // New tool call
      accumulated.set(tc.index, {
        id: tc.id || '',
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '',
      });
    }
  }
}
