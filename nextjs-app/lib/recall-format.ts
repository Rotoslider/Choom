/**
 * Rendering conversation-index hits (memory server /conversations/search) for
 * a Choom: who said it, where, and when, in her local time.
 *
 * Hits come back as the indexed text — "[private chat · Donny] the canvas is
 * on our wall…", "[room Family Time · Eve] …", or a memory's "title\ncontent".
 * The label moves out of the text into `from`, and her own lines read "you".
 */
export interface ConversationHit {
  id: string;
  source: 'memory' | 'chat' | 'room';
  speaker: string;
  ts: number; // UTC epoch seconds
  text: string;
  relevance?: number;
  thread?: string;
}

export interface RenderedHit {
  when: string;         // local "2026-09-23 17:10"
  from: string;         // "Donny · private chat" | "you · room Family Time" | "your memory"
  title?: string;       // memories only
  id?: string;          // memories only — what update_memory / delete_memory take
  excerpt: string;
}

const LABEL = /^\[([^\]·]+?) · ([^\]]+?)\]\s*/;

export function localStamp(tsSeconds: number, tz = 'America/Denver'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(tsSeconds * 1000)).map(p => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

export function renderHit(hit: ConversationHit, selfName: string, maxChars = 1500): RenderedHit {
  const when = localStamp(hit.ts);
  const clip = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > maxChars ? t.slice(0, maxChars - 1) + '…' : t;
  };
  if (hit.source === 'memory') {
    const nl = hit.text.indexOf('\n');
    const title = nl > 0 ? hit.text.slice(0, nl).trim() : '';
    const body = nl > 0 ? hit.text.slice(nl + 1) : hit.text;
    return { when, from: 'your memory', ...(title ? { title } : {}), id: hit.id, excerpt: clip(body) };
  }
  const m = hit.text.match(LABEL);
  const where = m ? m[1].trim() : (hit.source === 'chat' ? 'private chat' : 'room');
  const who = m ? m[2].trim() : hit.speaker;
  const body = m ? hit.text.slice(m[0].length) : hit.text;
  const speaker = who.toLowerCase() === selfName.toLowerCase() ? 'you' : who;
  return { when, from: `${speaker} · ${where}`, excerpt: clip(body) };
}

/** One line for an auto-recall block. */
export function recallLine(r: RenderedHit): string {
  const head = r.title ? `${r.title}: ` : '';
  return `- [${r.when} · ${r.from}] ${head}${r.excerpt}`;
}
