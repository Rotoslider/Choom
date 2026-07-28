/**
 * "You named it wrong — here is what actually exists."
 *
 * The single most common tool-failure pattern in this codebase: a Choom names
 * a file, entity, camera preset or player that does not exist, the tool fails,
 * she never lists the real options, she retries the same fantasy name, and the
 * per-tool cap eventually locks her out. Classifying every not-found error in
 * the trace corpus:
 *
 *   627  error already includes the valid options   <- recovers
 *   143  error says "go call list_x" instead        <- costs an iteration, often ignored
 *   309  error gives neither                        <- dead end, retries until locked out
 *
 * workspace-files solved this by walking up to the nearest existing ancestor
 * directory and returning its contents inline. That logic was trapped in one
 * handler; this is the shared version so other tools can stop dead-ending.
 *
 * Principle: never tell the model to go look something up. Put the answer in
 * the error.
 */

export interface DirEntryLike { name: string; type: 'file' | 'directory'; size: number }

/**
 * Walk up from a path to the nearest ancestor that exists and has contents,
 * and format that listing for an error message.
 *
 * @param wantedPath the path that was not found
 * @param list       lists a directory relative to the workspace root
 * @param filter     optional predicate, e.g. images only
 * @returns a formatted block, or null if nothing could be listed
 */
export async function suggestFromNearestDir(
  wantedPath: string,
  list: (dir: string) => Promise<DirEntryLike[]>,
  filter?: (e: DirEntryLike) => boolean,
): Promise<{ dirLabel: string; formatted: string; count: number } | null> {
  const segments = wantedPath.split('/').filter(Boolean);
  // parent, grandparent, ... , workspace root
  const ancestors: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) ancestors.push(segments.slice(0, i).join('/'));

  for (const dir of ancestors) {
    try {
      let entries = await list(dir);
      if (filter) entries = entries.filter(e => e.type === 'directory' || filter(e));
      if (!entries.length) continue;
      const shown = entries.slice(0, 40).map(e => {
        if (e.type === 'directory') return `  📁 ${e.name}/`;
        const size = e.size < 1024 ? `${e.size}B` : `${(e.size / 1024).toFixed(1)}KB`;
        return `  📄 ${e.name} (${size})`;
      }).join('\n');
      const more = entries.length > 40 ? `\n  ... and ${entries.length - 40} more entries` : '';
      return { dirLabel: dir || '(workspace root)', formatted: shown + more, count: entries.length };
    } catch { /* try the next ancestor up */ }
  }
  return null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
export const isImageEntry = (e: DirEntryLike) => IMAGE_EXT.test(e.name);
