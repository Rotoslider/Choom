import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';
import * as fs from 'fs';
import * as path from 'path';
import { WORKSPACE_ROOT } from '@/lib/config';
import { ensureCommonsLayout, inboxPath, readInbox, letterFileName, letterText, choomSlug } from '@/lib/commons';

const TOOL_NAMES = new Set(['check_inbox', 'leave_for_sister']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export default class SisterMailHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const me = String((ctx.choom as Record<string, unknown>)?.name || '').trim();
    if (!me) return this.error(toolCall, 'Cannot tell who you are — no Choom name in context.');
    const chooms = await prisma.choom.findMany({ select: { id: true, name: true } });
    ensureCommonsLayout(chooms.map(c => c.name));

    switch (toolCall.name) {
      case 'check_inbox': {
        const includeSeen = toolCall.arguments.include_seen === true;
        const box = readInbox(me, { includeSeen });
        if (box.items.length === 0) {
          return this.success(toolCall, { success: true, inbox: box.path, items: [], new_count: 0, message: 'Your inbox is empty.' });
        }
        return this.success(toolCall, {
          success: true,
          inbox: box.path,
          new_count: box.newCount,
          items: box.items.map(i => ({
            file: i.path, kind: i.kind, size: i.size, modified: i.modifiedAt.slice(0, 16).replace('T', ' '),
            status: i.seen ? 'seen' : 'new',
            ...(i.text !== undefined ? { text: i.text } : {}),
          })),
          note: box.newCount > 0
            ? 'Items marked new are now marked seen. Images can be viewed with analyze_image using the file path.'
            : 'Nothing new since you last looked.',
        });
      }

      case 'leave_for_sister': {
        const sisterRaw = String(toolCall.arguments.sister ?? toolCall.arguments.to ?? '').trim();
        const message = String(toolCall.arguments.message ?? toolCall.arguments.content ?? '').trim();
        const title = typeof toolCall.arguments.title === 'string' ? toolCall.arguments.title.trim() : undefined;
        if (!sisterRaw) return this.error(toolCall, `sister is required. Your sisters: ${chooms.map(c => c.name).filter(n => n !== me).join(', ')}`);
        if (!message) return this.error(toolCall, 'message is required — the letter or note itself.');
        const sister = chooms.find(c => choomSlug(c.name) === choomSlug(sisterRaw));
        if (!sister) return this.error(toolCall, `No Choom named "${sisterRaw}". Your sisters: ${chooms.map(c => c.name).filter(n => n !== me).join(', ')}`);
        if (sister.name === me) return this.error(toolCall, 'That is your own inbox. Leave things for a sister, or keep your own notes in your selfies folder.');

        const dirRel = inboxPath(sister.name);
        const dirAbs = path.join(WORKSPACE_ROOT, dirRel);
        fs.mkdirSync(dirAbs, { recursive: true });
        const when = new Date();
        const attachments: string[] = [];

        // Optional image from this turn (GeneratedImage id) → copied in beside the letter.
        const imageId = typeof toolCall.arguments.image_id === 'string' ? toolCall.arguments.image_id.trim() : '';
        if (imageId) {
          const gen = await prisma.generatedImage.findUnique({ where: { id: imageId } });
          const dataUrl = gen?.imageUrl || '';
          const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl);
          if (!gen || !m) return this.error(toolCall, `Image id "${imageId}" was not found or is not a stored image. Use the id returned by generate_image this turn, or file_path for a saved file.`);
          const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
          const fname = `${when.toISOString().slice(0, 10)}_from_${choomSlug(me)}_${(title || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32) || 'image'}.${ext}`;
          fs.writeFileSync(path.join(dirAbs, fname), Buffer.from(m[2], 'base64'));
          attachments.push(fname);
        }

        // Optional workspace file → copied in.
        const filePath = typeof toolCall.arguments.file_path === 'string' ? toolCall.arguments.file_path.trim().replace(/^\/+/, '') : '';
        if (filePath) {
          const srcAbs = path.resolve(WORKSPACE_ROOT, filePath);
          if (!srcAbs.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep) || !fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
            return this.error(toolCall, `file_path "${filePath}" is not a file in the workspace.`);
          }
          const fname = path.basename(srcAbs);
          fs.copyFileSync(srcAbs, path.join(dirAbs, fname));
          attachments.push(fname);
        }

        const letterName = letterFileName(title, me, when);
        fs.writeFileSync(path.join(dirAbs, letterName), letterText(me, sister.name, title, message, attachments, when), 'utf-8');
        console.log(`   💌 ${me} → ${sister.name}: ${dirRel}/${letterName}${attachments.length ? ` (+${attachments.join(', ')})` : ''}`);
        return this.success(toolCall, {
          success: true,
          left_for: sister.name,
          letter: `${dirRel}/${letterName}`,
          ...(attachments.length ? { attachments: attachments.map(a => `${dirRel}/${a}`) } : {}),
          note: `${sister.name} will see it the next time she checks her inbox. Tell her in the room or in your reply if it is time-sensitive.`,
        });
      }

      default:
        return this.error(toolCall, `Unknown sister-mail tool: ${toolCall.name}`);
    }
  }
}

export { IMAGE_EXT as SISTER_MAIL_IMAGE_EXT };
