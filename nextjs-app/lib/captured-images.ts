// Captured images (camera / printer snapshots, ForgeRAG page renders) are
// working material, not a Choom's creations. They still get a GeneratedImage
// row so the chat can show them inline and analyze_image/image_id works, but:
//   - they are hidden from the gallery,
//   - they do not count toward the keep-last-50 gallery cap (security rounds
//     were pushing a Choom's own generated images out of it),
//   - they expire after CAPTURE_RETENTION_HOURS (row + default-folder file).
// Camera snapshot files default to selfies_<slug>/camera/, which the weekly
// selfie backup skips.
import fs from 'fs/promises';
import path from 'path';
import prisma from '@/lib/db';
import { WORKSPACE_ROOT } from '@/lib/config';

export const CAPTURE_SOURCES = ['ha_camera_snapshot', 'printer_camera_snapshot', 'forgerag_page'] as const;
export const CAPTURE_RETENTION_HOURS = 72;
export const CAMERA_SUBFOLDER = 'camera';

// settings is a JSON string written with JSON.stringify (no spaces).
export const capturedImageWhere = {
  OR: CAPTURE_SOURCES.map(s => ({ settings: { contains: `"source":"${s}"` } })),
};

// NULL settings must be matched explicitly: NOT (settings LIKE …) is NULL,
// not true, for a NULL column, which would silently drop legacy images.
export const galleryImageWhere = {
  OR: [{ settings: null }, { NOT: capturedImageWhere }],
};

export function cameraSnapshotFolder(choomSlug: string): string {
  return `selfies_${choomSlug}/${CAMERA_SUBFOLDER}`;
}

/** Delete this Choom's expired capture rows and expired files in her camera folder. Never throws. */
export async function pruneExpiredCaptures(choomId: string, choomSlug?: string): Promise<void> {
  const cutoff = new Date(Date.now() - CAPTURE_RETENTION_HOURS * 3600_000);
  try {
    const { count } = await prisma.generatedImage.deleteMany({
      where: { choomId, createdAt: { lt: cutoff }, ...capturedImageWhere },
    });
    if (count > 0) {
      await prisma.$queryRawUnsafe('PRAGMA incremental_vacuum');
      console.log(`   🧹 Pruned ${count} snapshot image(s) older than ${CAPTURE_RETENTION_HOURS}h`);
    }
  } catch (err) {
    console.warn('   ⚠️ Snapshot row prune failed:', err instanceof Error ? err.message : err);
  }
  if (!choomSlug) return;
  const dir = path.join(WORKSPACE_ROOT, cameraSnapshotFolder(choomSlug));
  try {
    for (const name of await fs.readdir(dir)) {
      if (!/\.(jpe?g|png)$/i.test(name)) continue;
      const file = path.join(dir, name);
      const st = await fs.stat(file);
      if (st.isFile() && st.mtimeMs < cutoff.getTime()) await fs.unlink(file);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('   ⚠️ Snapshot file prune failed:', err instanceof Error ? err.message : err);
    }
  }
}
