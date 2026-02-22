/**
 * Model Profiles — per-model parameter defaults.
 * Auto-applied when a Choom or project uses a different model from the global setting.
 */

import type { LLMModelProfile, VisionModelProfile } from './types';

// ============================================================================
// Built-in LLM Profiles
// ============================================================================

export const BUILTIN_LLM_PROFILES: LLMModelProfile[] = [
  // NVIDIA Build models
  {
    modelId: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
    label: 'Nemotron Ultra 253B',
    builtIn: true,
    temperature: 0.6,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 131072,
    topK: 40,
    enableThinking: true,
  },
  {
    modelId: 'mistralai/mistral-large-3-675b-instruct-2512',
    label: 'Mistral Large 3 675B',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
  },
  {
    modelId: 'deepseek-ai/deepseek-v3.2',
    label: 'DeepSeek V3.2',
    builtIn: true,
    temperature: 0.6,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 131072,
  },
  {
    modelId: 'moonshotai/kimi-k2.5',
    label: 'Kimi K2.5',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
  },
  {
    modelId: 'moonshotai/kimi-k2-instruct',
    label: 'Kimi K2 Instruct',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
  },
  {
    modelId: 'qwen/qwen3.5-397b-a17b',
    label: 'Qwen 3.5 397B',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
    topK: 20,
    repetitionPenalty: 1.05,
  },
  {
    modelId: 'qwen/qwen3-next-80b-a3b-instruct',
    label: 'Qwen 3 Next 80B',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
    topK: 20,
  },
  {
    modelId: 'z-ai/glm5',
    label: 'GLM-5',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
    topK: 20,
  },
  {
    modelId: 'meta/llama-3.1-405b-instruct',
    label: 'Llama 3.1 405B',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
  },
  {
    modelId: 'meta/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
  },
  {
    modelId: 'mistralai/mistral-nemotron',
    label: 'Mistral Nemotron',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 131072,
  },
  // Anthropic models
  {
    modelId: 'claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 8192,
    contextLength: 200000,
  },
  {
    modelId: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 200000,
  },
  {
    modelId: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 8192,
    contextLength: 200000,
  },
  // OpenAI models
  {
    modelId: 'gpt-4.1',
    label: 'GPT-4.1',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 1047576,
  },
  {
    modelId: 'gpt-4.1-mini',
    label: 'GPT-4.1 Mini',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 1047576,
  },
  {
    modelId: 'gpt-4o',
    label: 'GPT-4o',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 128000,
  },
  {
    modelId: 'o3-mini',
    label: 'o3-mini',
    builtIn: true,
    temperature: 1.0,
    topP: 1.0,
    maxTokens: 8192,
    contextLength: 200000,
  },
];

// ============================================================================
// Built-in Vision Profiles
// ============================================================================

export const BUILTIN_VISION_PROFILES: VisionModelProfile[] = [
  {
    modelId: 'gpt-4o',
    label: 'GPT-4o Vision',
    builtIn: true,
    maxTokens: 2048,
    temperature: 0.3,
    maxImageDimension: 2048,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp', 'gif'],
  },
  {
    modelId: 'claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4 Vision',
    builtIn: true,
    maxTokens: 2048,
    temperature: 0.3,
    maxImageDimension: 1568,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp', 'gif'],
    outputFormat: 'png',
  },
  {
    modelId: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5 Vision',
    builtIn: true,
    maxTokens: 1024,
    temperature: 0.3,
    maxImageDimension: 1568,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp', 'gif'],
    outputFormat: 'png',
  },
  {
    modelId: 'qwen/qwen3.5-397b-a17b',
    label: 'Qwen 3.5 397B Vision',
    builtIn: true,
    maxTokens: 2048,
    temperature: 0.3,
    maxImageDimension: 1280,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp'],
  },
  {
    modelId: 'qwen/qwen3-vl-30b',
    label: 'Qwen 3 VL 30B',
    builtIn: true,
    maxTokens: 2048,
    temperature: 0.3,
    maxImageDimension: 1280,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp'],
  },
];

// ============================================================================
// Lookup Helpers
// ============================================================================

/**
 * Find an LLM profile for a given modelId.
 * User profiles override built-in profiles (merged field-by-field).
 */
export function findLLMProfile(
  modelId: string,
  userProfiles?: LLMModelProfile[]
): LLMModelProfile | null {
  const builtIn = BUILTIN_LLM_PROFILES.find(p => p.modelId === modelId);
  const user = userProfiles?.find(p => p.modelId === modelId);

  if (!builtIn && !user) return null;

  if (builtIn && user) {
    // User overrides merge on top of built-in
    return { ...builtIn, ...stripUndefined(user), builtIn: true };
  }

  return user || builtIn || null;
}

/**
 * Find a vision profile for a given modelId.
 * Matches by exact modelId or by substring (e.g. "llava" matches "llava-v1.6").
 */
export function findVisionProfile(
  modelId: string,
  userProfiles?: VisionModelProfile[]
): VisionModelProfile | null {
  // Exact match first, then substring match for flexibility
  const findMatch = (profiles: VisionModelProfile[]) =>
    profiles.find(p => p.modelId === modelId) ||
    profiles.find(p => modelId.includes(p.modelId) || p.modelId.includes(modelId));

  const builtIn = findMatch(BUILTIN_VISION_PROFILES) || null;
  const user = userProfiles ? findMatch(userProfiles) || null : null;

  if (!builtIn && !user) return null;

  if (builtIn && user) {
    return { ...builtIn, ...stripUndefined(user), builtIn: true };
  }

  return user || builtIn || null;
}

/**
 * Get the merged list of all profiles (built-in + user) for UI display.
 * User profiles override built-in ones with the same modelId.
 */
export function getEffectiveLLMProfiles(userProfiles?: LLMModelProfile[]): LLMModelProfile[] {
  const result = new Map<string, LLMModelProfile>();

  // Start with built-ins
  for (const p of BUILTIN_LLM_PROFILES) {
    result.set(p.modelId, { ...p });
  }

  // Layer user profiles on top
  if (userProfiles) {
    for (const p of userProfiles) {
      const existing = result.get(p.modelId);
      if (existing) {
        result.set(p.modelId, { ...existing, ...stripUndefined(p), builtIn: true });
      } else {
        result.set(p.modelId, { ...p, builtIn: false });
      }
    }
  }

  return Array.from(result.values());
}

/**
 * Get the merged list of all vision profiles for UI display.
 */
export function getEffectiveVisionProfiles(userProfiles?: VisionModelProfile[]): VisionModelProfile[] {
  const result = new Map<string, VisionModelProfile>();

  for (const p of BUILTIN_VISION_PROFILES) {
    result.set(p.modelId, { ...p });
  }

  if (userProfiles) {
    for (const p of userProfiles) {
      const existing = result.get(p.modelId);
      if (existing) {
        result.set(p.modelId, { ...existing, ...stripUndefined(p), builtIn: true });
      } else {
        result.set(p.modelId, { ...p, builtIn: false });
      }
    }
  }

  return Array.from(result.values());
}

/**
 * Get the built-in defaults for a profile (for reset).
 */
export function getBuiltInLLMProfile(modelId: string): LLMModelProfile | null {
  return BUILTIN_LLM_PROFILES.find(p => p.modelId === modelId) || null;
}

export function getBuiltInVisionProfile(modelId: string): VisionModelProfile | null {
  return BUILTIN_VISION_PROFILES.find(p => p.modelId === modelId) || null;
}

// ============================================================================
// Utility
// ============================================================================

/** Remove undefined values so they don't override built-in defaults during spread */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
