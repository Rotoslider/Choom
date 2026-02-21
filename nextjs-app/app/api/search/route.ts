import { NextRequest, NextResponse } from 'next/server';
import { WebSearchService } from '@/lib/web-search';
import type { SearchSettings } from '@/lib/types';

// Default search settings
const defaultSearchSettings: SearchSettings = {
  provider: 'brave',
  braveApiKey: process.env.BRAVE_API_KEY || '',
  searxngEndpoint: process.env.SEARXNG_ENDPOINT || '',
  maxResults: 5,
};

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('query');

    if (!query) {
      return NextResponse.json(
        { error: 'Query parameter is required' },
        { status: 400 }
      );
    }

    // Build settings from query params or use defaults
    const settings: SearchSettings = {
      provider: (searchParams.get('provider') as 'brave' | 'searxng') || defaultSearchSettings.provider,
      braveApiKey: searchParams.get('braveApiKey') || defaultSearchSettings.braveApiKey,
      searxngEndpoint: searchParams.get('searxngEndpoint') || defaultSearchSettings.searxngEndpoint,
      maxResults: parseInt(searchParams.get('maxResults') || '5') || defaultSearchSettings.maxResults,
    };

    // Validate configuration
    if (settings.provider === 'brave' && !settings.braveApiKey) {
      return NextResponse.json(
        { error: 'Brave Search API key not configured' },
        { status: 400 }
      );
    }

    if (settings.provider === 'searxng' && !settings.searxngEndpoint) {
      return NextResponse.json(
        { error: 'SearXNG endpoint not configured' },
        { status: 400 }
      );
    }

    const searchService = new WebSearchService(settings);
    const results = await searchService.search(query);
    const formatted = searchService.formatResultsForPrompt(results);

    return NextResponse.json({
      success: true,
      results,
      formatted,
    });
  } catch (error) {
    console.error('Search API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Search failed' },
      { status: 500 }
    );
  }
}
