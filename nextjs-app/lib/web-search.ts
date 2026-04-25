import type { SearchSettings, SearchResult, SearchResponse } from './types';
import { ensureEndpoint } from './utils';

export class WebSearchService {
  private settings: SearchSettings;

  constructor(settings: SearchSettings) {
    this.settings = settings;
  }

  async search(query: string, maxResults?: number): Promise<SearchResponse> {
    const limit = maxResults || this.settings.maxResults;

    if (this.settings.provider === 'serpapi') {
      try {
        return await this.searchSerpApi(query, limit);
      } catch (error) {
        // Auto-fallback: SerpAPI → Brave → SearXNG
        const errMsg = error instanceof Error ? error.message : String(error);
        if (this.settings.braveApiKey && /(?:429|5\d\d)/.test(errMsg)) {
          console.warn(`   🔄 SerpAPI failed (${errMsg}), falling back to Brave`);
          try {
            return await this.searchBrave(query, limit);
          } catch (braveError) {
            const braveMsg = braveError instanceof Error ? braveError.message : String(braveError);
            if (this.settings.searxngEndpoint && /(?:429|5\d\d)/.test(braveMsg)) {
              console.warn(`   🔄 Brave also failed (${braveMsg}), falling back to SearXNG`);
              return this.searchSearXNG(query, limit);
            }
            throw braveError;
          }
        }
        if (this.settings.searxngEndpoint && /(?:429|5\d\d)/.test(errMsg)) {
          console.warn(`   🔄 SerpAPI failed (${errMsg}), falling back to SearXNG`);
          return this.searchSearXNG(query, limit);
        }
        throw error;
      }
    } else if (this.settings.provider === 'brave') {
      try {
        return await this.searchBrave(query, limit);
      } catch (error) {
        // Auto-fallback: Brave → SerpAPI → SearXNG
        const errMsg = error instanceof Error ? error.message : String(error);
        if (/(?:429|5\d\d)/.test(errMsg)) {
          if (this.settings.serpApiKey) {
            console.warn(`   🔄 Brave Search failed (${errMsg}), falling back to SerpAPI`);
            try {
              return await this.searchSerpApi(query, limit);
            } catch (serpError) {
              if (this.settings.searxngEndpoint) {
                console.warn(`   🔄 SerpAPI also failed, falling back to SearXNG`);
                return this.searchSearXNG(query, limit);
              }
              throw serpError;
            }
          } else if (this.settings.searxngEndpoint) {
            console.warn(`   🔄 Brave Search failed (${errMsg}), falling back to SearXNG`);
            return this.searchSearXNG(query, limit);
          }
        }
        throw error;
      }
    } else {
      // SearXNG-primary path. Fallback chain: SearXNG → Brave → SerpAPI when
      // SearXNG returns a 429-shaped error (real 429, 5xx, OR our synthetic
      // 'upstream engines blocked' detection from searchSearXNG above).
      try {
        return await this.searchSearXNG(query, limit);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (!/(?:429|5\d\d|upstream engines blocked)/i.test(errMsg)) throw error;

        if (this.settings.braveApiKey) {
          console.warn(`   🔄 SearXNG failed (${errMsg.slice(0, 100)}), falling back to Brave`);
          try {
            return await this.searchBrave(query, limit);
          } catch (braveError) {
            const braveMsg = braveError instanceof Error ? braveError.message : String(braveError);
            if (this.settings.serpApiKey && /(?:429|5\d\d)/.test(braveMsg)) {
              console.warn(`   🔄 Brave also failed (${braveMsg}), falling back to SerpAPI`);
              return this.searchSerpApi(query, limit);
            }
            throw braveError;
          }
        }
        if (this.settings.serpApiKey) {
          console.warn(`   🔄 SearXNG failed (${errMsg.slice(0, 100)}), falling back to SerpAPI`);
          return this.searchSerpApi(query, limit);
        }
        throw error;
      }
    }
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

    return `Search results for "${response.query}":\n\n${resultsText}`;
  }
}
