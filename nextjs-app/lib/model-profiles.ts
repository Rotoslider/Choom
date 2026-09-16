/**
 * Model Profiles — per-model parameter defaults.
 * Auto-applied when a Choom or project uses a different model from the global setting.
 */

import type { LLMModelProfile, VisionModelProfile } from './types';

// ============================================================================
// Built-in LLM Profiles
// ============================================================================

export const BUILTIN_LLM_PROFILES: LLMModelProfile[] = [
  {
    modelId: 'deepseek-ai/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    builtIn: true,
    temperature: 0.6,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 1048576,
  },
  {
    modelId: 'deepseek-ai/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    builtIn: true,
    temperature: 0.6,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 1048576,
    // Measured 2026-09-12 on real turns: skills exposure cut peak prompt
    // tokens ~40% (27.8k → 16.7k grounding, 25.7k → 13.7k a YouTube ask) with
    // the same tool paths and no nudges. Cloud tokens are money.
    toolExposure: 'skills',
  },
  {
    modelId: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 262144,
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
    modelId: 'z-ai/glm-5.1',
    label: 'GLM-5.1',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 204800,
    topK: 20,
  },
  {
    // Qwen 3.6 35B-A3B — official non-thinking ("instruct") sampling per the
    // model card: temp=0.7, top_p=0.80, top_k=20, presence_penalty=1.5.
    // The model's GGUF in LM Studio routes ALL output (including <tool_call>
    // XML) through delta.reasoning_content; route.ts salvages that channel
    // when enableThinking=false. Tool calls use Anthropic-style tags:
    // <function=NAME><parameter=KEY>VAL</parameter></function>
    // (parsed via the qwen3_coder format branch in parseXmlToolCalls).
    modelId: 'qwen/qwen3.6-35b-a3b',
    label: 'Qwen 3.6 35B-A3B (Local)',
    builtIn: true,
    temperature: 0.7,
    topP: 0.80,
    maxTokens: 4096,
    contextLength: 262144,
    topK: 20,
    presencePenalty: 1.5,
    enableThinking: false,
    replyInReasoning: true,
    toolExposure: 'skills',
  },
  {
    // Qwen 3.8 27B in LM Studio (2026-09-12). Sampling follows the 3.6
    // instruct values until the model card says otherwise; thinking arrives on
    // reasoning_content and its reply on content, so no replyInReasoning.
    modelId: 'qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B (Local)',
    builtIn: true,
    temperature: 0.7,
    topP: 0.80,
    maxTokens: 8192,
    contextLength: 262144,
    topK: 20,
    presencePenalty: 1.5,
    enableThinking: false,
    toolExposure: 'skills',
  },
  {
    modelId: 'minimaxai/minimax-m2.7',
    label: 'MiniMax M2.7',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 204800,
  },
  {
    modelId: 'stepfun-ai/step-3.5-flash',
    label: 'Step 3.5 Flash',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 4096,
    contextLength: 262144,
  },
  // Google Gemma 4 models (multimodal — vision profiles also below)
  {
    modelId: 'gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B-A4B IT (MoE 4B active)',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    // Gemma 4 thinks on reasoning_content even with thinking off, and those
    // tokens count against max_tokens: at 4096 a 31B deliberating over a
    // grounding prompt ran out of room before acting (2026-09-12, see
    // fallback-continuation.test.ts). 262,144 is the native window (live
    // audit 2026-08-05); a RAM-capped local load reports its smaller window
    // through LM Studio's loaded_context_length, which outranks this.
    maxTokens: 8192,
    contextLength: 262144,
    topK: 40,
    repetitionPenalty: 1.0,
    enableThinking: false,
    toolExposure: 'skills',
  },
  {
    modelId: 'gemma-4-31b-it',
    label: 'Gemma 4 31B IT',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    // Gemma 4 thinks on reasoning_content even with thinking off, and those
    // tokens count against max_tokens: at 4096 a 31B deliberating over a
    // grounding prompt ran out of room before acting (2026-09-12, see
    // fallback-continuation.test.ts). 262,144 is the native window (live
    // audit 2026-08-05); a RAM-capped local load reports its smaller window
    // through LM Studio's loaded_context_length, which outranks this.
    maxTokens: 8192,
    contextLength: 262144,
    topK: 40,
    repetitionPenalty: 1.0,
    enableThinking: false,
    toolExposure: 'skills',
  },
  // Google Gemma 4 E4B (local MLX 8-bit; the vision and simple-task model on the Mac)
  {
    modelId: 'google/gemma-4-e4b',
    label: 'Gemma 4 E4B (Local)',
    builtIn: true,
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 4096,
    contextLength: 131072,
    toolExposure: 'skills',
  },
  // Anthropic — Claude 5 family (2026)
  {
    modelId: 'claude-opus-5',
    label: 'Claude Opus 5',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 8192,
    contextLength: 1000000,
  },
  {
    modelId: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 8192,
    contextLength: 1000000,
  },
  {
    modelId: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 8192,
    contextLength: 1000000,
  },
  // OpenAI — GPT-5 family
  {
    modelId: 'gpt-5',
    label: 'GPT-5',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 8192,
    contextLength: 400000,
  },
  {
    modelId: 'gpt-5-mini',
    label: 'GPT-5 Mini',
    builtIn: true,
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 8192,
    contextLength: 400000,
  },
];

// ============================================================================
// Built-in Vision Profiles
// ============================================================================

export const BUILTIN_VISION_PROFILES: VisionModelProfile[] = [
  {
    modelId: 'qwen/qwen3.6-35b-a3b',
    label: 'Qwen 3.6 35B-A3B Vision (Local, MoE 3B active)',
    builtIn: true,
    maxTokens: 4096,
    temperature: 0.7,
    maxImageDimension: 1536,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp', 'gif'],
  },
  // Google Gemma 4 (multimodal — native vision support)
  {
    modelId: 'gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B-A4B Vision',
    builtIn: true,
    maxTokens: 2048,
    temperature: 0.3,
    maxImageDimension: 1536,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp'],
  },
  {
    modelId: 'gemma-4-31b-it',
    label: 'Gemma 4 31B Vision',
    builtIn: true,
    // Its thinking used a 600-token budget and returned nothing (2026-09-16).
    maxTokens: 4096,
    temperature: 0.3,
    maxImageDimension: 1536,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp'],
  },
  {
    modelId: 'qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B Vision (Local)',
    builtIn: true,
    maxTokens: 4096,
    temperature: 0.5,
    maxImageDimension: 1536,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp', 'gif'],
  },
  // The Mac's everyday vision model: small, fast, and it does not tie up the
  // 31B while a Choom is using it (2026-09-16).
  {
    modelId: 'google/gemma-4-e4b',
    label: 'Gemma 4 E4B Vision (Local)',
    builtIn: true,
    maxTokens: 4096,
    temperature: 0.5,
    maxImageDimension: 1536,
    maxImageSizeBytes: 20 * 1024 * 1024,
    supportedFormats: ['png', 'jpeg', 'webp'],
  },
];

// ============================================================================
// Lookup Helpers
// ============================================================================

/**
 * Normalize a model id for fallback matching: drop the org prefix and any
 * trailing tune/quantization markers so serving-stack variants of the same
 * weights land on one profile. The concrete failure this fixes (C-53): the
 * client resolves "google/gemma-4-31b-qat" while the profile is keyed
 * "gemma-4-31b-it" — exact match misses, so the model fell through to the
 * store defaults instead of the gemma profile's sampling and window (the
 * "128k" once noted here was a gemma-3-era guess; 262,144 is native).
 */
export function normalizeModelId(modelId: string): string {
  let s = (modelId.split('/').pop() || modelId).toLowerCase();
  // Strip trailing variant markers, repeatedly ("…-it-qat" → base name).
  // Date/build stamps too: OpenRouter serves "deepseek/deepseek-v4-flash-0731"
  // while the profile is keyed "deepseek-ai/deepseek-v4-flash" — without this
  // no profile matched Genesis's actual model at all (2026-09-12), so the
  // DeepSeek profile's settings never applied.
  const VARIANT_SUFFIX =
    /-(?:it|instruct|qat|gguf|awq|gptq|mlx|4bit|8bit|fp8|fp16|bf16|int[48]|q\d(?:_[a-z0-9]+)?|\d{4}|\d{6}|\d{8})$/;
  while (VARIANT_SUFFIX.test(s)) s = s.replace(VARIANT_SUFFIX, '');
  return s;
}

/**
 * Find an LLM profile for a given modelId.
 * User profiles override built-in profiles (merged field-by-field).
 * Exact modelId match wins; if nothing matches exactly, retry with normalized
 * ids (org prefix and tune/quant suffixes stripped on both sides).
 */
export function findLLMProfile(
  modelId: string,
  userProfiles?: LLMModelProfile[]
): LLMModelProfile | null {
  let builtIn = BUILTIN_LLM_PROFILES.find(p => p.modelId === modelId);
  let user = userProfiles?.find(p => p.modelId === modelId);

  if (!builtIn && !user) {
    const norm = normalizeModelId(modelId);
    builtIn = BUILTIN_LLM_PROFILES.find(p => normalizeModelId(p.modelId) === norm);
    user = userProfiles?.find(p => normalizeModelId(p.modelId) === norm);
  }

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
