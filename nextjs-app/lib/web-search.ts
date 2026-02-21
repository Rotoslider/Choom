import type { SearchSettings, SearchResult, SearchResponse } from './types';
import { ensureEndpoint } from './utils';

export class WebSearchService {
  private settings: SearchSettings;

  constructor(settings: SearchSettings) {
    this.settings = settings;
  }

  async search(query: string, maxResults?: number): Promise<SearchResponse> {
    const limit = maxResults || this.settings.maxResults;

    if (this.settings.provider === 'brave') {
      return this.searchBrave(query, limit);
    } else {
      return this.searchSearXNG(query, limit);
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

  private async searchSearXNG(query: string, limit: number): Promise<SearchResponse> {
    if (!this.settings.searxngEndpoint) {
      throw new Error('SearXNG endpoint not configured');
    }

    const url = ensureEndpoint(
      this.settings.searxngEndpoint,
      `/search?q=${encodeURIComponent(query)}&format=json&pageno=1`
    );

    const response = await fetch(url);

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
