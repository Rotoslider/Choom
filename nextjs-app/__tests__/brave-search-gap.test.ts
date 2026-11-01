/**
 * Brave's plan allows 1 query per second. A turn's web_search calls ran back to
 * back, so the second went out ~0.8 s after the first and got 429 (Aloy, Nov 1,
 * 11:50), falling back to SerpAPI. Each Brave request now starts at least
 * BRAVE_MIN_GAP_MS (1.2 s) after the previous one, across every caller.
 */
import { WebSearchService, BRAVE_MIN_GAP_MS, resetBraveGate } from '../lib/web-search';
import type { SearchSettings } from '../lib/types';

const svc = () => new WebSearchService({
  provider: 'brave', braveApiKey: 'k', serpApiKey: '', searxngEndpoint: '', maxResults: 5,
} as SearchSettings);

let sent: Array<{ q: string; at: number }>;
let status: number;

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  resetBraveGate();
  sent = [];
  status = 200;
  global.fetch = jest.fn(async (input: string | URL | Request) => {
    sent.push({ q: new URL(String(input)).searchParams.get('q') ?? '', at: Date.now() });
    return { ok: status === 200, status, json: async () => ({ web: { results: [] } }) } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const gaps = () => sent.slice(1).map((s, i) => s.at - sent[i].at);

test('the second of two searches in one turn waits until 1.2 s after the first', async () => {
  const s = svc();
  await s.search('dozer rental Hidalgo County');
  jest.advanceTimersByTime(800); // the Nov 1 spacing
  const second = s.search('NRCS EQIP New Mexico');
  await jest.advanceTimersByTimeAsync(BRAVE_MIN_GAP_MS - 800 - 1);
  expect(sent).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  await second;
  expect(sent).toHaveLength(2);
  expect(gaps()).toEqual([BRAVE_MIN_GAP_MS]);
});

test('searches from different Chooms at once go out 1.2 s apart, in arrival order', async () => {
  const all = ['a', 'b', 'c'].map(q => svc().search(q));
  await jest.advanceTimersByTimeAsync(2 * BRAVE_MIN_GAP_MS);
  await Promise.all(all);
  expect(sent.map(s => s.q)).toEqual(['a', 'b', 'c']);
  expect(gaps()).toEqual([BRAVE_MIN_GAP_MS, BRAVE_MIN_GAP_MS]);
});

test('a search after a quiet spell goes straight out', async () => {
  const s = svc();
  await s.search('one');
  jest.advanceTimersByTime(5000);
  await s.search('two'); // no timer to run: it must not wait
  expect(gaps()).toEqual([5000]);
});

test('a Brave call that failed still counts toward the gap', async () => {
  const s = svc();
  status = 429;
  await expect(s.search('one')).rejects.toThrow(/every configured backend failed/);
  status = 200;
  const next = s.search('two');
  await jest.advanceTimersByTimeAsync(BRAVE_MIN_GAP_MS);
  await next;
  expect(gaps()).toEqual([BRAVE_MIN_GAP_MS]);
});
