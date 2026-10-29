/**
 * A Choom's avatar is a picture kept in her record as a data URI (a 1-3 MB PNG). Sent inside every Choom
 * list, room and room event, it made /api/chooms 7 MB (loaded twice each time the app opened) and the
 * rooms list 4 MB (2026-10-28). Those carry a link instead: /api/chooms/<id>/avatar?v=<the picture's
 * fingerprint>, which the browser keeps until the picture changes. A picture given as a web address is
 * passed on as it is.
 */
import { createHash } from 'crypto';

/** The avatar as the pages get it: a link to the picture, by its fingerprint. */
export function avatarLink(id: string, avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  if (!avatarUrl.startsWith('data:')) return avatarUrl;
  const v = createHash('sha1').update(avatarUrl).digest('hex').slice(0, 12);
  return `/api/chooms/${id}/avatar?v=${v}`;
}

/** A Choom record as the pages get it. */
export function withAvatarLink<T extends { id: string; avatarUrl?: string | null }>(choom: T): T {
  return { ...choom, avatarUrl: avatarLink(choom.id, choom.avatarUrl) };
}

/** The avatar link handed out above coming back unchanged (the edit panel saves what it was given). */
export function isAvatarLink(value: unknown, id: string): boolean {
  return typeof value === 'string' && value.startsWith(`/api/chooms/${id}/avatar`);
}

/** The picture in a data URI: its type and bytes, or null when it isn't one. */
export function avatarImage(avatarUrl: string): { type: string; bytes: Buffer } | null {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(avatarUrl);
  return m ? { type: m[1], bytes: Buffer.from(m[2], 'base64') } : null;
}

/** A room as the pages get it: its Chooms' avatars as links. */
export function roomWithAvatarLinks<T extends { participants?: { choom?: { id: string; avatarUrl?: string | null } | null }[] }>(room: T): T {
  if (!room.participants) return room;
  return { ...room, participants: room.participants.map((p) => (p.choom ? { ...p, choom: withAvatarLink(p.choom) } : p)) };
}
