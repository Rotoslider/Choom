/**
 * OpenRouter app attribution headers.
 *
 * OpenRouter lists usage under an app name in the Activity dashboard only when
 * requests carry HTTP-Referer — the app page's URL and the single required
 * identifier — paired with a title header (X-OpenRouter-Title, X-Title for
 * backwards compatibility). A title alone (the previous "fix" of X-Title only)
 * never creates an app entry: every request lands under "Unknown".
 * https://openrouter.ai/docs/app-attribution
 *
 * These tests pin the wire contract: every OpenRouter-bound request from every
 * client carries the full attribution trio, and non-OpenRouter endpoints get
 * none of it.
 */
import { LLMClient } from '../lib/llm-client';
import { AnthropicClient } from '../lib/anthropic-client';
import { openRouterAttributionHeaders, OPENROUTER_APP_URL } from '../lib/utils';

const OPENROUTER_EP = 'https://openrouter.ai/api/v1';
const LMSTUDIO_EP = 'http://127.0.0.1:1234/v1';
const ANTHROPIC_EP = 'https://api.anthropic.com';

const makeSettings = (endpoint: string) => ({
  endpoint,
  model: 'openai/gpt-5.6-luna-pro',
  temperature: 0.7,
  maxTokens: 1024,
  contextLength: 128000,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
});

// Minimal fetch doubles: a fake streaming body reader and a plain JSON response.
const fakeStreamResponse = (lines: string[]) => {
  const chunks = lines.map((l) => `${l}\n\n`);
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false as const, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true as const, value: undefined },
        releaseLock: () => {},
      }),
    },
  };
};

const fakeJsonResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

const llmStreamLines = [
  'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
  'data: [DONE]',
];

const anthropicStreamLines = [
  'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"m","usage":{"input_tokens":10}}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
];

const chatJson = {
  choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: null }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const anthropicChatJson = {
  content: [{ type: 'text', text: 'ok' }],
  model: 'm',
  usage: { input_tokens: 1, output_tokens: 1 },
};

const capturedRequest = () => {
  const call = (global.fetch as jest.Mock).mock.calls[0];
  return { url: call[0] as string, init: call[1] as { headers: Record<string, string> } };
};

const consume = async (it: AsyncGenerator<unknown, void, unknown>) => {
  for await (const _ of it) {
    /* drain */
  }
};

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('openRouterAttributionHeaders', () => {
  test('OpenRouter endpoint returns the full attribution trio plus categories', () => {
    const h = openRouterAttributionHeaders(OPENROUTER_EP);
    expect(h['HTTP-Referer']).toBe(OPENROUTER_APP_URL);
    expect(h['X-OpenRouter-Title']).toBe('Choom');
    expect(h['X-Title']).toBe('Choom');
    expect(h['X-OpenRouter-Categories']).toBe('personal-agent,general-chat');
  });

  test('non-OpenRouter endpoints return nothing — no header leakage to local/anthropic', () => {
    expect(openRouterAttributionHeaders(LMSTUDIO_EP)).toEqual({});
    expect(openRouterAttributionHeaders(ANTHROPIC_EP)).toEqual({});
    expect(openRouterAttributionHeaders('')).toEqual({});
  });
});

describe('OpenRouter attribution on the wire', () => {
  test('LLMClient.streamChat sends Attribution + bearer auth to OpenRouter', async () => {
    global.fetch = jest.fn().mockResolvedValue(fakeStreamResponse(llmStreamLines)) as unknown as typeof fetch;
    const client = new LLMClient(makeSettings(OPENROUTER_EP), 'sk-or-v1-test');
    await consume(client.streamChat([{ role: 'user', content: 'hi' }]));
    const { url, init } = capturedRequest();
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-or-v1-test',
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-OpenRouter-Title': 'Choom',
      'X-Title': 'Choom',
    });
  });

  test('LLMClient.chat attributes HTTP + bearer auth to OpenRouter', async () => {
    global.fetch = jest.fn().mockResolvedValue(fakeJsonResponse(chatJson)) as unknown as typeof fetch;
    const client = new LLMClient(makeSettings(OPENROUTER_EP), 'sk-or-v1-test');
    await client.chat([{ role: 'user', content: 'hi' }]);
    const { init } = capturedRequest();
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-or-v1-test',
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-OpenRouter-Title': 'Choom',
      'X-Title': 'Choom',
    });
  });

  test('AnthropicClient.streamChat attributes headers on the Anthropic-compatible path', async () => {
    global.fetch = jest.fn().mockResolvedValue(fakeStreamResponse(anthropicStreamLines)) as unknown as typeof fetch;
    const client = new AnthropicClient(makeSettings(OPENROUTER_EP), 'sk-or-v1-test', OPENROUTER_EP);
    await consume(client.streamChat([{ role: 'user', content: 'hi' }]));
    const { init } = capturedRequest();
    expect(init.headers).toMatchObject({
      'x-api-key': 'sk-or-v1-test',
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-OpenRouter-Title': 'Choom',
      'X-Title': 'Choom',
    });
  });

  test('AnthropicClient.chat attributes headers on non-streaming calls', async () => {
    global.fetch = jest.fn().mockResolvedValue(fakeJsonResponse(anthropicChatJson)) as unknown as typeof fetch;
    const client = new AnthropicClient(makeSettings(OPENROUTER_EP), 'sk-or-v1-test', OPENROUTER_EP);
    await client.chat([{ role: 'user', content: 'hi' }]);
    const { init } = capturedRequest();
    expect(init.headers).toMatchObject({
      'x-api-key': 'sk-or-v1-test',
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-OpenRouter-Title': 'Choom',
      'X-Title': 'Choom',
    });
  });

  test('local LLM endpoints never receive attribution headers', async () => {
    global.fetch = jest.fn().mockResolvedValue(fakeJsonResponse(chatJson)) as unknown as typeof fetch;
    const client = new LLMClient(makeSettings(LMSTUDIO_EP), 'sk-local');
    await client.chat([{ role: 'user', content: 'hi' }]);
    const { init } = capturedRequest();
    expect(init.headers['HTTP-Referer']).toBeUndefined();
    expect(init.headers['X-OpenRouter-Title']).toBeUndefined();
    expect(init.headers['X-Title']).toBeUndefined();
  });
});