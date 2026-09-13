/**
 * Data-URI parsing without a regex over the payload. A capture group like
 * `([\s\S]+)$` on a multi-megabyte base64 string overflows V8's regex
 * stack ("Maximum call stack size exceeded"), which is how a 6.4 MB
 * generated PNG came back as a 500 from /api/images/[id]/file (2026-09-13).
 */
export interface ParsedDataUri {
  contentType: string;
  buffer: Buffer;
}

export function parseDataUri(uri: string): ParsedDataUri | null {
  if (!uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const header = uri.slice(5, comma); // "<mime>;base64" or "<mime>"
  const semi = header.indexOf(';');
  const contentType = (semi >= 0 ? header.slice(0, semi) : header) || 'application/octet-stream';
  const isBase64 = semi >= 0 && header.slice(semi + 1).split(';').includes('base64');
  const payload = uri.slice(comma + 1);
  const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf-8');
  return { contentType, buffer };
}
