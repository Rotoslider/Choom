/**
 * fetchBotFallback (C-12) — the anti-bot UA retry ladder.
 *
 * Measured live: W3C's CDN returns 403 to the fake-Chrome User-Agent (a
 * Chrome UA whose connection doesn't fingerprint like real Chrome) but 200
 * to a minimal 'Mozilla/5.0' — while other hosts 403 bare requests, which is
 * why the browser UA exists at all. The ladder tries browser-like headers
 * first and retries once with the minimal UA on 403/406.
 */
import { fetchBotFallback } from '../skills/core/web-scraping/handler';

function fakeFetch(statuses: number[]) {
  const calls: Array<Record<string, string>> = [];
  const impl = jest.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push(init?.headers ?? {});
    return { status: statuses[Math.min(calls.length, statuses.length) - 1], ok: false } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const OPTS = { timeoutMs: 5000, accept: '*/*', referer: 'https://example.com/' };

describe('fetchBotFallback', () => {
  test('a normal response passes through with ONE attempt (browser headers)', async () => {
    const { impl, calls } = fakeFetch([200]);
    const res = await fetchBotFallback('https://example.com/f.pdf', OPTS, impl);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]['User-Agent']).toContain('Chrome');
    expect(calls[0]['Referer']).toBe('https://example.com/');
  });

  test('403 retries once with the minimal UA and no Referer', async () => {
    const { impl, calls } = fakeFetch([403, 200]);
    const res = await fetchBotFallback('https://example.com/f.pdf', OPTS, impl);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]['User-Agent']).toBe('Mozilla/5.0');
    expect(calls[1]['Referer']).toBeUndefined();
    expect(calls[1]['Accept-Language']).toBeUndefined();
  });

  test('406 also triggers the retry', async () => {
    const { impl, calls } = fakeFetch([406, 200]);
    const res = await fetchBotFallback('https://example.com/f.pdf', OPTS, impl);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test('a genuine 403 on both attempts surfaces the 403 (no infinite ladder)', async () => {
    const { impl, calls } = fakeFetch([403, 403]);
    const res = await fetchBotFallback('https://example.com/f.pdf', OPTS, impl);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(2);
  });

  test('404/500 do NOT retry — only bot-detection statuses do', async () => {
    for (const code of [404, 500, 429]) {
      const { impl, calls } = fakeFetch([code]);
      const res = await fetchBotFallback('https://example.com/f.pdf', OPTS, impl);
      expect(res.status).toBe(code);
      expect(calls).toHaveLength(1);
    }
  });
});
