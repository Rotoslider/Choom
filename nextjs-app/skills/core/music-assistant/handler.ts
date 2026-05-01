import { BaseSkillHandler, type SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';

const TOOL_NAMES = new Set([
  'music_search',
  'music_play',
  'music_control',
  'music_now_playing',
  'music_players',
]);

const MA_ENDPOINT = process.env.MUSIC_ASSISTANT_URL || 'http://192.168.1.199:8095';
const MA_TOKEN = process.env.MUSIC_ASSISTANT_TOKEN || '';

let msgCounter = 0;

async function maCommand(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const token = MA_TOKEN;
  if (!token) throw new Error('Music Assistant token not configured. Set MUSIC_ASSISTANT_TOKEN in .env');

  const resp = await fetch(`${MA_ENDPOINT}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      message_id: String(++msgCounter),
      command,
      args,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Music Assistant API error (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (data && typeof data === 'object' && 'error_code' in data) {
    throw new Error(`MA error: ${data.error_code} — ${data.details || ''}`);
  }
  return data;
}

async function resolvePlayer(nameOrId?: string): Promise<{ player_id: string; name: string; queue_id: string }> {
  const players = await maCommand('players/all') as Array<Record<string, unknown>>;
  if (!players || players.length === 0) throw new Error('No music players available');

  if (!nameOrId) {
    const p = players.find(p => p.available) || players[0];
    return { player_id: p.player_id as string, name: p.name as string, queue_id: p.player_id as string };
  }

  const lower = nameOrId.toLowerCase();
  const match = players.find(p =>
    (p.player_id as string).toLowerCase() === lower ||
    (p.name as string).toLowerCase().includes(lower)
  );
  if (!match) {
    const names = players.map(p => `${p.name} (${p.player_id})`).join(', ');
    throw new Error(`Player "${nameOrId}" not found. Available: ${names}`);
  }
  return { player_id: match.player_id as string, name: match.name as string, queue_id: match.player_id as string };
}

export default class MusicAssistantHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, _ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      switch (toolCall.name) {
        case 'music_search': return await this.search(toolCall);
        case 'music_play': return await this.play(toolCall);
        case 'music_control': return await this.control(toolCall);
        case 'music_now_playing': return await this.nowPlaying(toolCall);
        case 'music_players': return await this.listPlayers(toolCall);
        default: return this.error(toolCall, `Unknown music tool: ${toolCall.name}`);
      }
    } catch (err) {
      return this.error(toolCall, err instanceof Error ? err.message : String(err));
    }
  }

  private async search(toolCall: ToolCall): Promise<ToolResult> {
    const query = toolCall.arguments.query as string;
    const typesStr = (toolCall.arguments.media_types as string) || 'artist,album,track,playlist,radio';
    const limit = (toolCall.arguments.limit as number) || 5;

    const mediaTypes = typesStr.split(',').map(t => t.trim()).filter(Boolean);

    const data = await maCommand('music/search', {
      search_query: query,
      media_types: mediaTypes,
      limit,
    }) as Record<string, Array<Record<string, unknown>>>;

    const results: Record<string, Array<Record<string, string>>> = {};
    let totalResults = 0;

    for (const [type, items] of Object.entries(data)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      results[type] = items.map(item => ({
        name: (item.name as string) || '?',
        uri: (item.uri as string) || '',
        id: String(item.item_id || ''),
        ...(item.artists ? { artist: (item.artists as Array<{ name: string }>).map(a => a.name).join(', ') } : {}),
        ...(item.album ? { album: ((item.album as Record<string, string>)?.name) || '' } : {}),
      }));
      totalResults += items.length;
    }

    return this.success(toolCall, {
      success: true,
      query,
      total_results: totalResults,
      results,
      message: totalResults > 0
        ? `Found ${totalResults} results for "${query}". Use the URI with music_play to play.`
        : `No results found for "${query}".`,
    });
  }

  private async play(toolCall: ToolCall): Promise<ToolResult> {
    const media = toolCall.arguments.media as string;
    const enqueue = (toolCall.arguments.enqueue as string) || 'play';
    const player = await resolvePlayer(toolCall.arguments.player as string | undefined);

    let mediaUri = media;
    let resolvedName = media;

    if (!media.includes('://')) {
      const searchResult = await maCommand('music/search', {
        search_query: media,
        media_types: ['artist', 'album', 'track', 'playlist', 'radio'],
        limit: 1,
      }) as Record<string, Array<Record<string, unknown>>>;

      let found: Record<string, unknown> | null = null;
      for (const items of Object.values(searchResult)) {
        if (Array.isArray(items) && items.length > 0) {
          found = items[0];
          break;
        }
      }
      if (!found) {
        return this.error(toolCall, `No music found for "${media}". Try a more specific search.`);
      }
      mediaUri = found.uri as string;
      resolvedName = (found.name as string) || media;
    }

    const enqueueMap: Record<string, string> = {
      play: 'play',
      next: 'next',
      add: 'add',
      replace: 'replace',
      replace_next: 'replace_next',
    };

    await maCommand('player_queues/play_media', {
      queue_id: player.queue_id,
      media: [mediaUri],
      option: enqueueMap[enqueue] || 'play',
    });

    return this.success(toolCall, {
      success: true,
      playing: resolvedName,
      uri: mediaUri,
      player: player.name,
      enqueue,
      message: `Now playing "${resolvedName}" on ${player.name}.`,
    });
  }

  private async control(toolCall: ToolCall): Promise<ToolResult> {
    const action = toolCall.arguments.action as string;
    const value = toolCall.arguments.value as number | undefined;
    const player = await resolvePlayer(toolCall.arguments.player as string | undefined);

    const cmdMap: Record<string, { cmd: string; args?: Record<string, unknown> }> = {
      play: { cmd: 'players/cmd/play' },
      pause: { cmd: 'players/cmd/pause' },
      stop: { cmd: 'players/cmd/stop' },
      next: { cmd: 'player_queues/next' },
      previous: { cmd: 'player_queues/previous' },
      volume_set: { cmd: 'players/cmd/volume_set', args: { volume_level: value ?? 50 } },
      volume_up: { cmd: 'players/cmd/volume_up' },
      volume_down: { cmd: 'players/cmd/volume_down' },
      shuffle: { cmd: 'player_queues/shuffle', args: { queue_id: player.queue_id } },
      repeat: { cmd: 'player_queues/repeat', args: { queue_id: player.queue_id } },
    };

    const entry = cmdMap[action];
    if (!entry) {
      return this.error(toolCall, `Unknown action "${action}". Use: ${Object.keys(cmdMap).join(', ')}`);
    }

    const isQueueCmd = entry.cmd.startsWith('player_queues/');
    const baseArgs = isQueueCmd
      ? { queue_id: player.queue_id }
      : { player_id: player.player_id };

    await maCommand(entry.cmd, { ...baseArgs, ...(entry.args || {}) });

    const desc = action === 'volume_set' ? `Volume set to ${value}` : action.charAt(0).toUpperCase() + action.slice(1);
    return this.success(toolCall, {
      success: true,
      action,
      player: player.name,
      message: `${desc} on ${player.name}.`,
    });
  }

  private async nowPlaying(toolCall: ToolCall): Promise<ToolResult> {
    const playerArg = toolCall.arguments.player as string | undefined;
    const players = await maCommand('players/all') as Array<Record<string, unknown>>;

    const targets = playerArg
      ? [players.find(p =>
          (p.player_id as string).toLowerCase() === playerArg.toLowerCase() ||
          (p.name as string).toLowerCase().includes(playerArg.toLowerCase())
        )].filter(Boolean)
      : players.filter(p => p.available);

    if (targets.length === 0) {
      return this.error(toolCall, playerArg ? `Player "${playerArg}" not found.` : 'No players available.');
    }

    const info = targets.map(p => {
      const media = p.current_media as Record<string, unknown> | null;
      return {
        player: p.name,
        player_id: p.player_id,
        state: p.playback_state,
        volume: p.volume_level,
        muted: p.volume_muted,
        ...(media ? {
          track: media.title || null,
          artist: media.artist || null,
          album: media.album || null,
          duration: media.duration || null,
          uri: media.uri || null,
        } : { track: null }),
      };
    });

    const playing = info.filter(i => i.state === 'playing');
    const summary = playing.length > 0
      ? playing.map(i => `"${i.track}" by ${i.artist} on ${i.player} (vol ${i.volume})`).join('; ')
      : 'Nothing is currently playing.';

    return this.success(toolCall, {
      success: true,
      players: info,
      message: summary,
    });
  }

  private async listPlayers(toolCall: ToolCall): Promise<ToolResult> {
    const players = await maCommand('players/all') as Array<Record<string, unknown>>;

    const list = players.map(p => ({
      name: p.name,
      player_id: p.player_id,
      available: p.available,
      state: p.playback_state,
      volume: p.volume_level,
      type: p.type,
    }));

    return this.success(toolCall, {
      success: true,
      players: list,
      count: list.length,
      message: `${list.length} player(s): ${list.map(p => `${p.name} (${p.state}, vol ${p.volume})`).join(', ')}`,
    });
  }
}
