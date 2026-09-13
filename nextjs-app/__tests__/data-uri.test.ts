/** 2026-09-13: a regex over a 6.4 MB base64 payload blew the stack; the image route now slices. */
import { parseDataUri } from '@/lib/data-uri';

describe('parseDataUri', () => {
  test('decodes a base64 data URI and keeps the mime type', () => {
    const p = parseDataUri('data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64'))!;
    expect(p.contentType).toBe('image/png');
    expect(p.buffer.toString()).toBe('PNGDATA');
  });
  test('handles a payload far larger than the old regex could', () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 7);
    const p = parseDataUri('data:image/png;base64,' + big.toString('base64'))!;
    expect(p.buffer.length).toBe(big.length);
    expect(p.buffer.equals(big)).toBe(true);
  });
  test('non-data URLs and malformed URIs return null', () => {
    expect(parseDataUri('https://example.com/a.png')).toBeNull();
    expect(parseDataUri('data:image/png;base64')).toBeNull();
  });
  test('the image file route no longer regex-matches the payload', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'api', 'images', '[id]', 'file', 'route.ts'), 'utf-8') as string;
    expect(src).not.toContain('image.imageUrl.match(');
    expect(src).toContain('parseDataUri(image.imageUrl)');
  });
});
