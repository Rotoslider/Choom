'use client';

import React, { useState } from 'react';
import { Search, Globe, Key, RefreshCw, Check, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/lib/store';
import type { SearchResult } from '@/lib/types';

export function SearchSettings() {
  const { settings, updateSearchSettings } = useAppStore();
  const [testQuery, setTestQuery] = useState('latest AI news');
  const [testResult, setTestResult] = useState<{
    success: boolean;
    results?: SearchResult[];
    error?: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const testSearch = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const params = new URLSearchParams({
        query: testQuery,
        provider: settings.search.provider,
        maxResults: settings.search.maxResults.toString(),
      });

      if (settings.search.provider === 'brave' && settings.search.braveApiKey) {
        params.set('braveApiKey', settings.search.braveApiKey);
      }
      if (settings.search.provider === 'searxng' && settings.search.searxngEndpoint) {
        params.set('searxngEndpoint', settings.search.searxngEndpoint);
      }

      const response = await fetch(`/api/search?${params}`);
      const data = await response.json();

      if (data.success) {
        setTestResult({ success: true, results: data.results.results });
      } else {
        setTestResult({ success: false, error: data.error });
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test search',
      });
    } finally {
      setTesting(false);
    }
  };

  const isConfigured = settings.search.provider === 'brave'
    ? !!settings.search.braveApiKey
    : !!settings.search.searxngEndpoint;

  return (
    <div className="space-y-6">
      {/* Provider Selection */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Globe className="h-4 w-4" />
          Search Provider
        </h3>

        <div className="space-y-2">
          <label htmlFor="search-provider">Provider</label>
          <Select
            value={settings.search.provider}
            onValueChange={(value: 'brave' | 'searxng') =>
              updateSearchSettings({ provider: value })
            }
          >
            <SelectTrigger id="search-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="brave">Brave Search</SelectItem>
              <SelectItem value="searxng">SearXNG</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {settings.search.provider === 'brave'
              ? 'Brave Search offers high-quality results with a free API tier'
              : 'SearXNG is a self-hosted metasearch engine'}
          </p>
        </div>
      </div>

      {/* Brave API Key */}
      {settings.search.provider === 'brave' && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Key className="h-4 w-4" />
            Brave Search API
          </h3>

          <div className="space-y-2">
            <label htmlFor="brave-api-key">API Key</label>
            <Input
              id="brave-api-key"
              type="password"
              value={settings.search.braveApiKey || ''}
              onChange={(e) => updateSearchSettings({ braveApiKey: e.target.value })}
              placeholder="Enter your Brave API key"
            />
            <p className="text-xs text-muted-foreground">
              Get a free API key from{' '}
              <a
                href="https://brave.com/search/api/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Brave Search API
              </a>
            </p>
          </div>
        </div>
      )}

      {/* SearXNG Endpoint */}
      {settings.search.provider === 'searxng' && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Globe className="h-4 w-4" />
            SearXNG Configuration
          </h3>

          <div className="space-y-2">
            <label htmlFor="searxng-endpoint">Endpoint URL</label>
            <Input
              id="searxng-endpoint"
              value={settings.search.searxngEndpoint || ''}
              onChange={(e) => updateSearchSettings({ searxngEndpoint: e.target.value })}
              placeholder="e.g., https://searxng.example.com"
            />
            <p className="text-xs text-muted-foreground">
              The base URL of your SearXNG instance
            </p>
          </div>
        </div>
      )}

      {/* Max Results */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Search className="h-4 w-4" />
          Search Options
        </h3>

        <div className="space-y-2">
          <label htmlFor="max-results">Max Results</label>
          <Input
            id="max-results"
            type="number"
            min={1}
            max={20}
            value={settings.search.maxResults}
            onChange={(e) =>
              updateSearchSettings({ maxResults: parseInt(e.target.value) || 5 })
            }
          />
          <p className="text-xs text-muted-foreground">
            Number of search results to return (1-20)
          </p>
        </div>
      </div>

      {/* Test Search */}
      <div className="space-y-4 pt-4 border-t">
        <div className="space-y-2">
          <label htmlFor="test-query">Test Query</label>
          <Input
            id="test-query"
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder="Enter a test search query"
          />
        </div>

        <Button
          onClick={testSearch}
          disabled={testing || !isConfigured || !testQuery}
          className="w-full"
        >
          {testing ? (
            <>
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              Searching...
            </>
          ) : (
            <>
              <Search className="h-4 w-4 mr-2" />
              Test Search
            </>
          )}
        </Button>

        {!isConfigured && (
          <p className="text-xs text-yellow-500">
            Please configure your {settings.search.provider === 'brave' ? 'API key' : 'endpoint'} to test search
          </p>
        )}

        {testResult && (
          <div
            className={`p-4 rounded-lg ${
              testResult.success
                ? 'bg-green-500/10 border border-green-500/20'
                : 'bg-red-500/10 border border-red-500/20'
            }`}
          >
            {testResult.success && testResult.results ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-green-500">
                  <Check className="h-4 w-4" />
                  <span className="font-medium">
                    Found {testResult.results.length} results
                  </span>
                </div>
                <div className="space-y-2 text-sm">
                  {testResult.results.slice(0, 3).map((result, i) => (
                    <div key={i} className="border-l-2 border-muted pl-2">
                      <p className="font-medium truncate">{result.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {result.url}
                      </p>
                    </div>
                  ))}
                  {testResult.results.length > 3 && (
                    <p className="text-xs text-muted-foreground">
                      ...and {testResult.results.length - 3} more results
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-500">
                <X className="h-4 w-4" />
                <span>{testResult.error}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
