/**
 * music-assistant — playing by mood. Genesis's 2026-09-27 trace: asked for
 * "music of your choice", she sent music_play "soft acoustic folk morning
 * playlist" and music_search 400-500 char mood descriptions. Music Assistant
 * matches names, so every call came back "No results" with nothing to act on;
 * she invented URIs and gave up after 21 iterations. A genre name now works
 * anywhere a name does and plays as an Endless Mix.
 */
import type { ToolCall, ToolResult } from '@/lib/types';
import { endlessMix, exactGenre, genreMenu, mentionedGenre, noMatchMessage, type LibraryGenre } from '@/skills/core/music-assistant/handler';

const g = (id: string, name: string, tracks: number, albums = 0, artists = 0): LibraryGenre =>
  ({ id, name, uri: `library://genre/${id}`, tracks, albums, artists });

const GENRES = [g('47', 'Rock', 9183, 325, 122), g('22', 'Folk', 65, 13, 3), g('42', 'R&b', 52, 4, 1), g('26', 'Hip Hop', 52), g('36', 'New Age', 192, 26, 5), g('29', 'Jazz', 0, 7, 3)];

describe('exactGenre', () => {
  it('matches a genre name however it is dressed up', () => {
    expect(exactGenre('Folk', GENRES)?.name).toBe('Folk');
    expect(exactGenre('some jazz', GENRES)?.name).toBe('Jazz');
    expect(exactGenre('rock music', GENRES)?.name).toBe('Rock');
    expect(exactGenre('R&B', GENRES)?.name).toBe('R&b');
    expect(exactGenre('hip-hop', GENRES)?.name).toBe('Hip Hop');
    expect(exactGenre('a new age playlist', GENRES)?.name).toBe('New Age');
  });

  it('leaves names that merely contain a genre to the name search', () => {
    expect(exactGenre('Iggy Pop', GENRES)).toBeUndefined();
    expect(exactGenre('soft acoustic folk', GENRES)).toBeUndefined();
    expect(exactGenre('music', GENRES)).toBeUndefined();
  });
});

describe('mentionedGenre', () => {
  it('finds the genre inside a mood description', () => {
    expect(mentionedGenre('soft acoustic folk morning playlist', GENRES)?.name).toBe('Folk');
  });

  it('takes the FIRST genre mentioned, which is what the description leads with', () => {
    const soup = 'soft acoustic folk mellow morning music playlist chill relaxing gentle guitar warm cozy jazz lounge smooth soul light pop indie rock';
    expect(mentionedGenre(soup, GENRES)?.name).toBe('Folk');
  });

  it('matches whole words only', () => {
    expect(mentionedGenre('folklore stories', GENRES)).toBeUndefined();
    expect(mentionedGenre('rocking chair ballads', GENRES)).toBeUndefined();
  });
});

describe('messages', () => {
  it('the no-match reply says why and lists the genres to pick from', () => {
    const m = noMatchMessage('x'.repeat(500), GENRES);
    expect(m).toMatch(/not moods or descriptions/);
    expect(m).toMatch(/music_play\(media="Rock"\)/);
    expect(m).toContain('Folk (65 tracks)');
    expect(m).toContain('Jazz (7 albums)');
    // A 500-char query is not echoed back in full
    expect(m.length).toBeLessThan(600);
  });

  it('genreMenu and endlessMix', () => {
    expect(genreMenu(GENRES.slice(0, 2))).toBe('Rock (9183 tracks), Folk (65 tracks)');
    expect(genreMenu([g('40', 'Psychedelic', 1), g('35', 'Musical', 0, 0, 1)])).toBe('Psychedelic (1 track), Musical (1 artist)');
    expect(endlessMix('library://genre/22')).toBe('radio_playlist://playlist/library://genre/22');
  });
});

describe('music_play and music_search against a fake Music Assistant', () => {
  const played: unknown[] = [];
  const realFetch = global.fetch;
  let handler: { execute: (c: ToolCall, ctx: never) => Promise<ToolResult> };

  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
    'players/all': () => [{ player_id: 'up1', display_name: 'Home Assistant Voice 0a567a', available: true, provider: 'universal_player' }],
    'music/genres/library_items': () => [
      { item_id: '22', name: 'Folk', uri: 'library://genre/22' },
      { item_id: '47', name: 'Rock', uri: 'library://genre/47' },
      { item_id: '29', name: 'Jazz', uri: 'library://genre/29' },
      { item_id: '125', name: 'News', uri: 'library://genre/125' },
    ],
    'music/genres/media_counts': () => ({
      22: { track: 65, album: 13, artist: 3 },
      47: { track: 9183, album: 325, artist: 122 },
      29: { track: 0, album: 7, artist: 3 },
      125: { track: 0, album: 0, artist: 0, podcast: 4 },
    }),
    'music/search': (a) => {
      const q = String(a.search_query).toLowerCase();
      const types = a.media_types as string[];
      if (q === 'bon jovi') return { artists: [{ name: 'Bon Jovi', uri: 'library://artist/2958' }], tracks: [] };
      if (q === 'americana' && types.includes('genre')) return { genres: [{ name: 'Ambient', uri: 'library://genre/2' }, { name: 'Folk', uri: 'library://genre/22' }] };
      if (q === 'folk') return { albums: [{ name: 'Chinese Folk Dark Melodic Techno', uri: 'library://album/1' }], genres: [{ name: 'Folk', uri: 'library://genre/22' }] };
      return { artists: [], albums: [], tracks: [], playlists: [], radio: [], genres: [] };
    },
    'music/item_by_uri': (a) => {
      if (a.uri === 'library://genre/22') return { name: 'Folk', media_type: 'genre', uri: a.uri };
      return { error_code: 999, details: 'not found' };
    },
    'music/artists/library_items': () => [{ name: 'The Corrs', uri: 'library://artist/3201' }],
    'music/albums/library_items': () => [{ name: 'Talk on Corners', uri: 'library://album/13337', artists: [{ name: 'The Corrs' }] }],
    'music/tracks/library_items': () => [{ name: 'Ferny Hill', uri: 'library://track/109141', artists: [{ name: 'The Chieftains', uri: 'library://artist/3200' }] }],
    'music/playlists/library_items': () => [{ name: 'Techno', uri: 'library://playlist/32' }],
    'player_queues/play_media': (a) => { played.push(a.media); return null; },
    'player_queues/get': () => ({ state: 'playing' }),
  };

  beforeAll(() => {
    process.env.MUSIC_ASSISTANT_TOKEN = 'test-token';
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      const { command, args } = JSON.parse(init?.body || '{}');
      const answer = answers[command];
      const data = answer ? answer(args) : { error_code: 0, details: `unmocked ${command}` };
      return { ok: true, status: 200, json: async () => data, text: async () => '' };
    }) as unknown as typeof fetch;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Handler = require('@/skills/core/music-assistant/handler').default;
      handler = new Handler();
    });
  });

  afterAll(() => {
    global.fetch = realFetch;
    delete process.env.MUSIC_ASSISTANT_TOKEN;
  });

  beforeEach(() => { played.length = 0; });

  const run = (name: string, args: Record<string, unknown>) => handler.execute({ id: 't', name, arguments: args }, {} as never);

  it("Genesis's exact call now plays the Folk mix instead of failing", async () => {
    const r = await run('music_play', { media: 'soft acoustic folk morning playlist', enqueue: 'play' });
    expect(r.error).toBeUndefined();
    expect(played).toEqual([['radio_playlist://playlist/library://genre/22']]);
    const res = r.result as { message: string; playing: string };
    expect(res.playing).toBe('Folk mix');
    expect(res.message).toMatch(/Now playing "Folk mix"/);
    expect(res.message).toMatch(/media="Folk"/);
  });

  it('a bare genre name plays that genre, even when an album title contains the word', async () => {
    const r = await run('music_play', { media: 'folk music', enqueue: 'add' });
    expect(r.error).toBeUndefined();
    expect(played).toEqual([['radio_playlist://playlist/library://genre/22']]);
  });

  it('a real name still plays by name', async () => {
    const r = await run('music_play', { media: 'Bon Jovi', enqueue: 'add' });
    expect(played).toEqual([['library://artist/2958']]);
    expect((r.result as { playing: string }).playing).toBe('Bon Jovi');
  });

  it("MA's genre aliases catch a style word no genre is named after", async () => {
    await run('music_play', { media: 'americana', enqueue: 'add' });
    expect(played).toEqual([['radio_playlist://playlist/library://genre/22']]);
  });

  it('a genre uri from music_search plays as the mix', async () => {
    await run('music_play', { media: 'library://genre/22', enqueue: 'add' });
    expect(played).toEqual([['radio_playlist://playlist/library://genre/22']]);
  });

  it('pure mood with no genre in it is an error that lists the genres, and plays nothing', async () => {
    const r = await run('music_play', { media: 'mellow gentle morning vibes' });
    expect(played).toEqual([]);
    expect(r.error).toMatch(/not moods or descriptions/);
    expect(r.error).toContain('Rock (9183 tracks), Folk (65 tracks), Jazz (7 albums)');
    expect(r.error).not.toContain('News');
  });

  it('a mood-soup search says what to do instead of just "No results"', async () => {
    const r = await run('music_search', { query: 'acoustic mellow morning music playlist chill relaxing gentle guitar warm cozy design work background', limit: 20 });
    const res = r.result as { total_results: number; message: string };
    expect(res.total_results).toBe(0);
    expect(res.message).toMatch(/search one name at a time/);
    expect(res.message).toMatch(/Genres in this library: Rock/);
  });

  it('an empty search shows the genres and a random sample, not the first names alphabetically', async () => {
    const r = await run('music_search', { query: '' });
    const res = r.result as { genres: string; results: Record<string, unknown[]> };
    expect(res.genres).toBe('Rock (9183 tracks), Folk (65 tracks), Jazz (7 albums)');
    expect(res.results.artists).toHaveLength(1);
    expect(res.results.playlists).toHaveLength(1);
  });

  it("searching a genre name shows who is in it, merging mapped artists with the tracks' artists", async () => {
    const r = await run('music_search', { query: 'Folk' });
    const res = r.result as { genre: { name: string; artists: Array<{ name: string }>; albums: unknown[]; play: string }; message: string };
    expect(res.genre.name).toBe('Folk');
    expect(res.genre.artists.map(a => a.name)).toEqual(['The Corrs', 'The Chieftains']);
    expect(res.genre.play).toBe('music_play(media="Folk")');
    expect(res.message).toMatch(/endless shuffled mix/);
  });
});
