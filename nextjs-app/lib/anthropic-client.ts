/**
 * Anthropic API Client Adapter
 * Translates Anthropic Messages API into OpenAI-compatible ChatCompletionChunk format
 * so the agentic tool loop in route.ts works unchanged.
 */

import type { LLMSettings, ToolDefinition, ToolCall } from './types';
import type { ChatMessage, ChatCompletionChunk } from './llm-client';

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

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

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
   */
  private convertMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
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
        const contentBlocks: AnthropicContentBlock[] = [];
        if (msg.content) {
          contentBlocks.push({ type: 'text', text: msg.content });
        }
        // Convert tool_calls to tool_use content blocks
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input: unknown = {};
            try {
              input = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
            } catch { /* keep empty */ }
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }

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

    return { system, messages: converted };
  }

  /**
   * Streaming chat that yields OpenAI-format ChatCompletionChunk objects.
   * Parses Anthropic SSE stream and translates events.
   */
  async *streamChat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required' | 'none'
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const { system, messages: anthropicMessages } = this.convertMessages(messages);

    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages: anthropicMessages,
      max_tokens: this.settings.maxTokens || 4096,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      stream: true,
    };

    if (system) {
      body.system = system;
    }

    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
      if (toolChoice === 'required') {
        body.tool_choice = { type: 'any' };
      } else if (toolChoice === 'none') {
        body.tool_choice = { type: 'none' };  // Anthropic doesn't support 'none' exactly, but let's try
      } else {
        body.tool_choice = { type: 'auto' };
      }
    }

    const url = `${this.endpoint}/v1/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic request failed: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolIndex = -1;
    let messageId = '';

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

          if (eventType === 'message_start') {
            const msg = event.message as { id?: string; model?: string };
            messageId = msg?.id || `msg_${Date.now()}`;
          }

          // Text content
          if (eventType === 'content_block_delta') {
            const delta = event.delta as { type: string; text?: string; partial_json?: string };

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
          }

          // Tool use start
          if (eventType === 'content_block_start') {
            const block = event.content_block as { type: string; id?: string; name?: string };
            if (block?.type === 'tool_use') {
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

          // Message complete
          if (eventType === 'message_delta') {
            const delta = event.delta as { stop_reason?: string };
            if (delta?.stop_reason) {
              const finishReason = delta.stop_reason === 'tool_use' ? 'tool_calls'
                : delta.stop_reason === 'end_turn' ? 'stop'
                : delta.stop_reason === 'max_tokens' ? 'length'
                : 'stop';
              yield this.makeChunk(messageId, {}, finishReason);
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
  ): Promise<{ content: string; toolCalls: ToolCall[] | null; finishReason: string }> {
    const { system, messages: anthropicMessages } = this.convertMessages(messages);

    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages: anthropicMessages,
      max_tokens: this.settings.maxTokens || 4096,
      temperature: this.settings.temperature,
      top_p: this.settings.topP,
      stream: false,
    };

    if (system) {
      body.system = system;
    }

    if (tools && tools.length > 0) {
      body.tools = this.convertTools(tools);
      body.tool_choice = { type: 'auto' };
    }

    const url = `${this.endpoint}/v1/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic request failed: ${response.status} - ${error}`);
    }

    const data = await response.json();

    let content = '';
    let toolCalls: ToolCall[] | null = null;

    for (const block of (data.content || [])) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input || {},
        });
      }
    }

    const stopReason = data.stop_reason === 'tool_use' ? 'tool_calls'
      : data.stop_reason === 'end_turn' ? 'stop'
      : data.stop_reason === 'max_tokens' ? 'length'
      : 'stop';

    return { content, toolCalls, finishReason: stopReason };
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
