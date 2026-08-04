/**
 * WebSearchService ordered failover (C-07).
 *
 * The outage that raised this row: Brave returned 422 (suspended
 * subscription) — the old fallback only rotated on /(?:429|5\d\d)/, so one
 * dead account took the whole search feature down while a configured SerpAPI
 * key and a healthy SearXNG sat idle. Any backend failure now rotates, and
 * when everything fails the error is CONFIG-class with per-backend detail.
 */
import { WebSearchService } from '../lib/web-search';
import { CONFIG_ERROR } from '../lib/tool-error-classification';
import type { SearchSettings, SearchResponse } from '../lib/types';

const OK: SearchResponse = { query: 'q', results: [{ title: 't', url: 'u', snippet: 's' }], totalResults: 1 };

function svc(settings: Partial<SearchSettings>) {
  return new WebSearchService({
    provider: 'brave', braveApiKey: 'k', serpApiKey: 'k2', searxngEndpoint: 'http://sx:8888', maxResults: 5,
    ...settings,
  } as SearchSettings);
}

type AnyService = { searchBrave: jest.Mock; searchSerpApi: jest.Mock; searchSearXNG: jest.Mock };
function stub(s: WebSearchService, impl: Partial<Record<keyof AnyService, jest.Mock>>) {
  const t = s as unknown as AnyService;
  t.searchBrave = impl.searchBrave ?? jest.fn().mockResolvedValue(OK);
  t.searchSerpApi = impl.searchSerpApi ?? jest.fn().mockResolvedValue(OK);
  t.searchSearXNG = impl.searchSearXNG ?? jest.fn().mockResolvedValue(OK);
  return t;
}

describe('ordered failover', () => {
  test('healthy primary is the only call made', async () => {
    const s = svc({ provider: 'brave' });
    const t = stub(s, {});
    await s.search('anything');
    expect(t.searchBrave).toHaveBeenCalledTimes(1);
    expect(t.searchSerpApi).not.toHaveBeenCalled();
    expect(t.searchSearXNG).not.toHaveBeenCalled();
  });

  test('THE C-07 case: Brave 422 rotates to the next backend instead of failing', async () => {
    const s = svc({ provider: 'brave' });
    const t = stub(s, { searchBrave: jest.fn().mockRejectedValue(new Error('Brave Search error: 422')) });
    const res = await s.search('anything');
    expect(res).toEqual(OK);
    expect(t.searchSerpApi).toHaveBeenCalledTimes(1);
  });

  test('primary setting drives the order (searxng first when selected)', async () => {
    const s = svc({ provider: 'searxng' });
    const calls: string[] = [];
    stub(s, {
      searchSearXNG: jest.fn(async () => { calls.push('searxng'); throw new Error('SearXNG error: 500'); }),
      searchBrave: jest.fn(async () => { calls.push('brave'); return OK; }),
    });
    await s.search('anything');
    expect(calls).toEqual(['searxng', 'brave']);
  });

  test('unconfigured backends are never attempted', async () => {
    const s = svc({ provider: 'brave', serpApiKey: '', searxngEndpoint: '' });
    const t = stub(s, { searchBrave: jest.fn().mockRejectedValue(new Error('Brave Search error: 429')) });
    await expect(s.search('anything')).rejects.toThrow(/every configured backend failed/);
    expect(t.searchSerpApi).not.toHaveBeenCalled();
    expect(t.searchSearXNG).not.toHaveBeenCalled();
  });

  test('all-backends-down error is CONFIG-class and itemizes each failure', async () => {
    const s = svc({ provider: 'brave' });
    stub(s, {
      searchBrave: jest.fn().mockRejectedValue(new Error('Brave Search error: 422')),
      searchSerpApi: jest.fn().mockRejectedValue(new Error('SerpAPI error: 429')),
      searchSearXNG: jest.fn().mockRejectedValue(new Error('SearXNG 429: upstream engines blocked (brave: suspended)')),
    });
    const err = (await s.search('anything').catch(e => e)) as Error;
    expect(err.message).toMatch(/brave: .*422/);
    expect(err.message).toMatch(/serpapi: .*429/);
    expect(err.message).toMatch(/searxng: .*upstream engines blocked/);
    expect(CONFIG_ERROR.test(err.message)).toBe(true);
  });

  test('nothing configured at all is CONFIG-class too', async () => {
    const s = svc({ braveApiKey: '', serpApiKey: '', searxngEndpoint: '' });
    const err = (await s.search('anything').catch(e => e)) as Error;
    expect(err.message).toContain('No search backend configured');
    expect(CONFIG_ERROR.test(err.message)).toBe(true);
  });
});
