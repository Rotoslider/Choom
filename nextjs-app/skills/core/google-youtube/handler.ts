import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { getGoogleClient } from '@/lib/google-client';

const YOUTUBE_TOOLS = new Set([
  'search_youtube',
  'get_video_details',
  'get_channel_info',
  'get_playlist_items',
]);

export default class GoogleYouTubeHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return YOUTUBE_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'search_youtube':
        return this.searchYouTube(toolCall);
      case 'get_video_details':
        return this.getVideoDetails(toolCall);
      case 'get_channel_info':
        return this.getChannelInfo(toolCall);
      case 'get_playlist_items':
        return this.getPlaylistItems(toolCall);
      default:
        return this.error(toolCall, `Unknown YouTube tool: ${toolCall.name}`);
    }
  }

  private async searchYouTube(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const query = toolCall.arguments.query as string;
      const maxResults = Math.min((toolCall.arguments.max_results as number) || 10, 50);
      const type = (toolCall.arguments.type as string) || 'video';

      if (!query) return this.error(toolCall, 'query is required');

      const client = getGoogleClient();
      const results = await client.searchYouTube(query, maxResults, type);

      const formatted = results.length === 0
        ? 'No results found.'
        : results.map(r =>
            `- ${r.title} | ${r.channelTitle} | https://youtube.com/watch?v=${r.videoId}`
          ).join('\n');

      console.log(`   ▶️ YouTube: ${results.length} results for "${query}"`);
      return this.success(toolCall, { success: true, results, formatted, count: results.length });
    } catch (err) {
      console.error('   ❌ YouTube search error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `YouTube search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async getVideoDetails(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const videoId = toolCall.arguments.video_id as string;
      if (!videoId) return this.error(toolCall, 'video_id is required');

      const client = getGoogleClient();
      const video = await client.getVideoDetails(videoId);

      console.log(`   ▶️ YouTube: got details for "${video.title}"`);
      return this.success(toolCall, { success: true, video });
    } catch (err) {
      console.error('   ❌ YouTube video details error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `YouTube video details failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async getChannelInfo(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const channelId = toolCall.arguments.channel_id as string;
      if (!channelId) return this.error(toolCall, 'channel_id is required');

      const client = getGoogleClient();
      const channel = await client.getChannelInfo(channelId);

      console.log(`   ▶️ YouTube: got channel info for "${channel.title}"`);
      return this.success(toolCall, { success: true, channel });
    } catch (err) {
      console.error('   ❌ YouTube channel info error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `YouTube channel info failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async getPlaylistItems(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const playlistId = toolCall.arguments.playlist_id as string;
      const maxResults = Math.min((toolCall.arguments.max_results as number) || 20, 50);

      if (!playlistId) return this.error(toolCall, 'playlist_id is required');

      const client = getGoogleClient();
      const items = await client.getPlaylistItems(playlistId, maxResults);

      const formatted = items.length === 0
        ? 'No items in playlist.'
        : items.map((item, i) =>
            `${i + 1}. ${item.title} | ${item.channelTitle} | https://youtube.com/watch?v=${item.videoId}`
          ).join('\n');

      console.log(`   ▶️ YouTube: ${items.length} items in playlist ${playlistId}`);
      return this.success(toolCall, { success: true, items, formatted, count: items.length });
    } catch (err) {
      console.error('   ❌ YouTube playlist error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `YouTube playlist failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
