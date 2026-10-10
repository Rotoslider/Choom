/**
 * The Chooms asking the Looking Glass for things themselves: a move ("a little dance"), clothes from
 * their closet on the glass ("my red dress"), or what they have there. Requests go down the
 * hologram's feed as glass_request events; the hologram's server on the NUC matches them against
 * what is built on the glass (hologram/tools/closet.py), tells the page what to play or wear, and
 * posts the answer back to /api/hologram/glass/result, the way the glass camera's answers come back.
 * Something a Choom asks for and hasn't got goes on her wish list in Glass Studio.
 */
import { randomUUID } from 'crypto';
import { hologramConnected, publishHologram } from '@/lib/hologram-bus';

export type GlassOp = 'closet' | 'move' | 'wear';

export interface GlassAnswer {
  ok: boolean;
  error?: string;
  done?: boolean;      // false: she hasn't got it yet (it went on the wish list)
  message?: string;    // for her, in her own words' place
  moves?: string[];
  clothes?: string[];
  note?: string;
}

type Pending = { resolve: (a: GlassAnswer) => void; timer: ReturnType<typeof setTimeout> };
const store = globalThis as unknown as { __choomGlassRequests?: Map<string, Pending> };
const pending = (store.__choomGlassRequests ??= new Map<string, Pending>());

/** Ask the glass; resolves with its answer, or ok:false if the glass isn't running or doesn't answer. */
export function askGlass(choom: string, op: GlassOp, what = '', timeoutMs = 8_000): Promise<GlassAnswer> {
  if (!hologramConnected()) return Promise.resolve({ ok: false, error: 'The Looking Glass (the hologram on the NUC) is not running right now.' });
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'The Looking Glass did not answer in time.' });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    publishHologram({ type: 'glass_request', id, choom, op, what });
  });
}

/** The hologram's answer to a glass_request. */
export function resolveGlass(id: string, answer: GlassAnswer): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(answer);
  return true;
}
