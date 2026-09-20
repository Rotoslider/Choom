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

/** First non-empty string among the given argument names (schema name first, then the synonyms models actually send). */
export function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

export const CONTROL_ACTIONS = new Set(['play', 'pause', 'stop', 'next', 'previous', 'volume_set', 'volume_up', 'volume_down', 'shuffle', 'repeat']);

/** Map the verbs a model reaches for ("resume", "skip", "louder") onto the schema's action enum. */
export function normalizeControlAction(raw: string | undefined): string | undefined {
  const a = (raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!a) return undefined;
  if (CONTROL_ACTIONS.has(a)) return a;
  const synonyms: Record<string, string> = {
    resume: 'play', unpause: 'play', start: 'play', continue: 'play',
    skip: 'next', skip_next: 'next', next_track: 'next', forward: 'next',
    prev: 'previous', back: 'previous', previous_track: 'previous', skip_previous: 'previous', rewind: 'previous',
    volume: 'volume_set', set_volume: 'volume_set', volume_level: 'volume_set',
    louder: 'volume_up', up: 'volume_up', increase_volume: 'volume_up', volume_increase: 'volume_up', turn_up: 'volume_up',
    quieter: 'volume_down', down: 'volume_down', decrease_volume: 'volume_down', volume_decrease: 'volume_down', turn_down: 'volume_down', lower: 'volume_down',
    shuffle_on: 'shuffle', toggle_shuffle: 'shuffle',
    repeat_on: 'repeat', toggle_repeat: 'repeat', loop: 'repeat',
  };
  return synonyms[a] ?? a;
}

function playerResult(p: Record<string, unknown>) {
  return { player_id: p.player_id as string, name: (p.display_name || p.name) as string, queue_id: p.player_id as string };
}

function matchesPlayer(p: Record<string, unknown>, query: string): boolean {
  const lower = query.toLowerCase();
  const fields = [p.player_id, p.name, p.display_name].filter(Boolean).map(f => (f as string).toLowerCase());

  // Exact ID or substring match on any name field
  if (fields.some(f => f === lower || f.includes(lower))) return true;

  // Word-level match: all query words appear somewhere across fields
  const queryWords = lower.split(/\s+/).filter(w => w.length > 1);
  const allText = fields.join(' ');
  if (queryWords.length > 0 && queryWords.every(w => allText.includes(w))) return true;

  return false;
}

async function resolvePlayer(nameOrId?: string): Promise<{ player_id: string; name: string; queue_id: string }> {
  const players = await maCommand('players/all') as Array<Record<string, unknown>>;
  if (!players || players.length === 0) throw new Error('No music players available');

  if (!nameOrId) {
    const p = players.find(p => p.available) || players[0];
    return playerResult(p);
  }

  const match = players.find(p => matchesPlayer(p, nameOrId));
  if (match) return playerResult(match);

  // Single player available — use it rather than failing on a friendly name mismatch
  if (players.length === 1) {
    return playerResult(players[0]);
  }

  // The model invents speaker names it has never seen — "living_room",
  // "living room", "media_player.living_room" account for most failures here,
  // and none of them fuzzy-match the real devices. Hard-failing wastes the turn
  // over a parameter that was optional in the first place.
  //
  // If exactly one REAL speaker is available (browser/web players are not
  // speakers — they are whatever tab happens to be open), fall back to it and
  // say so, rather than erroring. The user asked for music; play music.
  const isBrowser = (p: Record<string, unknown>) =>
    /\b(web|browser|firefox|chrome|safari)\b/i.test(String(p.display_name || p.name || '')) ||
    String(p.provider || '').toLowerCase().includes('builtin');
  const realSpeakers = players.filter(p => p.available && !isBrowser(p));
  if (realSpeakers.length === 1) {
    console.log(`   🎵 Player "${nameOrId}" not found — falling back to the only real speaker: ${realSpeakers[0].display_name || realSpeakers[0].name}`);
    return playerResult(realSpeakers[0]);
  }

  const names = players.map(p => `${p.display_name || p.name} (${p.player_id})`).join(', ');
  throw new Error(`Player "${nameOrId}" not found. Available: ${names}. Omit the player parameter to use the default.`);
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
    const query = ((toolCall.arguments.query as string) || '').trim();
    const rawTypes = toolCall.arguments.media_types;
    const typesArr = Array.isArray(rawTypes) ? rawTypes.map(String) : ((rawTypes as string) || 'artist,album,track,playlist,radio').split(',');
    const limit = (toolCall.arguments.limit as number) || 5;

    const VALID_TYPES = new Set(['artist', 'album', 'track', 'playlist', 'radio']);
    const mediaTypes = typesArr.map(t => t.trim().toLowerCase()).filter(t => VALID_TYPES.has(t));
    if (mediaTypes.length === 0) mediaTypes.push('artist', 'album', 'track', 'playlist', 'radio');

    // Empty query → browse library items instead of searching
    if (!query) {
      return this.browseLibrary(toolCall, mediaTypes, limit);
    }

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
        ? `Found ${totalResults} results for "${query}". To play one, call music_play(media="<uri from these results>") — the parameter is named media.`
        : `No results found for "${query}".`,
    });
  }

  private async browseLibrary(toolCall: ToolCall, mediaTypes: string[], limit: number): Promise<ToolResult> {
    const typeToCommand: Record<string, string> = {
      artist: 'music/artists/library_items',
      album: 'music/albums/library_items',
      track: 'music/tracks/library_items',
      playlist: 'music/playlists/library_items',
      radio: 'music/radio/library_items',
    };

    const results: Record<string, Array<Record<string, string>>> = {};
    let totalResults = 0;

    for (const type of mediaTypes) {
      const cmd = typeToCommand[type];
      if (!cmd) continue;
      try {
        const items = await maCommand(cmd, { limit, offset: 0 }) as Array<Record<string, unknown>>;
        if (!Array.isArray(items) || items.length === 0) continue;
        results[type + 's'] = items.map(item => ({
          name: (item.name as string) || '?',
          uri: (item.uri as string) || '',
          id: String(item.item_id || ''),
          ...(item.artists ? { artist: (item.artists as Array<{ name: string }>).map(a => a.name).join(', ') } : {}),
        }));
        totalResults += items.length;
      } catch {
        // Some types may not have library items — skip silently
      }
    }

    return this.success(toolCall, {
      success: true,
      query: '(browse library)',
      total_results: totalResults,
      results,
      message: totalResults > 0
        ? `Found ${totalResults} items in the library. To play one, call music_play(media="<uri from these results>") — the parameter is named media.`
        : 'Library is empty or no items found for the requested types.',
    });
  }

  private async play(toolCall: ToolCall): Promise<ToolResult> {
    // The schema says `media`, but DeepSeek V4 Flash sent {uri: "library://track/90108"}
    // twice in a row (Aloy, 2026-09-20) and got "Cannot read properties of
    // undefined (reading 'includes')" back — a crash, not an error she could act
    // on. Take the obvious synonyms, and if nothing usable arrived say exactly
    // what to pass.
    const media = firstString(toolCall.arguments, ['media', 'uri', 'query', 'name', 'track', 'song', 'search', 'item', 'media_id', 'media_uri']);
    if (!media) {
      return this.error(toolCall, 'media is required — pass the artist, album, track or playlist NAME (e.g. media="Anne Bloom") or a uri copied from music_search results (media="library://track/123"). The parameter is named media, not uri or query.');
    }
    const enqueue = (toolCall.arguments.enqueue as string) || 'play';
    const player = await resolvePlayer(toolCall.arguments.player as string | undefined);

    let mediaUri = media;
    let resolvedName = media;

    if (media.includes('://')) {
      // A URI she did not get from music_search this turn is a guess:
      // "library://track/53768857" (no such item) made Music Assistant answer
      // 500 "Internal server error" with nothing to act on (2026-09-15).
      // Validate first so the reply says what to do instead.
      try {
        const item = await maCommand('music/item_by_uri', { uri: media }) as Record<string, unknown> | null;
        if (item && typeof item.name === 'string') resolvedName = item.name;
      } catch {
        return this.error(toolCall, `Nothing exists at "${media}" — that id is not in the library. Never guess a URI: pass the artist, album or track NAME as media (e.g. "Anne Bloom") and it will be found, or call music_search first and use a uri from its results.`);
      }
    } else {
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

    // A 200 from play_media means "queued", not "playing". Look once.
    let state = 'unknown';
    if ((enqueueMap[enqueue] || 'play') === 'play') {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const q = await maCommand('player_queues/get', { queue_id: player.queue_id }) as Record<string, unknown> | null;
        state = String(q?.state ?? 'unknown');
      } catch { /* leave unknown */ }
    }
    const started = state === 'playing' || (enqueueMap[enqueue] || 'play') !== 'play';

    return this.success(toolCall, {
      success: true,
      playing: resolvedName,
      uri: mediaUri,
      player: player.name,
      enqueue,
      player_state: state,
      message: started
        ? `Now playing "${resolvedName}" on ${player.name}.`
        : `Queued "${resolvedName}" on ${player.name}, but the speaker reports state "${state}" — it may not have started. Tell the user honestly; music_control(action="play") can retry.`,
    });
  }

  private async control(toolCall: ToolCall): Promise<ToolResult> {
    // Same story as play(): {command: "play"} arrived instead of {action: "play"}
    // and the reply was 'Unknown action "undefined"'. Accept the synonyms and
    // the everyday verbs, and validate BEFORE the player lookup so a bad call
    // costs no round-trip.
    const rawAction = firstString(toolCall.arguments, ['action', 'command', 'cmd', 'operation', 'op']);
    const action = normalizeControlAction(rawAction);
    const rawValue = toolCall.arguments.value ?? toolCall.arguments.volume ?? toolCall.arguments.level;
    const value = rawValue === undefined || rawValue === null || rawValue === '' ? undefined : Number(rawValue);
    const validActions = 'play, pause, stop, next, previous, volume_set, volume_up, volume_down, shuffle, repeat';
    if (!action) {
      return this.error(toolCall, `action is required. Call music_control(action="<one of: ${validActions}>") — the parameter is named action, not command.`);
    }
    if (!CONTROL_ACTIONS.has(action)) {
      return this.error(toolCall, `Unknown action "${rawAction}". Use: ${validActions}`);
    }
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
      return this.error(toolCall, `Unknown action "${action}". Use: ${validActions}`);
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

    let targets = playerArg
      ? players.filter(p => matchesPlayer(p, playerArg))
      : players.filter(p => p.available);

    // Single player fallback for friendly name mismatches
    if (targets.length === 0 && playerArg && players.length === 1) {
      targets = [players[0]];
    }

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
        track: media?.title ?? null,
        artist: media?.artist ?? null,
        album: media?.album ?? null,
        duration: media?.duration ?? null,
        uri: media?.uri ?? null,
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
      name: p.display_name || p.name,
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
