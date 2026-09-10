import type { CheckpointType, ImageGenSettings, ImageGenerationSettings, LoraConfig } from './types';
import { ensureEndpoint } from './utils';
import { resolveCheckpointModules } from './checkpoint-modules';

// Forge's built-in always-on script that turns images into reference latents for
// edit-capable models (Flux.2 Klein, Flux.1 Kontext, Qwen-Image-Edit, ...).
// Despite the name it does not stitch anything. Matched case-insensitively by
// Forge, and its args are positional: [enabled, references, maxSideLength].
const IMAGE_STITCH_SCRIPT = 'ImageStitch Integrated';
const DEFAULT_REFERENCE_MAX_DIM = 1024;

export interface ForgeGenerationRequest {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg_scale?: number;
  distilled_cfg_scale?: number; // For Flux models
  sampler_name?: string;
  scheduler?: string;
  seed?: number;
  batch_size?: number;
  n_iter?: number;
  alwayson_scripts?: Record<string, { args: unknown[] }>;
  // Hires-fix (see hiresFix below)
  enable_hr?: boolean;
  hr_scale?: number;
  hr_upscaler?: string;
  hr_second_pass_steps?: number;
  denoising_strength?: number;
  hr_additional_modules?: string[];
  hr_checkpoint_name?: string;
}

export interface ForgeGenerationResponse {
  images: string[]; // Base64 encoded images
  parameters: Record<string, unknown>;
  info: string;
}

export class ImageGenClient {
  private endpoint: string;
  private defaults: ImageGenSettings;

  constructor(settings: ImageGenSettings) {
    this.endpoint = settings.endpoint;
    this.defaults = settings;
  }

  async generate(settings: ImageGenerationSettings): Promise<{
    imageUrl: string;
    seed: number;
    settings: ImageGenerationSettings;
  }> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/txt2img');

    const request: ForgeGenerationRequest = {
      prompt: settings.prompt,
      negative_prompt: settings.negativePrompt || 'ugly, blurry, low quality, deformed',
      width: settings.width || this.defaults.defaultWidth,
      height: settings.height || this.defaults.defaultHeight,
      steps: settings.steps || this.defaults.defaultSteps,
      cfg_scale: settings.cfgScale || this.defaults.defaultCfgScale,
      distilled_cfg_scale: settings.distilledCfg || this.defaults.defaultDistilledCfg,
      sampler_name: settings.sampler || this.defaults.defaultSampler,
      scheduler: settings.scheduler || this.defaults.defaultScheduler,
      seed: settings.seed ?? -1, // -1 for random
      batch_size: 1,
      n_iter: 1,
    };

    // Hires-fix is a second denoising pass on an enlarged first pass. The
    // enlargement is done in LATENT space, not pixels: every pixel-space
    // upscaler (Lanczos, ESRGAN) at any denoise from 0.20 to 0.45, any step
    // count and either scheduler gave Klein a crunchy, over-sharpened, burnt
    // look on every surface — it re-interprets the resampled pixels as texture.
    // Latent upscale at 0.45-0.50 came out photographic with better freckle
    // detail than any of them. Below 0.40 latent ghosts (doubled mouths); above
    // 0.55 faces drift from the references.
    // The two "Use same ..." fields are not optional: without hr_additional_modules
    // Forge fails with "'NoneType' object is not iterable", and hr_sampler_name /
    // hr_scheduler must be left OUT — passing "Use same sampler" is rejected with
    // "bad sampler name" through the API even though the UI accepts it. The
    // references stay attached for the second pass, which is the whole point.
    if (settings.hiresFix) {
      request.enable_hr = true;
      request.hr_scale = settings.hiresFix.scale;
      request.hr_upscaler = 'Latent';
      request.hr_second_pass_steps = settings.hiresFix.steps;
      request.denoising_strength = settings.hiresFix.denoise;
      request.hr_additional_modules = ['Use same choices'];
      request.hr_checkpoint_name = 'Use same checkpoint';
    }

    // Reference images ride along as an always-on script rather than as top-level
    // fields. Forge decodes each entry with its normal base64 image decoder.
    if (settings.referenceImages && settings.referenceImages.length > 0) {
      request.alwayson_scripts = {
        [IMAGE_STITCH_SCRIPT]: {
          args: [
            true,
            settings.referenceImages,
            settings.referenceMaxDim ?? DEFAULT_REFERENCE_MAX_DIM,
          ],
        },
      };
    }

    const post = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

    let response = await post();

    // VRAM fragments as Forge runs, and reference latents are what tips it over.
    // Measured on a 20GB card with Klein resident: free VRAM fell to 1.27 GB
    // after a run of generations, and unloading the checkpoint took it back to
    // 14.36 GB — the identical request then succeeded. So an OOM here is often
    // fragmentation rather than a request that genuinely cannot fit. Reclaim
    // once and retry before giving up; Forge reloads the checkpoint itself.
    if (!response.ok) {
      const firstError = await response.text();
      if (/outofmemory|out of memory/i.test(firstError)) {
        console.warn('   🧹 Forge out of memory — unloading checkpoint to defragment VRAM, then retrying once');
        try {
          await fetch(`${this.endpoint}/sdapi/v1/unload-checkpoint`, { method: 'POST' });
          await new Promise((r) => setTimeout(r, 2000));
        } catch (e) {
          console.warn('   ⚠️ unload-checkpoint failed:', e instanceof Error ? e.message : e);
        }
        response = await post();
        if (!response.ok) {
          const retryError = await response.text();
          throw new Error(
            `Image generation failed after VRAM reclaim: ${response.status} - ${retryError}. ` +
            'Too many reference images for this GPU — try fewer subjects.'
          );
        }
      } else {
        throw new Error(`Image generation failed: ${response.status} - ${firstError}`);
      }
    }

    const data: ForgeGenerationResponse = await response.json();

    if (!data.images || data.images.length === 0) {
      throw new Error('No images generated');
    }

    // Parse info to get actual seed used
    let actualSeed = settings.seed ?? -1;
    try {
      const info = JSON.parse(data.info);
      actualSeed = info.seed ?? actualSeed;
    } catch {
      // Ignore parse errors
    }

    // Create data URL from base64
    const imageUrl = `data:image/png;base64,${data.images[0]}`;

    return {
      imageUrl,
      seed: actualSeed,
      settings: {
        ...settings,
        seed: actualSeed,
      },
    };
  }

  async getCheckpoints(): Promise<string[]> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/sd-models');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to get checkpoints: ${response.status}`);
    }

    const data = await response.json();
    return data.map((m: { title: string }) => m.title);
  }

  async getSamplers(): Promise<string[]> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/samplers');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to get samplers: ${response.status}`);
    }

    const data = await response.json();
    return data.map((s: { name: string }) => s.name);
  }

  async getLoras(): Promise<Array<{ name: string; alias: string }>> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/loras');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to get LoRAs: ${response.status}`);
    }

    return response.json();
  }

  async setCheckpoint(checkpoint: string): Promise<void> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/options');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sd_model_checkpoint: checkpoint,
        forge_additional_modules: [],  // Clear to prevent cross-model conflicts
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to set checkpoint: ${response.status}`);
    }
  }

  /** List the VAE / text-encoder files Forge can load as additional modules. */
  async getModules(): Promise<string[]> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/sd-modules');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to get modules: ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data
      .map((m: { model_name?: string; filename?: string }) => m.model_name || '')
      .filter((n: string) => n.length > 0);
  }

  /**
   * Set checkpoint with type-aware module loading.
   * - Flux.1: ae + clip_l + t5xxl
   * - Flux.2 / Klein: Flux.2 VAE + Qwen3 text encoder (NOT the Flux.1 set)
   * - Pony/other: empty, which also clears modules left by a previous checkpoint
   *
   * An explicit `modules` list always wins — that's what the per-Choom module
   * picker passes. Otherwise defaults are resolved against what this Forge
   * instance actually has on disk, so the same settings work after Forge moves
   * to another machine.
   */
  async setCheckpointWithModules(
    checkpoint: string,
    checkpointType: CheckpointType,
    modules?: string[]
  ): Promise<void> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/options');

    let additionalModules: string[];
    if (modules && modules.length > 0) {
      additionalModules = modules;
    } else {
      const available = await this.getModules().catch(() => [] as string[]);
      additionalModules = resolveCheckpointModules(checkpointType, checkpoint, available);
    }

    console.log(`Setting checkpoint: ${checkpoint} (type: ${checkpointType}, modules: ${additionalModules.join(', ') || 'none'})`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sd_model_checkpoint: checkpoint,
        forge_additional_modules: additionalModules,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to set checkpoint: ${response.status}`);
    }
  }

  async getOptions(): Promise<Record<string, unknown>> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/options');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to get options: ${response.status}`);
    }

    return response.json();
  }

  async upscaleImage(imageBase64: string, upscaler: string = 'Lanczos', scale: number = 2): Promise<string> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/extra-single-image');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: imageBase64,
        upscaler_1: upscaler,
        upscaling_resize: scale,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Image upscale failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    if (!data.image) {
      throw new Error('No upscaled image returned');
    }

    return `data:image/png;base64,${data.image}`;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = ensureEndpoint(this.endpoint, '/sdapi/v1/options');
      const response = await fetch(url, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Legacy size presets (kept for backward compatibility)
export const sizePresets = {
  small: { width: 512, height: 512 },
  medium: { width: 768, height: 768 },
  large: { width: 1024, height: 1024 },
  portrait: { width: 512, height: 768 },
  landscape: { width: 768, height: 512 },
  widescreen: { width: 896, height: 512 },
  tallscreen: { width: 512, height: 896 },
};

// Helper to build prompt with LoRAs
export function buildPromptWithLoras(
  basePrompt: string,
  loras: LoraConfig[]
): string {
  if (loras.length === 0) return basePrompt;

  const loraStrings = loras.map((l) => `<lora:${l.name}:${l.weight}>`);
  return `${basePrompt}, ${loraStrings.join(', ')}`;
}
