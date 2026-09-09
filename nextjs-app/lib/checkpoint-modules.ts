/**
 * Checkpoint architecture detection and the VAE / text-encoder modules each one
 * needs loaded alongside it (Forge's `forge_additional_modules`).
 *
 * Flux.2 (Klein) is deliberately detected BEFORE Flux.1: its filenames contain
 * "flux" but it needs a Flux.2 VAE and a Qwen3 text encoder, not Flux.1's
 * ae + clip_l + t5xxl. Loading the Flux.1 set against a Klein checkpoint fails
 * with "You do not have Qwen3 state dict!".
 */
import type { CheckpointType } from '@/lib/types';

export function detectCheckpointType(checkpointName: string): CheckpointType {
  const lower = checkpointName.toLowerCase();
  // Flux.2 / Klein first — these names also contain "flux".
  if (lower.includes('klein') || /flux[-_. ]?2/.test(lower)) return 'klein';
  if (lower.includes('pony') || lower.includes('pdxl') || lower.includes('cyberrealistic')) return 'pony';
  if (lower.includes('flux')) return 'flux';
  return 'other';
}

/**
 * Ordered candidates per module slot. Each inner array is one slot (a VAE, a
 * text encoder); the first candidate present on the Forge instance wins. Slots
 * resolve independently so a machine with only the fp8 encoder still works.
 */
type ModuleSlots = string[][];

const FLUX1_SLOTS: ModuleSlots = [
  ['ae.safetensors', 'flux_vae.safetensors'],
  ['clip_l.safetensors'],
  ['t5xxl_fp16.safetensors', 't5xxl_fp8_e4m3fn.safetensors'],
];

// Flux.2 Klein: one Flux.2 VAE + one Qwen3 text encoder. 9B wants Qwen3-8B,
// 4B wants Qwen3-4B — picking the wrong size fails to load.
const KLEIN_VAE = ['flux2_vae.safetensors', 'full_encoder_small_decoder.safetensors'];
const KLEIN_TE_8B = ['qwen_3_8b_fp8mixed.safetensors', 'qwen3_8b_bf16.safetensors', 'qwen_3_8b.safetensors'];
const KLEIN_TE_4B = ['qwen_3_4b.safetensors', 'qwen3_4b.safetensors', 'qwen_3_4b_fp8mixed.safetensors'];

function kleinSlots(checkpointName: string): ModuleSlots {
  const lower = checkpointName.toLowerCase();
  // Default to the 8B encoder; only a checkpoint that names 4B gets the small one.
  const is4b = /(^|[^0-9])4b/.test(lower);
  return [KLEIN_VAE, is4b ? [...KLEIN_TE_4B, ...KLEIN_TE_8B] : [...KLEIN_TE_8B, ...KLEIN_TE_4B]];
}

function slotsFor(type: CheckpointType, checkpointName: string): ModuleSlots {
  switch (type) {
    case 'klein':
      return kleinSlots(checkpointName);
    case 'flux':
      return FLUX1_SLOTS;
    // Pony/SDXL and unknown checkpoints carry their own VAE and encoders. An
    // empty list also clears modules left over from a previous checkpoint.
    default:
      return [];
  }
}

/**
 * Resolve the modules to load for a checkpoint.
 *
 * `available` is the model_name list from Forge's /sdapi/v1/sd-modules. When it
 * is empty (endpoint unreachable, older Forge) the first candidate of each slot
 * is used, which reproduces the previous hardcoded behaviour.
 */
export function resolveCheckpointModules(
  type: CheckpointType,
  checkpointName: string,
  available: string[] = []
): string[] {
  const slots = slotsFor(type, checkpointName);
  if (slots.length === 0) return [];

  const haveExact = new Set(available);
  const resolved: string[] = [];

  for (const candidates of slots) {
    const hit = available.length > 0
      ? candidates.find((c) => haveExact.has(c))
      : candidates[0];
    if (hit) resolved.push(hit);
  }

  return resolved;
}
