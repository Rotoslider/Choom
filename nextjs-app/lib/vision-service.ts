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
}

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_IMAGE_DIMENSION = 768; // Max width/height for vision model input

/**
 * Resize an image buffer to fit within MAX_IMAGE_DIMENSION, preserving aspect ratio.
 * Converts to PNG for consistent encoding.
 * Returns { buffer, mime } — the resized image buffer and MIME type.
 */
async function resizeForVision(input: Buffer): Promise<{ buffer: Buffer; mime: string }> {
  const image = sharp(input);
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
    // Already small enough — just ensure it's PNG for consistency
    const buf = await image.png().toBuffer();
    return { buffer: buf, mime: 'image/png' };
  }

  // Resize to fit within MAX_IMAGE_DIMENSION x MAX_IMAGE_DIMENSION
  const resized = await image
    .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return { buffer: resized, mime: 'image/png' };
}

export class VisionService {
  private endpoint: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: VisionServiceConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
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
      // Read from workspace
      const cleaned = imagePath.replace(/^[/\\]+/, '');
      const fullPath = path.resolve(workspaceRoot, cleaned);
      if (!fullPath.startsWith(path.resolve(workspaceRoot))) {
        throw new Error('Path traversal blocked: image path resolves outside workspace');
      }
      const rawBuffer = await readFile(fullPath);
      if (rawBuffer.length > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(`Image too large (${(rawBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum: 10MB`);
      }
      const resized = await resizeForVision(rawBuffer);
      base64Data = resized.buffer.toString('base64');
      resolvedMime = resized.mime;
    } else if (imageUrl) {
      // Fetch from URL
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image from URL: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(`Image too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum: 10MB`);
      }
      const resized = await resizeForVision(Buffer.from(arrayBuffer));
      base64Data = resized.buffer.toString('base64');
      resolvedMime = resized.mime;
    } else if (imageBase64) {
      // Use raw base64
      const sizeEstimate = Math.ceil(imageBase64.length * 0.75);
      if (sizeEstimate > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(`Image too large (~${(sizeEstimate / 1024 / 1024).toFixed(1)}MB). Maximum: 10MB`);
      }
      const rawBuffer = Buffer.from(imageBase64, 'base64');
      const resized = await resizeForVision(rawBuffer);
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
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${resolvedMime};base64,${base64Data}`,
            },
          },
        ],
      },
    ];

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
