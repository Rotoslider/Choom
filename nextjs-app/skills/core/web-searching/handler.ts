import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { WebSearchService } from '@/lib/web-search';
import type { SearchSettings, ToolCall, ToolResult } from '@/lib/types';

const defaultSearchSettings: SearchSettings = {
  provider: 'brave',
  braveApiKey: process.env.BRAVE_API_KEY || '',
  searxngEndpoint: process.env.SEARXNG_ENDPOINT || '',
  maxResults: 5,
};

const TOOL_NAMES = new Set(['web_search']);

export default class WebSearchHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'web_search':
        return this.handleWebSearch(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown web search tool: ${toolCall.name}`);
    }
  }

  private async handleWebSearch(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const searchSettings: SearchSettings = {
        ...defaultSearchSettings,
        ...(ctx.settings?.search as object),
      };

      console.log(`   🔍 Search settings: provider=${searchSettings.provider}, braveApiKey=${searchSettings.braveApiKey ? '***' + searchSettings.braveApiKey.slice(-4) : '(empty)'}, searxng=${searchSettings.searxngEndpoint || '(empty)'}`);

      if (searchSettings.provider === 'brave' && !searchSettings.braveApiKey) {
        throw new Error('Brave Search API key not configured. Set BRAVE_API_KEY in .env or configure in Settings > Search.');
      }
      if (searchSettings.provider === 'searxng' && !searchSettings.searxngEndpoint) {
        throw new Error('SearXNG endpoint not configured. Set SEARXNG_ENDPOINT in .env or configure in Settings > Search.');
      }

      const query = toolCall.arguments.query as string;
      const maxResults = toolCall.arguments.max_results as number | undefined;

      console.log(`   🔍 Executing web search: "${query}"`);

      const searchService = new WebSearchService(searchSettings);
      const searchResponse = await searchService.search(query, maxResults);

      const formattedResults = searchResponse.results
        .map((r, i) => `${i + 1}. **[${r.title}](${r.url})**\n   ${r.snippet}`)
        .join('\n\n');

      return this.success(toolCall, {
        success: true,
        query: searchResponse.query,
        totalResults: searchResponse.totalResults,
        results: searchResponse.results,
        formatted: formattedResults,
      });
    } catch (searchError) {
      return this.error(toolCall, `Web search failed: ${searchError instanceof Error ? searchError.message : 'Unknown error'}`);
    }
  }
}
