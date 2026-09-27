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

// Music Assistant search matches NAMES. Asked for "music of your choice",
// Genesis (2026-09-27) sent music_search 400-500 char mood descriptions —
// "soft acoustic folk mellow morning … rain sounds ocean waves" — got
// "No results" every time, then built URIs out of the wrong artist ids and
// gave up after 21 iterations. The library's genre index (MA 2.10) is the
// handle for mood, so a genre name works anywhere a name does and plays as an
// Endless Mix: a dynamic playlist that refills itself until stopped.

export interface LibraryGenre {
  id: string;
  name: string;
  uri: string;
  tracks: number;
  albums: number;
  artists: number;
}

const GENRE_TTL_MS = 10 * 60_000;
let genreCache: { at: number; genres: LibraryGenre[] } | null = null;

/** Music genres with something in them, biggest first. Cached: the index changes on library scans, not per call. */
async function libraryGenres(): Promise<LibraryGenre[]> {
  if (genreCache && Date.now() - genreCache.at < GENRE_TTL_MS) return genreCache.genres;
  const items = (await maCommand('music/genres/library_items', { limit: 500 }) as Array<Record<string, unknown>>) || [];
  const ids = items.map(g => String(g.item_id));
  const counts = ids.length
    ? await maCommand('music/genres/media_counts', { genre_ids: ids }) as Record<string, Record<string, number>>
    : {};
  const genres = items
    .map(g => {
      const c = counts[String(g.item_id)] || {};
      return { id: String(g.item_id), name: String(g.name), uri: String(g.uri), tracks: c.track || 0, albums: c.album || 0, artists: c.artist || 0 };
    })
    // Podcast and audiobook genres ("News", "True Crime") share the index but hold no music.
    .filter(g => g.tracks + g.albums + g.artists > 0)
    .sort((a, b) => b.tracks - a.tracks || b.albums - a.albums);
  genreCache = { at: Date.now(), genres };
  return genres;
}

/** Lowercase words only, so "R&b", "Hip-Hop" and "hip hop" compare equal. */
const plainWords = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Words that dress a genre up without changing it: "folk music", "some jazz", "a rock playlist".
const GENRE_FILLER = /\b(?:some|a|an|the|music|songs?|tunes|playlist|mix|radio|station|genre)\b/g;

/** The library genre a phrase IS: "Folk", "some jazz", "rock music". */
export function exactGenre(text: string, genres: LibraryGenre[]): LibraryGenre | undefined {
  const core = plainWords(text).replace(GENRE_FILLER, ' ').replace(/\s+/g, ' ').trim();
  if (!core) return undefined;
  return genres.find(g => plainWords(g.name) === core);
}

/** The first library genre a description MENTIONS: "soft acoustic folk morning playlist" → Folk. */
export function mentionedGenre(text: string, genres: LibraryGenre[]): LibraryGenre | undefined {
  const hay = ` ${plainWords(text)} `;
  let best: { genre: LibraryGenre; at: number } | undefined;
  for (const genre of genres) {
    const at = hay.indexOf(` ${plainWords(genre.name)} `);
    if (at !== -1 && (!best || at < best.at)) best = { genre, at };
  }
  return best?.genre;
}

/** MA's own genre search, which knows the aliases: "americana" → Country, "easy listening" → Pop. */
async function aliasGenre(text: string, genres: LibraryGenre[]): Promise<LibraryGenre | undefined> {
  const data = await maCommand('music/search', { search_query: text, media_types: ['genre'], limit: 5 }) as Record<string, Array<Record<string, unknown>>>;
  for (const hit of data?.genres ?? []) {
    const genre = genres.find(g => g.uri === hit.uri);
    if (genre) return genre;
  }
  return undefined;
}

/** Music Assistant's Endless Mix of a seed item: a dynamic playlist that keeps refilling. */
export const endlessMix = (seedUri: string) => `radio_playlist://playlist/${seedUri}`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "9183 tracks", or "7 albums" for a genre filed by album (Jazz). */
const genreSize = (g: LibraryGenre) => (g.tracks ? count(g.tracks, 'track') : g.albums ? count(g.albums, 'album') : count(g.artists, 'artist'));

/** "Rock (9183 tracks), Jazz (7 albums), …" — the menu a mood gets picked from. */
export function genreMenu(genres: LibraryGenre[]): string {
  return genres.map(g => `${g.name} (${genreSize(g)})`).join(', ');
}

/** A long query echoed back in full is just noise in the next prompt. */
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const exampleGenre = (genres: LibraryGenre[]) => genres[0]?.name ?? 'Jazz';

export function noMatchMessage(text: string, genres: LibraryGenre[]): string {
  return `Nothing in the library is named "${clip(text)}". Music Assistant matches NAMES of artists, albums, tracks and playlists, not moods or descriptions, so search one name at a time. `
    + `To play by mood, pass a genre as media, e.g. music_play(media="${exampleGenre(genres)}"): it plays an endless shuffled mix of that genre. `
    + (genres.length ? `Genres in this library: ${genreMenu(genres)}.` : '');
}

type MediaItem = Record<string, unknown>;

const itemSummary = (item: MediaItem) => ({
  name: (item.name as string) || '?',
  uri: (item.uri as string) || '',
  ...(Array.isArray(item.artists) && item.artists.length ? { artist: (item.artists as Array<{ name: string }>).map(a => a.name).join(', ') } : {}),
  ...(item.album ? { album: ((item.album as Record<string, string>)?.name) || '' } : {}),
});

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
    const typesGiven = rawTypes !== undefined && rawTypes !== null && rawTypes !== '';
    const typesArr = Array.isArray(rawTypes) ? rawTypes.map(String) : ((rawTypes as string) || '').split(',');
    const limit = Number(toolCall.arguments.limit) || 0;

    const VALID_TYPES = new Set(['artist', 'album', 'track', 'playlist', 'radio', 'genre']);
    const mediaTypes = typesArr.map(t => t.trim().toLowerCase().replace(/s$/, '')).filter(t => VALID_TYPES.has(t));

    // Empty query → what is in the library to choose from
    if (!query) {
      return this.browseLibrary(toolCall, typesGiven && mediaTypes.length ? mediaTypes : null, limit || 15);
    }
    if (mediaTypes.length === 0) mediaTypes.push(...VALID_TYPES);

    const [data, genres] = await Promise.all([
      maCommand('music/search', { search_query: query, media_types: mediaTypes, limit: limit || 5 }) as Promise<Record<string, Array<MediaItem>>>,
      libraryGenres().catch(() => [] as LibraryGenre[]),
    ]);

    const results: Record<string, Array<Record<string, string>>> = {};
    let totalResults = 0;
    for (const [type, items] of Object.entries(data)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      // A genre match only counts when the library has music filed under it.
      const kept = type === 'genres' ? items.filter(i => genres.some(g => g.uri === i.uri)) : items;
      if (kept.length === 0) continue;
      results[type] = kept.map(itemSummary);
      totalResults += kept.length;
    }

    // "Folk" is a genre as well as a word in album titles: show what the genre holds.
    const genre = exactGenre(query, genres);
    const genreContents = genre ? await this.genreContents(genre, limit || 10) : undefined;

    const found = totalResults > 0 || genreContents;
    return this.success(toolCall, {
      success: true,
      query: clip(query),
      total_results: totalResults,
      results,
      ...(genreContents ? { genre: genreContents } : {}),
      message: !found
        ? noMatchMessage(query, genres)
        : genre
          ? `"${genre.name}" is a genre (${genreSize(genre)}). music_play(media="${genre.name}") plays an endless shuffled mix of it, or pick an artist or album from genre.artists / genre.albums and play its uri.`
          : `Found ${totalResults} results for "${clip(query)}". To play one, call music_play(media="<uri from these results>") — the parameter is named media.`,
    });
  }

  /** A random handful of the artists and albums filed under a genre, for picking one. */
  private async genreContents(genre: LibraryGenre, limit: number) {
    const filter = { genre: [Number(genre.id)], order_by: 'random' };
    const [artists, albums, tracks] = await Promise.all([
      maCommand('music/artists/library_items', { ...filter, limit }) as Promise<MediaItem[]>,
      maCommand('music/albums/library_items', { ...filter, limit }) as Promise<MediaItem[]>,
      // Tracks are mapped far more often than artists (Folk: 65 tracks, 3 artists),
      // so their artists fill out the list.
      maCommand('music/tracks/library_items', { ...filter, limit: limit * 4 }) as Promise<MediaItem[]>,
    ]);
    const artistList = new Map<string, { name: string; uri: string }>();
    for (const a of [...(artists || []), ...(tracks || []).flatMap(t => (t.artists as MediaItem[]) || [])]) {
      if (artistList.size >= limit) break;
      if (typeof a.uri === 'string' && !artistList.has(a.uri)) artistList.set(a.uri, { name: String(a.name), uri: a.uri });
    }
    return {
      name: genre.name,
      tracks: genre.tracks,
      play: `music_play(media="${genre.name}")`,
      artists: [...artistList.values()],
      albums: (albums || []).map(itemSummary),
    };
  }

  private async browseLibrary(toolCall: ToolCall, mediaTypes: string[] | null, limit: number): Promise<ToolResult> {
    const typeToCommand: Record<string, string> = {
      artist: 'music/artists/library_items',
      album: 'music/albums/library_items',
      track: 'music/tracks/library_items',
      playlist: 'music/playlists/library_items',
      radio: 'music/radios/library_items',
    };

    // The old browse listed the first five of everything alphabetically —
    // "1200 Micrograms", "2002", "2 Fabiola" — nothing to choose music by.
    // Genres plus a random handful of artists are.
    const genres = await libraryGenres().catch(() => [] as LibraryGenre[]);
    const results: Record<string, Array<Record<string, string>>> = {};
    let totalResults = 0;
    for (const type of mediaTypes ?? ['artist', 'playlist']) {
      const cmd = typeToCommand[type];
      if (!cmd) continue;
      try {
        const items = await maCommand(cmd, { limit, offset: 0, order_by: 'random' }) as MediaItem[];
        if (!Array.isArray(items) || items.length === 0) continue;
        results[type + 's'] = items.map(itemSummary);
        totalResults += items.length;
      } catch {
        // Some types may not have library items — skip silently
      }
    }

    return this.success(toolCall, {
      success: true,
      query: '(browse library)',
      genres: genreMenu(genres),
      total_results: totalResults,
      results,
      message: `A random sample of the library, with its genres. To play by mood, pass a genre as media: music_play(media="${exampleGenre(genres)}") plays an endless shuffled mix. `
        + 'music_search(query="<genre>") shows the artists and albums in a genre; searching again gives a different sample. To play an artist or album, use its uri as media.',
    });
  }

  /**
   * What a music_play media string means. In order: a uri; a genre name
   * ("Folk", "some jazz"); an artist/album/track/playlist name; a description
   * that mentions a genre ("soft acoustic folk morning") or one MA's genre
   * aliases know ("americana"). Anything else is an error that lists the genres.
   */
  private async resolveMedia(media: string): Promise<{ uri: string; name: string; note?: string } | { error: string }> {
    const genreMix = (g: LibraryGenre) => ({ uri: endlessMix(g.uri), name: `${g.name} mix` });

    if (media.includes('://')) {
      // A URI she did not get from music_search this turn is a guess:
      // "library://track/53768857" (no such item) made Music Assistant answer
      // 500 "Internal server error" with nothing to act on (2026-09-15).
      // Validate first so the reply says what to do instead.
      let item: MediaItem | null;
      try {
        item = await maCommand('music/item_by_uri', { uri: media }) as MediaItem | null;
      } catch {
        return { error: `Nothing exists at "${clip(media)}" — that id is not in the library. Never guess a URI: pass the artist, album or track NAME as media (e.g. "Anne Bloom") or a genre (e.g. "Folk"), or call music_search first and use a uri from its results.` };
      }
      const name = typeof item?.name === 'string' ? item.name : media;
      // A genre uri from music_search plays the way a genre name does.
      if (item?.media_type === 'genre') return { uri: endlessMix(media), name: `${name} mix` };
      return { uri: media, name };
    }

    const genres = await libraryGenres().catch(() => [] as LibraryGenre[]);
    const exact = exactGenre(media, genres);
    if (exact) return genreMix(exact);

    const searchResult = await maCommand('music/search', {
      search_query: media,
      media_types: ['artist', 'album', 'track', 'playlist', 'radio'],
      limit: 1,
    }) as Record<string, Array<MediaItem>>;
    for (const items of Object.values(searchResult)) {
      if (Array.isArray(items) && items.length > 0) {
        return { uri: items[0].uri as string, name: (items[0].name as string) || media };
      }
    }

    const mentioned = mentionedGenre(media, genres) ?? await aliasGenre(media, genres).catch(() => undefined);
    if (mentioned) {
      return { ...genreMix(mentioned), note: `Nothing in the library is named "${clip(media)}", so this is the ${mentioned.name} genre instead: an endless shuffled mix. Next time pass the genre directly: media="${mentioned.name}".` };
    }
    return { error: noMatchMessage(media, genres) };
  }

  private async play(toolCall: ToolCall): Promise<ToolResult> {
    // The schema says `media`, but DeepSeek V4 Flash sent {uri: "library://track/90108"}
    // twice in a row (Aloy, 2026-09-20) and got "Cannot read properties of
    // undefined (reading 'includes')" back — a crash, not an error she could act
    // on. Take the obvious synonyms, and if nothing usable arrived say exactly
    // what to pass.
    const media = firstString(toolCall.arguments, ['media', 'uri', 'query', 'name', 'track', 'song', 'search', 'item', 'media_id', 'media_uri', 'genre']);
    if (!media) {
      return this.error(toolCall, 'media is required — pass the artist, album, track or playlist NAME (e.g. media="Anne Bloom"), a genre (media="Folk"), or a uri copied from music_search results (media="library://track/123"). The parameter is named media, not uri or query.');
    }
    const enqueue = (toolCall.arguments.enqueue as string) || 'play';
    const player = await resolvePlayer(toolCall.arguments.player as string | undefined);

    const target = await this.resolveMedia(media);
    if ('error' in target) return this.error(toolCall, target.error);

    const enqueueMap: Record<string, string> = {
      play: 'play',
      next: 'next',
      add: 'add',
      replace: 'replace',
      replace_next: 'replace_next',
    };

    await maCommand('player_queues/play_media', {
      queue_id: player.queue_id,
      media: [target.uri],
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
      playing: target.name,
      uri: target.uri,
      player: player.name,
      enqueue,
      player_state: state,
      message: (started
        ? `Now playing "${target.name}" on ${player.name}.`
        : `Queued "${target.name}" on ${player.name}, but the speaker reports state "${state}" — it may not have started. Tell the user honestly; music_control(action="play") can retry.`)
        + (target.note ? ` ${target.note}` : ''),
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
