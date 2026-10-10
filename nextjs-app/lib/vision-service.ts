/**
 * Vision Service (Optic)
 * Standalone vision-capable LLM integration for image analysis.
 * Uses OpenAI-compatible /v1/chat/completions with vision message format.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

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
  maxImageDimension?: number;      // default: 768
  maxImageSizeBytes?: number;      // default: 10MB
}

const DEFAULT_MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_IMAGE_DIMENSION = 768; // Max width/height for vision model input

/**
 * Resize an image buffer to fit within maxDimension, preserving aspect ratio.
 * Converts to PNG for consistent encoding.
 * Returns { buffer, mime } — the resized image buffer and MIME type.
 */
// The largest original accepted before shrinking (a phone photo over Signal can be 20+ MB); the
// vision limit (maxImageSizeBytes) applies to the shrunk image, not the original.
const MAX_ORIGINAL_BYTES = 100 * 1024 * 1024;

async function resizeForVision(input: Buffer, maxDimension: number): Promise<{ buffer: Buffer; mime: string }> {
  const image = sharp(input, { limitInputPixels: false }).rotate(); // upright, per the photo's EXIF
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (width <= maxDimension && height <= maxDimension) {
    // Already small enough — just ensure it's PNG for consistency
    const buf = await image.png().toBuffer();
    return { buffer: buf, mime: 'image/png' };
  }

  // Resize to fit within maxDimension x maxDimension. A big photo goes to JPEG (a PNG of it can still
  // be several MB); a big screenshot or drawing stays PNG.
  const photo = metadata.format === 'jpeg' || metadata.format === 'heif' || metadata.format === 'webp';
  const fitted = image.resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true });
  const resized = photo ? await fitted.jpeg({ quality: 90 }).toBuffer() : await fitted.png().toBuffer();
  return { buffer: resized, mime: photo ? 'image/jpeg' : 'image/png' };
}

export class VisionService {
  private endpoint: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private apiKey?: string;
  private maxImageDimension: number;
  private maxImageSizeBytes: number;

  /** A huge original is refused before it is decoded; anything under that is shrunk first. */
  private checkOriginal(bytes: number): void {
    if (bytes > MAX_ORIGINAL_BYTES) {
      throw new Error(`Image too large (${(bytes / 1024 / 1024).toFixed(1)}MB). Maximum: ${MAX_ORIGINAL_BYTES / 1024 / 1024}MB`);
    }
  }

  /** The vision limit applies to the shrunk image. */
  private checkShrunk(resized: { buffer: Buffer; mime: string }): { buffer: Buffer; mime: string } {
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
    this.maxImageDimension = config.maxImageDimension || DEFAULT_MAX_IMAGE_DIMENSION;
    this.maxImageSizeBytes = config.maxImageSizeBytes || DEFAULT_MAX_IMAGE_SIZE_BYTES;
  }

  /**
   * Analyze an image with a vision-capable LLM.
   * Accepts one of: workspace path, URL, or raw base64.
   */
  async analyzeImage(request: VisionRequest, workspaceRoot?: string): Promise<VisionResponse> {
    const { prompt, imagePath, imageUrl, imageBase64, mimeType } = request;

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
      const resized = this.checkShrunk(await resizeForVision(rawBuffer, this.maxImageDimension));
      base64Data = resized.buffer.toString('base64');
      resolvedMime = resized.mime;
    } else if (imageUrl) {
      // Fetch from URL
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image from URL: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      this.checkOriginal(arrayBuffer.byteLength);
      const resized = this.checkShrunk(await resizeForVision(Buffer.from(arrayBuffer), this.maxImageDimension));
      base64Data = resized.buffer.toString('base64');
      resolvedMime = resized.mime;
    } else if (imageBase64) {
      // Use raw base64
      this.checkOriginal(Math.ceil(imageBase64.length * 0.75));
      const rawBuffer = Buffer.from(imageBase64, 'base64');
      const resized = this.checkShrunk(await resizeForVision(rawBuffer, this.maxImageDimension));
      base64Data = resized.buffer.toString('base64');
      resolvedMime = resized.mime;
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
