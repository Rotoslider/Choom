/**
 * Live model metadata (context-window resolution from the serving endpoint).
 *
 * The static profile list went stale on 12 of 33 matchable models (2026-08-05
 * audit: deepseek-v4 understated 8x, gemma-4 carried gemma-3's window), so the
 * endpoint's own answer outranks it. These tests pin the three load-bearing
 * behaviors: LM Studio's loaded_context_length beats max_context_length,
 * failures serve the last good answer instead of breaking a turn, and unknown
 * endpoints return null so profiles stay authoritative.
 */
import { getLiveContextWindow, _resetModelMetadataCache } from '../lib/model-metadata';

const LMSTUDIO_EP = 'http://127.0.0.1:1234/v1';
const OPENROUTER_EP = 'https://openrouter.ai/api/v1';

const lmStudioBody = {
  data: [
    // 262k-native model RAM-capped at 131k: loaded_context_length is the truth
    { id: 'google/gemma-4-31b-qat', state: 'loaded', max_context_length: 262144, loaded_context_length: 131072 },
    { id: 'qwen/qwen3.6-35b-a3b', state: 'loaded', max_context_length: 262144, loaded_context_length: 262144 },
  ],
};
const openRouterBody = {
  data: [
    { id: 'openai/gpt-5.6-luna-pro', context_length: 1050000 },
    { id: 'deepseek/deepseek-v4-flash', context_length: 1048576 },
  ],
};

const mockFetch = (impl: (url: string) => unknown) => {
  global.fetch = jest.fn(async (url: unknown) => ({
    ok: true,
    json: async () => impl(String(url)),
  })) as unknown as typeof fetch;
};

beforeEach(() => {
  _resetModelMetadataCache();
  jest.restoreAllMocks();
});

describe('getLiveContextWindow', () => {
  test('LM Studio: loaded_context_length wins over max (the RAM-capped load)', async () => {
    mockFetch(() => lmStudioBody);
    expect(await getLiveContextWindow('google/gemma-4-31b-qat', LMSTUDIO_EP)).toBe(131072);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('http://127.0.0.1:1234/api/v0/models');
  });

  test('OpenRouter: context_length resolves 1M+ models the static list has never heard of', async () => {
    mockFetch(() => openRouterBody);
    expect(await getLiveContextWindow('openai/gpt-5.6-luna-pro', OPENROUTER_EP)).toBe(1050000);
  });

  test('normalized matching bridges serving-variant ids', async () => {
    mockFetch(() => lmStudioBody);
    // asking for the -it id finds the -qat entry (same base name)
    expect(await getLiveContextWindow('gemma-4-31b-it', LMSTUDIO_EP)).toBe(131072);
  });

  test('unknown endpoints return null — static profiles stay authoritative', async () => {
    mockFetch(() => { throw new Error('must not be called'); });
    expect(await getLiveContextWindow('mistralai/mistral-large-3-675b-instruct-2512', 'https://integrate.api.nvidia.com/v1')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('endpoint results are cached — one fetch serves repeat lookups', async () => {
    mockFetch(() => lmStudioBody);
    await getLiveContextWindow('google/gemma-4-31b-qat', LMSTUDIO_EP);
    await getLiveContextWindow('qwen/qwen3.6-35b-a3b', LMSTUDIO_EP);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  test('fetch failure is fail-soft: returns null, never throws', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(getLiveContextWindow('google/gemma-4-31b-qat', LMSTUDIO_EP)).resolves.toBeNull();
  });

  test('unknown model on a known endpoint returns null', async () => {
    mockFetch(() => lmStudioBody);
    expect(await getLiveContextWindow('some/other-model', LMSTUDIO_EP)).toBeNull();
  });
});
