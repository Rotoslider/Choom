import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Reference images resolve against REFERENCE_IMAGES_ROOT, which lib/config.ts
// reads from the environment at import time.
const TEST_ROOT = mkdtempSync(path.join(tmpdir(), 'choom-refs-'));
process.env.REFERENCE_IMAGES_ROOT = TEST_ROOT;

import { detectCheckpointType, resolveCheckpointModules } from '../lib/checkpoint-modules';
import {
  saveReferenceImage,
  loadReferenceImagesBase64,
  resolveReferencePath,
  deleteReferenceImage,
} from '../lib/reference-images';
import { ImageGenClient } from '../lib/image-gen-client';
import type { ImageGenSettings } from '../lib/types';

// A real 4x4 PNG, so sharp has something valid to decode.
// 16x16, not 4x4: libvips 8.18.x fails a 4x4 PNG through
// rotate().resize().png() with "vipspng: libpng read error", while the same
// chain succeeds from 16x16 up. That is a fixture artefact, not a bug in
// storeImage — real uploads are never that small.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGElEQVQokWOoiLIhCTGMaogaDaWK4Zo0AMdDDhBBWdBNAAAAAElFTkSuQmCC',
  'base64'
);

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('checkpoint type detection', () => {
  it('classifies Flux.2 Klein checkpoints as klein, not flux', () => {
    // The bug this guards: "flux-2-klein-9b-fp8" contains "flux", so a naive
    // substring check loads Flux.1's ae + clip_l + t5xxl and the model fails
    // with "You do not have Qwen3 state dict!".
    expect(detectCheckpointType('flux-2-klein-9b-fp8.safetensors')).toBe('klein');
    expect(detectCheckpointType('flux-2-klein-9b_quanto_bf16_int8.safetensors')).toBe('klein');
    expect(detectCheckpointType('FLUX.2-klein-4B.safetensors')).toBe('klein');
  });

  it('still classifies Flux.1, Pony and everything else as before', () => {
    expect(detectCheckpointType('flux1-dev-bnb-nf4-v2.safetensors')).toBe('flux');
    expect(detectCheckpointType('flux_dev.safetensors')).toBe('flux');
    expect(detectCheckpointType('ponyDiffusionV6XL.safetensors')).toBe('pony');
    expect(detectCheckpointType('sd_xl_base_1.0.safetensors')).toBe('other');
  });
});

describe('module resolution', () => {
  // The module list this Forge instance actually reports.
  const AVAILABLE = [
    'ae.safetensors',
    'flux2_vae.safetensors',
    'full_encoder_small_decoder.safetensors',
    't5xxl_fp16.safetensors',
    't5xxl_fp8_e4m3fn.safetensors',
    'qwen3_8b_bf16.safetensors',
    'clip_l.safetensors',
    'qwen_3_8b_fp8mixed.safetensors',
  ];

  it('gives Klein a Flux.2 VAE and a Qwen3 encoder', () => {
    const mods = resolveCheckpointModules('klein', 'flux-2-klein-9b-fp8.safetensors', AVAILABLE);
    expect(mods).toEqual(['flux2_vae.safetensors', 'qwen_3_8b_fp8mixed.safetensors']);
    expect(mods).not.toContain('t5xxl_fp16.safetensors');
    expect(mods).not.toContain('clip_l.safetensors');
  });

  it('prefers the 4B encoder for a 4B Klein checkpoint', () => {
    const mods = resolveCheckpointModules('klein', 'flux-2-klein-4b.safetensors', [
      ...AVAILABLE,
      'qwen_3_4b.safetensors',
    ]);
    expect(mods).toEqual(['flux2_vae.safetensors', 'qwen_3_4b.safetensors']);
  });

  it('falls back to another candidate when the preferred file is absent', () => {
    const mods = resolveCheckpointModules('klein', 'flux-2-klein-9b-fp8.safetensors', [
      'full_encoder_small_decoder.safetensors',
      'qwen3_8b_bf16.safetensors',
    ]);
    expect(mods).toEqual(['full_encoder_small_decoder.safetensors', 'qwen3_8b_bf16.safetensors']);
  });

  it('keeps the Flux.1 set for Flux.1 and clears modules for pony/other', () => {
    expect(resolveCheckpointModules('flux', 'flux_dev.safetensors', AVAILABLE)).toEqual([
      'ae.safetensors',
      'clip_l.safetensors',
      't5xxl_fp16.safetensors',
    ]);
    expect(resolveCheckpointModules('pony', 'ponyXL.safetensors', AVAILABLE)).toEqual([]);
    expect(resolveCheckpointModules('other', 'sdxl.safetensors', AVAILABLE)).toEqual([]);
  });

  it('uses first-choice defaults when Forge reports no modules', () => {
    expect(resolveCheckpointModules('klein', 'flux-2-klein-9b-fp8.safetensors', [])).toEqual([
      'flux2_vae.safetensors',
      'qwen_3_8b_fp8mixed.safetensors',
    ]);
  });
});

describe('reference image storage', () => {
  it('stores an upload and loads it back as base64', async () => {
    const ref = await saveReferenceImage('choom123', TINY_PNG, 'Eve character sheet');
    expect(ref.file).toMatch(/^[A-Za-z0-9_-]+\.png$/);
    expect(ref.label).toBe('Eve character sheet');
    expect(ref.enabled).toBe(true);

    const loaded = await loadReferenceImagesBase64('choom123', [ref]);
    expect(loaded).toHaveLength(1);
    expect(Buffer.from(loaded[0], 'base64').subarray(1, 4).toString()).toBe('PNG');
  });

  it('skips disabled references and survives missing files', async () => {
    const ref = await saveReferenceImage('choom123', TINY_PNG);
    expect(await loadReferenceImagesBase64('choom123', [{ ...ref, enabled: false }])).toEqual([]);

    await deleteReferenceImage('choom123', ref.file);
    // A deleted sheet must not take image generation down with it.
    expect(await loadReferenceImagesBase64('choom123', [ref])).toEqual([]);
  });

  it('refuses filenames that would escape the choom directory', () => {
    expect(() => resolveReferencePath('choom123', '../../etc/passwd')).toThrow();
    expect(() => resolveReferencePath('choom123', 'sub/dir.png')).toThrow();
    expect(() => resolveReferencePath('../evil', 'a.png')).toThrow();
  });
});

describe('Forge request payload', () => {
  const settings: ImageGenSettings = {
    endpoint: 'http://forge.test:7860',
    defaultCheckpoint: '',
    defaultSampler: 'Euler',
    defaultScheduler: 'Beta',
    defaultSteps: 4,
    defaultCfgScale: 1,
    defaultDistilledCfg: 0,
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultNegativePrompt: '',
    selfPortrait: {
      enabled: false, checkpoint: '', sampler: 'Euler', scheduler: 'Beta', steps: 4,
      cfgScale: 1, distilledCfg: 0, width: 1024, height: 1024, negativePrompt: '',
      loras: [], promptPrefix: '', promptSuffix: '',
    },
  };

  function mockFetchCapturingBody() {
    const captured: { body?: Record<string, unknown> } = {};
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      captured.body = JSON.parse(init!.body!);
      return {
        ok: true,
        json: async () => ({ images: ['aW1n'], parameters: {}, info: '{"seed":7}' }),
      };
    }) as unknown as typeof fetch;
    return captured;
  }

  it('sends references through the ImageStitch always-on script', async () => {
    const captured = mockFetchCapturingBody();
    const client = new ImageGenClient(settings);

    await client.generate({
      prompt: 'on a neon rooftop',
      referenceImages: ['AAAA', 'BBBB'],
      referenceMaxDim: 1280,
    });

    // Arg order is positional and Forge-defined: [enabled, references, maxSide].
    expect(captured.body!.alwayson_scripts).toEqual({
      'ImageStitch Integrated': { args: [true, ['AAAA', 'BBBB'], 1280] },
    });
  });

  it('omits the script entirely when there are no references', async () => {
    const captured = mockFetchCapturingBody();
    const client = new ImageGenClient(settings);

    await client.generate({ prompt: 'a landscape' });

    expect(captured.body!.alwayson_scripts).toBeUndefined();
  });

  it('sends hires-fix as a second pass with the fields Forge insists on', async () => {
    const captured = mockFetchCapturingBody();
    const client = new ImageGenClient(settings);

    await client.generate({
      prompt: 'x',
      referenceImages: ['AAAA'],
      hiresFix: { scale: 2, denoise: 0.45, steps: 6 },
    });

    const body = captured.body!;
    expect(body.enable_hr).toBe(true);
    expect(body.hr_scale).toBe(2);
    expect(body.denoising_strength).toBe(0.45);
    expect(body.hr_second_pass_steps).toBe(6);
    expect(body.hr_upscaler).toBe('Lanczos');
    // Without these Forge throws "'NoneType' object is not iterable".
    expect(body.hr_additional_modules).toEqual(['Use same choices']);
    expect(body.hr_checkpoint_name).toBe('Use same checkpoint');
    // And with these it throws "bad sampler name" — they must stay absent.
    expect(body).not.toHaveProperty('hr_sampler_name');
    expect(body).not.toHaveProperty('hr_scheduler');
    // References still ride along for the second pass.
    expect(body.alwayson_scripts).toBeDefined();
  });

  it('runs a single pass when hires-fix is off', async () => {
    const captured = mockFetchCapturingBody();
    const client = new ImageGenClient(settings);

    await client.generate({ prompt: 'x' });

    expect(captured.body!.enable_hr).toBeUndefined();
  });

  it('defaults the reference max side to 1024', async () => {
    const captured = mockFetchCapturingBody();
    const client = new ImageGenClient(settings);

    await client.generate({ prompt: 'x', referenceImages: ['AAAA'] });

    const args = (captured.body!.alwayson_scripts as Record<string, { args: unknown[] }>)[
      'ImageStitch Integrated'
    ].args;
    expect(args[2]).toBe(1024);
  });
});
