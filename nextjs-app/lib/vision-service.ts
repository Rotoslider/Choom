/**
 * Vision Service (Optic)
 * Standalone vision-capable LLM integration for image analysis.
 * Uses OpenAI-compatible /v1/chat/completions with vision message format.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { visionInputSize } from '@/lib/vision-input-size';
import { parseRegion, REGION_EXAMPLES, type Region } from '@/lib/vision-region';

export interface VisionRequest {
  prompt: string;
  /** Workspace-relative path to an image file */
  imagePath?: string;
  /** URL to fetch and base64-encode */
  imageUrl?: string;
  /** Raw base64-encoded image data */
  imageBase64?: string;
  /** MIME type (default: image/png) */
  mimeType?: string;
  /** Look closer at part of the image: "lower left", "top half", "lower left > top right", "x,y,w,h". */
  region?: string;
}

export interface VisionResponse {
  analysis: string;
  model: string;
}

export interface VisionServiceConfig {
  endpoint: string;
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey?: string;
  /** A custom longest side (Settings > Optic > profile, "custom image size"); otherwise the model's own size. */
  maxImageDimension?: number;
  maxImageSizeBytes?: number;      // default: 10MB
}

const DEFAULT_MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const FALLBACK_MAX_IMAGE_DIMENSION = 1024; // when the model's own size can't be read (a remote model)

/**
 * Resize an image buffer to fit within maxDimension, preserving aspect ratio.
 * Converts to PNG for consistent encoding.
 * Returns { buffer, mime } — the resized image buffer and MIME type.
 */
// The largest original accepted before shrinking (a phone photo over Signal can be 20+ MB); the
// vision limit (maxImageSizeBytes) applies to the shrunk image, not the original.
const MAX_ORIGINAL_BYTES = 100 * 1024 * 1024;

/**
 * The image as the vision model should get it: upright (EXIF), cropped to a region if one was named
 * (from the full-resolution original, so a close look keeps its detail), and scaled to the model's
 * pixel budget (or a custom longest side). A cropped region is enlarged up to the budget (at most 4×)
 * so the model spends its full attention on it; a whole image is never enlarged. Photos go as JPEG,
 * screenshots and drawings as PNG.
 */
async function prepareForVision(
  input: Buffer,
  fit: { maxPixels?: number; maxDimension?: number; region?: Region | null },
): Promise<{ buffer: Buffer; mime: string; width: number; height: number }> {
  const upright = await sharp(input, { limitInputPixels: false }).rotate().toBuffer({ resolveWithObject: true });
  const format = (await sharp(input, { limitInputPixels: false }).metadata()).format;
  let img = sharp(upright.data, { limitInputPixels: false });
  let w = upright.info.width, h = upright.info.height;
  if (fit.region) {
    const left = Math.min(w - 1, Math.max(0, Math.round(fit.region.x * w)));
    const top = Math.min(h - 1, Math.max(0, Math.round(fit.region.y * h)));
    const cw = Math.max(1, Math.min(w - left, Math.round(fit.region.w * w)));
    const ch = Math.max(1, Math.min(h - top, Math.round(fit.region.h * h)));
    img = img.extract({ left, top, width: cw, height: ch });
    w = cw; h = ch;
  }
  const limits: number[] = [];
  if (fit.maxPixels) limits.push(Math.sqrt(fit.maxPixels / (w * h)));
  if (fit.maxDimension) limits.push(fit.maxDimension / Math.max(w, h));
  let scale = limits.length ? Math.min(...limits) : 1;
  scale = fit.region ? Math.min(scale, 4) : Math.min(scale, 1);
  if (Math.abs(scale - 1) > 0.01) {
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    img = img.resize(w, h, { kernel: 'lanczos3' });
  }
  const photo = format === 'jpeg' || format === 'heif' || format === 'webp';
  const buffer = photo ? await img.jpeg({ quality: 90 }).toBuffer() : await img.png().toBuffer();
  return { buffer, mime: photo ? 'image/jpeg' : 'image/png', width: w, height: h };
}

export class VisionService {
  private endpoint: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private apiKey?: string;
  private customImageDimension?: number;
  private maxImageSizeBytes: number;
  /** What the last analysis sent, for the tool's result and the logs. */
  lastSent?: { width: number; height: number; region?: Region | null; sizing: string };

  /** A huge original is refused before it is decoded; anything under that is shrunk first. */
  private checkOriginal(bytes: number): void {
    if (bytes > MAX_ORIGINAL_BYTES) {
      throw new Error(`Image too large (${(bytes / 1024 / 1024).toFixed(1)}MB). Maximum: ${MAX_ORIGINAL_BYTES / 1024 / 1024}MB`);
    }
  }

  /** The vision limit applies to the shrunk image. */
  private checkShrunk<T extends { buffer: Buffer; mime: string }>(resized: T): T {
    if (resized.buffer.length > this.maxImageSizeBytes) {
      throw new Error(`Image too large even after shrinking (${(resized.buffer.length / 1024 / 1024).toFixed(1)}MB). Maximum: ${Math.round(this.maxImageSizeBytes / 1024 / 1024)}MB`);
    }
    return resized;
  }

  constructor(config: VisionServiceConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
    this.apiKey = config.apiKey;
    this.customImageDimension = config.maxImageDimension || undefined;
    this.maxImageSizeBytes = config.maxImageSizeBytes || DEFAULT_MAX_IMAGE_SIZE_BYTES;
  }

  /**
   * Analyze an image with a vision-capable LLM.
   * Accepts one of: workspace path, URL, or raw base64.
   */
  async analyzeImage(request: VisionRequest, workspaceRoot?: string): Promise<VisionResponse> {
    const { prompt, imagePath, imageUrl, imageBase64, mimeType } = request;
    const region = request.region ? parseRegion(request.region) : null;
    if (request.region && !region) {
      throw new Error(`Could not read the region "${request.region}". Use ${REGION_EXAMPLES}.`);
    }
    // Sized for this model: its own pixel budget (read from its files), unless a custom size is set.
    const auto = this.customImageDimension ? null : await visionInputSize(this.model);
    const fit = this.customImageDimension
      ? { maxDimension: this.customImageDimension, region, sizing: `custom ${this.customImageDimension}px` }
      : auto
        ? { maxPixels: auto.maxPixels, region, sizing: `model ${Math.round(auto.maxPixels / 1000)}k px (${auto.source})` }
        : { maxDimension: FALLBACK_MAX_IMAGE_DIMENSION, region, sizing: `fallback ${FALLBACK_MAX_IMAGE_DIMENSION}px` };

    let base64Data: string;
    let resolvedMime = mimeType || 'image/png';

    if (imagePath && workspaceRoot) {
      // Read from workspace. Accept BOTH workspace-relative paths and absolute
      // paths that already point inside the workspace — tools often hand the
      // model an absolute path, and blindly stripping the leading slash used to
      // produce /workspace/home/user/workspace/... double-joins (ENOENT).
      const root = path.resolve(workspaceRoot);
      const trimmed = imagePath.trim();
      let fullPath = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
      if (!fullPath.startsWith(root + path.sep) && fullPath !== root) {
        // Not inside the workspace as-is — fall back to the legacy behavior of
        // treating it as workspace-relative after stripping leading slashes.
        fullPath = path.resolve(root, trimmed.replace(/^[/\\]+/, ''));
      }
      if (!fullPath.startsWith(root + path.sep)) {
        throw new Error('Path traversal blocked: image path resolves outside workspace');
      }
      const rawBuffer = await readFile(fullPath);
      this.checkOriginal(rawBuffer.length);
      const resized = this.checkShrunk(await prepareForVision(rawBuffer, fit));
      base64Data = resized.buffer.toString('base64');
      resolvedMime = resized.mime;
      this.lastSent = { width: resized.width, height: resized.height, region, sizing: fit.sizing };
    } else if (imageUrl) {
      // Fetch from URL
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image from URL: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      this.checkOriginal(arrayBuffer.byteLength);
      const resized = this.checkShrunk(await prepareForVision(Buffer.from(arrayBuffer), fit));
      base64Data = resized.buffer.toString('base64');
      resolvedMime = resized.mime;
      this.lastSent = { width: resized.width, height: resized.height, region, sizing: fit.sizing };
    } else if (imageBase64) {
      // Use raw base64
      this.checkOriginal(Math.ceil(imageBase64.length * 0.75));
      const rawBuffer = Buffer.from(imageBase64, 'base64');
      const resized = this.checkShrunk(await prepareForVision(rawBuffer, fit));
      base64Data = resized.buffer.toString('base64');
      resolvedMime = resized.mime;
      this.lastSent = { width: resized.width, height: resized.height, region, sizing: fit.sizing };
    } else {
      throw new Error('One of imagePath, imageUrl, or imageBase64 is required');
    }

    // Build OpenAI vision message format
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt || 'Describe this image in detail' },
          {
            type: 'image_url',
            image_url: {
              url: `data:${resolvedMime};base64,${base64Data}`,
            },
          },
        ],
      },
    ];

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vision API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('Vision API returned no choices');
    }

    return {
      analysis: choice.message?.content || '',
      model: data.model || this.model,
    };
  }
}

function mimeFromExt(ext: string): string | null {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return map[ext.toLowerCase()] || null;
}
