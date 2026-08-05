import type { SearchSettings, SearchResult, SearchResponse } from './types';
import { ensureEndpoint } from './utils';
import { fenceUntrusted } from './untrusted-content';

export class WebSearchService {
  private settings: SearchSettings;

  constructor(settings: SearchSettings) {
    this.settings = settings;
  }

  // Ordered failover over every CONFIGURED backend (C-07). The old chains
  // only rotated on /(?:429|5\d\d)/ — so Brave 422 (a suspended subscription)
  // took the whole search feature down for days while two healthy, configured
  // backends sat idle. Any backend failure now rotates (a query that is
  // genuinely bad fails on all three and the aggregate says so), and when
  // every backend fails the error is CONFIG-class with per-backend detail
  // instead of a generic failure the doctor can't act on.
  async search(query: string, maxResults?: number): Promise<SearchResponse> {
    const limit = maxResults || this.settings.maxResults;

    const backends: Array<{ name: string; configured: boolean; run: () => Promise<SearchResponse> }> = [
      { name: 'brave', configured: !!this.settings.braveApiKey, run: () => this.searchBrave(query, limit) },
      { name: 'serpapi', configured: !!this.settings.serpApiKey, run: () => this.searchSerpApi(query, limit) },
      { name: 'searxng', configured: !!this.settings.searxngEndpoint, run: () => this.searchSearXNG(query, limit) },
    ];
    // Primary first, then the rest in declaration order.
    const primary = this.settings.provider === 'serpapi' ? 'serpapi'
      : this.settings.provider === 'brave' ? 'brave'
      : 'searxng';
    backends.sort((a, b) => (a.name === primary ? -1 : b.name === primary ? 1 : 0));

    const configured = backends.filter(b => b.configured);
    if (configured.length === 0) {
      throw new Error('No search backend configured — set a Brave API key, SerpAPI key, or SearXNG endpoint in Settings.');
    }

    const failures: string[] = [];
    for (const backend of configured) {
      try {
        const res = await backend.run();
        if (failures.length) {
          console.warn(`   🔄 Search served by ${backend.name} after: ${failures.join(' | ')}`);
        }
        return res;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failures.push(`${backend.name}: ${msg.slice(0, 140)}`);
        console.warn(`   🔄 Search backend ${backend.name} failed (${msg.slice(0, 100)}) — trying next`);
      }
    }
    throw new Error(
      `Web search is down: every configured backend failed — ${failures.join(' | ')}. ` +
      `This is an api key / subscription / service configuration problem for the owner to fix, not something a different query will get around.`,
    );
  }

  private async searchBrave(query: string, limit: number): Promise<SearchResponse> {
    if (!this.settings.braveApiKey) {
      throw new Error('Brave Search API key not configured');
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.settings.braveApiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave Search error: ${response.status}`);
    }

    const data = await response.json();

    const results: SearchResult[] = (data.web?.results || []).map((r: {
      title: string;
      url: string;
      description: string;
      age?: string;
    }) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      publishedDate: r.age,
    }));

    return {
      query,
      results,
      totalResults: data.web?.total || results.length,
    };
  }

  private async searchSerpApi(query: string, limit: number): Promise<SearchResponse> {
    if (!this.settings.serpApiKey) {
      throw new Error('SerpAPI key not configured');
    }

    const params = new URLSearchParams({
      q: query,
      api_key: this.settings.serpApiKey,
      engine: 'google',
      num: String(limit),
    });

    const response = await fetch(`https://serpapi.com/search?${params}`);

    if (!response.ok) {
      throw new Error(`SerpAPI error: ${response.status}`);
    }

    const data = await response.json();

    const results: SearchResult[] = (data.organic_results || [])
      .slice(0, limit)
      .map((r: {
        title: string;
        link: string;
        snippet: string;
        date?: string;
      }) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        publishedDate: r.date,
      }));

    return {
      query,
      results,
      totalResults: data.search_information?.total_results || results.length,
    };
  }

  private async searchSearXNG(query: string, limit: number): Promise<SearchResponse> {
    if (!this.settings.searxngEndpoint) {
      throw new Error('SearXNG endpoint not configured');
    }

    const url = ensureEndpoint(
      this.settings.searxngEndpoint,
      `/search?q=${encodeURIComponent(query)}&format=json&pageno=1`
    );

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; Choom/1.0)',
      },
    });

    if (!response.ok) {
      throw new Error(`SearXNG error: ${response.status}`);
    }

    const data = await response.json();

    const results: SearchResult[] = (data.results || [])
      .slice(0, limit)
      .map((r: {
        title: string;
        url: string;
        content: string;
        publishedDate?: string;
      }) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        publishedDate: r.publishedDate,
      }));

    // Detect upstream-engine blocks. SearXNG returns 200 OK even when its
    // configured engines (Brave/Google/DDG/Startpage) are individually rate-
    // limited or CAPTCHA'd, so a thin/empty response here usually means the
    // upstreams are blocked rather than 'no results found'. Surface this as
    // a 429-shaped error so the search() fallback chain can route to a
    // direct provider (Brave API / SerpAPI) with its own clean IP.
    const unresponsive = (data.unresponsive_engines || data.unresponsive || []) as Array<unknown>;
    const upstreamBlockRe = /too many requests|CAPTCHA|access denied|suspended|rate.?limit|forbidden|blocked|429/i;
    const blockedEngines: string[] = [];
    for (const entry of unresponsive) {
      if (Array.isArray(entry)) {
        const [name, reason] = entry as [unknown, unknown];
        const reasonStr = String(reason || '');
        if (upstreamBlockRe.test(reasonStr)) {
          blockedEngines.push(`${name}: ${reasonStr.slice(0, 60)}`);
        }
      } else if (typeof entry === 'string' && upstreamBlockRe.test(entry)) {
        blockedEngines.push(entry.slice(0, 80));
      }
    }
    // If most engines are unresponsive AND we got essentially nothing back,
    // treat as a 429 to trigger fallback. Allow legitimate empty results
    // (e.g., obscure query) — we only fail when the engines themselves block.
    if (blockedEngines.length >= 2 && results.length < 3) {
      throw new Error(
        `SearXNG 429: upstream engines blocked (${blockedEngines.join('; ')}). Results: ${results.length}. Falling back to direct provider.`,
      );
    }

    return {
      query,
      results,
      totalResults: data.number_of_results || results.length,
    };
  }

  formatResultsForPrompt(response: SearchResponse): string {
    if (response.results.length === 0) {
      return `No search results found for "${response.query}"`;
    }

    const resultsText = response.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n');

    // C-48: titles and snippets are attacker-controllable text from the open
    // web — fence them as DATA and strip invisible-character smuggling.
    return fenceUntrusted(resultsText, {
      source: `web search for "${response.query}"`,
      kind: 'search results',
    });
  }
}
