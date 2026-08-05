/**
 * findLLMProfile must resolve serving-stack variants of a model to its
 * profile — exact match first, then normalized (org prefix and tune/quant
 * suffixes stripped on both sides).
 *
 * The real failure this pins (C-53): the web client runs Aloy on
 * "google/gemma-4-31b-qat" while the built-in profile is keyed
 * "gemma-4-31b-it". Exact match missed, so contextLength stayed at the store
 * default 262,144 — double gemma's real 128k window — and compaction budgeted
 * against a window the model does not have. The bridge path clamps to 131,072;
 * the web path relied entirely on this lookup.
 */
import { findLLMProfile } from '../lib/model-profiles';
import type { LLMModelProfile } from '../lib/types';

describe('findLLMProfile', () => {
  test('exact match still wins', () => {
    const p = findLLMProfile('gemma-4-31b-it');
    expect(p).not.toBeNull();
    expect(p!.contextLength).toBe(128000);
  });

  test('the -qat serving variant resolves the gemma profile (the Aloy case)', () => {
    const p = findLLMProfile('google/gemma-4-31b-qat');
    expect(p).not.toBeNull();
    expect(p!.modelId).toBe('gemma-4-31b-it');
    expect(p!.contextLength).toBe(128000);
  });

  test('org-prefixed variant of an unprefixed profile resolves', () => {
    const p = findLLMProfile('google/gemma-4-26b-a4b-it');
    expect(p).not.toBeNull();
    expect(p!.contextLength).toBe(128000);
  });

  test('unknown models still return null (no false matches)', () => {
    expect(findLLMProfile('totally/unknown-model-9000b')).toBeNull();
  });

  test('normalization never cross-matches distinct models', () => {
    // kimi-k2-instruct normalizes to kimi-k2 — must not match kimi-k2.6
    const p = findLLMProfile('moonshotai/kimi-k2-instruct');
    expect(p!.modelId).toBe('moonshotai/kimi-k2-instruct');
  });

  test('user profiles merge over built-ins through the normalized path', () => {
    const user: LLMModelProfile[] = [
      { modelId: 'gemma-4-31b-it', label: 'mine', contextLength: 32768 },
    ];
    const p = findLLMProfile('google/gemma-4-31b-qat', user);
    expect(p).not.toBeNull();
    // user's RAM-capped context wins over the built-in 128000
    expect(p!.contextLength).toBe(32768);
  });
});
