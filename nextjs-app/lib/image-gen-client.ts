import type { ImageGenSettings, ImageGenerationSettings, LoraConfig } from './types';
import { ensureEndpoint } from './utils';

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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Image generation failed: ${response.status} - ${error}`);
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

  /**
   * Set checkpoint with type-aware module loading.
   * For Flux: loads required VAE and text encoders
   * For Pony: clears Flux modules (Pony has built-in VAE/encoders)
   */
  async setCheckpointWithModules(
    checkpoint: string,
    checkpointType: 'pony' | 'flux' | 'other',
    modules?: string[]
  ): Promise<void> {
    const url = ensureEndpoint(this.endpoint, '/sdapi/v1/options');

    let additionalModules: string[] = [];
    if (checkpointType === 'flux') {
      additionalModules = modules || [
        'ae.safetensors',
        'clip_l.safetensors',
        't5xxl_fp16.safetensors',
      ];
    }
    // For pony/other: empty array clears any stale Flux modules

    console.log(`Setting checkpoint: ${checkpoint} (type: ${checkpointType}, modules: ${additionalModules.length})`);

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
