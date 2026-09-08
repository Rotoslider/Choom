/**
 * Per-Choom reference images for image generation.
 *
 * These are user-supplied stills (character sheets, face crops, style refs) that
 * get handed to Forge's "ImageStitch Integrated" always-on script, which VAE-
 * encodes them into reference latents for edit-capable models — Flux.2 Klein,
 * Flux.1 Kontext, Qwen-Image-Edit and friends. They replace what per-Choom
 * character LoRAs used to do, without the VRAM cost of a LoRA per Choom.
 *
 * Files live under REFERENCE_IMAGES_ROOT/<choomId>/<file>; only the bare
 * filename is persisted in the Choom's imageSettings JSON, so the DB row stays
 * small and the images travel with Choom rather than with the Forge host.
 */
import { mkdir, readFile, writeFile, unlink, readdir } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import {
  REFERENCE_IMAGES_ROOT,
  REFERENCE_IMAGE_STORED_MAX_DIM,
} from '@/lib/config';
import type { ReferenceImage } from '@/lib/types';

/** Filenames we generate — also the whitelist for anything read back off disk. */
const FILE_PATTERN = /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/;

export function choomReferenceDir(choomId: string): string {
  // choomId is a cuid from our own DB, but treat it as untrusted anyway: it
  // arrives via URL params.
  if (!/^[A-Za-z0-9_-]+$/.test(choomId)) {
    throw new Error(`Invalid choom id: ${choomId}`);
  }
  return path.join(REFERENCE_IMAGES_ROOT, choomId);
}

/**
 * Resolve a stored reference filename to an absolute path, refusing anything
 * that isn't a plain filename inside the Choom's own directory.
 */
export function resolveReferencePath(choomId: string, file: string): string {
  if (!FILE_PATTERN.test(file)) {
    throw new Error(`Invalid reference image filename: ${file}`);
  }
  const dir = choomReferenceDir(choomId);
  const full = path.join(dir, file);
  if (path.dirname(full) !== dir) {
    throw new Error(`Reference image escapes its directory: ${file}`);
  }
  return full;
}

/**
 * Store an uploaded image, downscaling to REFERENCE_IMAGE_STORED_MAX_DIM.
 * Always re-encodes to PNG: it strips EXIF, normalises the extension, and keeps
 * the alpha channel for cut-out references.
 */
export async function saveReferenceImage(
  choomId: string,
  buffer: Buffer,
  label?: string
): Promise<ReferenceImage> {
  const dir = choomReferenceDir(choomId);
  await mkdir(dir, { recursive: true });

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const file = `${id}.png`;

  const resized = await sharp(buffer)
    .rotate() // honour EXIF orientation before it is stripped
    .resize({
      width: REFERENCE_IMAGE_STORED_MAX_DIM,
      height: REFERENCE_IMAGE_STORED_MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  await writeFile(path.join(dir, file), resized.data);

  return {
    id,
    file,
    label: label?.slice(0, 80) || undefined,
    enabled: true,
    width: resized.info.width,
    height: resized.info.height,
  };
}

export async function deleteReferenceImage(choomId: string, file: string): Promise<void> {
  const full = resolveReferencePath(choomId, file);
  await unlink(full).catch((err: NodeJS.ErrnoException) => {
    // Already gone is success — the settings entry is the source of truth.
    if (err.code !== 'ENOENT') throw err;
  });
}

export async function readReferenceImage(choomId: string, file: string): Promise<Buffer> {
  return readFile(resolveReferencePath(choomId, file));
}

/** List files actually present on disk, for orphan cleanup / debugging. */
export async function listReferenceFiles(choomId: string): Promise<string[]> {
  try {
    const entries = await readdir(choomReferenceDir(choomId));
    return entries.filter((e) => FILE_PATTERN.test(e));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Resolve a mode's configured references into base64 payloads for Forge.
 * Disabled entries are skipped; missing files are warned about and skipped
 * rather than failing the whole generation — a deleted sheet shouldn't take
 * image generation down with it.
 */
export async function loadReferenceImagesBase64(
  choomId: string,
  references: ReferenceImage[] | undefined
): Promise<string[]> {
  if (!references || references.length === 0) return [];

  const enabled = references.filter((r) => r.enabled !== false && r.file);
  if (enabled.length === 0) return [];

  const loaded = await Promise.all(
    enabled.map(async (ref) => {
      try {
        const buf = await readReferenceImage(choomId, ref.file);
        return buf.toString('base64');
      } catch (err) {
        console.warn(
          `   ⚠️ Reference image unavailable (${ref.label || ref.file}): ${
            err instanceof Error ? err.message : err
          }`
        );
        return null;
      }
    })
  );

  return loaded.filter((b): b is string => b !== null);
}
