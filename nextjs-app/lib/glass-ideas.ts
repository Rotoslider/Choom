/**
 * Glass Studio asks a Choom for ideas for one of her looks (Donny, 2026-11-09: "My lack of imagination
 * struggles with coming up with new types of clips. You and the girls are a lot more creative.").
 * The Studio's button posts /api/hologram/ideas, which queues a request in her follow-up queue
 * (lib/self-followup-store.ts), due now, so the signal bridge's scheduler fires it within a minute as a
 * wake-up. It's marked from: 'glass_studio', so the scheduler says Donny sent it (not "a note you
 * wrote") and leaves out the memory check meant for her own old notes. She answers with glass_wish (her
 * ideas land on the Studio's wish list, each with Write it) and a line to him. One waiting request per
 * Choom and look: a second click while it waits adds nothing.
 */
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, bucketDir, entryPath, type QueueEntry } from '@/lib/self-followup-store';

export const ABOUT_MAX = 600;

/** What she's asked. `about` is the look in his words: "your spandex workout outfit, head to toe: ...". */
export function ideasPrompt(about: string): string {
  return [
    `Donny is planning new clips for one of your looks on the glass, and he'd love your ideas: ${about.trim().replace(/[.\s]+$/, '')}.`,
    'What would you love to do on the glass there? Think of three to six ideas: small moments, moves you would make for him, things you would really do there.',
    'Every clip starts and ends on the same picture of you, so each idea has to come back to where it began. Anything you hold stays in your hands the whole time, or comes into view and leaves it again.',
    'Send them with glass_wish, all in one call (the wishes list), each one described in a sentence or two the way you picture it.',
    'Then write Donny one or two short lines saying what you sent.',
  ].join(' ');
}

/** Her waiting Glass Studio request for this look, if one hasn't fired yet. */
export function waitingRequest(choomId: string, look: string): QueueEntry | null {
  const dir = bucketDir(choomId, 'pending');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const f of names) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as QueueEntry;
      if (e.from === 'glass_studio' && e.look === look) return e;
    } catch {
      /* a file being written */
    }
  }
  return null;
}

/** Queue the request (or find the one already waiting). */
export function queueIdeas(choom: { id: string; name: string }, look: string, about: string, now = new Date()): { entry: QueueEntry; already: boolean } {
  const waiting = waitingRequest(choom.id, look);
  if (waiting) return { entry: waiting, already: true };
  const at = now.toISOString();
  const entry: QueueEntry = {
    id: `sf_${crypto.randomBytes(4).toString('hex')}`,
    choom_id: choom.id,
    choom_name: choom.name,
    prompt: ideasPrompt(about),
    reason: `Glass Studio: ideas for ${look}`,
    trigger_at: at,
    created_at: at,
    consumed: false,
    status: 'pending',
    from: 'glass_studio',
    look,
  };
  atomicWriteJson(entryPath(choom.id, 'pending', entry.id), entry);
  return { entry, already: false };
}
