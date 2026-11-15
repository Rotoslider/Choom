/**
 * The Chooms' projects folder moved with Choom from the NUC (/home/nuc1/choom-projects) to the Mac on
 * Oct 4 2026, but their notes, memories and habits still carry the old path: 63 tool calls from Oct 4 to
 * Nov 11 used it, 56 of them Aloy's (her own prompt still named it). On the Mac /home is an automount
 * point, so those commands found nothing (`find /home/nuc1/choom-projects ... 2>/dev/null` came back
 * empty, and she concluded the file wasn't there) or failed outright (FreeCAD: "create_directories:
 * Operation not supported ['/home/nuc1']"). The tools that run a Choom's own commands and code map the old
 * folder to the real one, and say so in their result so she learns the new place (Nov 15 2026).
 */
import { WORKSPACE_ROOT } from '@/lib/config';

export const LEGACY_WORKSPACE_ROOTS = ['/home/nuc1/choom-projects'];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with every old projects-folder path pointing at `root` instead. Only the whole folder name
 * matches: /home/nuc1/choom-projects-old or /home/nuc1/other are left alone. */
export function translateLegacyPaths(text: string, root: string = WORKSPACE_ROOT): { text: string; changed: boolean } {
  if (!text) return { text, changed: false };
  let out = text;
  for (const legacy of LEGACY_WORKSPACE_ROOTS) {
    if (legacy === root) continue;
    out = out.replace(new RegExp(escape(legacy) + '(?![A-Za-z0-9_.-])', 'g'), root);
  }
  return { text: out, changed: out !== text };
}

/** What the tool result says when it translated something. */
export const legacyPathNote = (root: string = WORKSPACE_ROOT): string =>
  `Note: /home/nuc1/choom-projects is the old NUC folder from before Choom moved to the Mac; it was read as ${root}, ` +
  `where the projects folder is now. Use paths relative to your project folder, or ~/choom-projects.`;
