/**
 * music-assistant handler — argument tolerance. Aloy's 2026-09-20 trace:
 * music_play({uri}) crashed with "Cannot read properties of undefined
 * (reading 'includes')" and music_control({command}) answered
 * 'Unknown action "undefined"'. Neither told her what to change.
 */
import MusicAssistantHandler, { firstString, normalizeControlAction } from '@/skills/core/music-assistant/handler';
import type { ToolCall } from '@/lib/types';

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 't1', name, arguments: args });
const ctx = {} as never;

describe('music handler argument tolerance', () => {
  const h = new MusicAssistantHandler();

  it('music_play with no media says which parameter to pass instead of crashing', async () => {
    const r = await h.execute(call('music_play', {}), ctx);
    expect(r.error).toMatch(/media is required/);
    expect(r.error).toMatch(/named media, not uri/);
  });

  it('music_play accepts uri as a synonym for media (gets past validation)', async () => {
    const r = await h.execute(call('music_play', { uri: 'library://track/90108' }), ctx);
    // Validation passed; the next step is the Music Assistant call, which
    // has no token in the test env — that is the expected failure here.
    expect(r.error).not.toMatch(/media is required|reading 'includes'/);
  });

  it('music_control with no action names the parameter and the valid values', async () => {
    const r = await h.execute(call('music_control', {}), ctx);
    expect(r.error).toMatch(/action is required/);
    expect(r.error).toMatch(/named action, not command/);
    expect(r.error).toMatch(/volume_set/);
  });

  it('music_control rejects a truly unknown verb with the list', async () => {
    const r = await h.execute(call('music_control', { action: 'explode' }), ctx);
    expect(r.error).toMatch(/Unknown action "explode"/);
  });

  it('music_control accepts command as a synonym for action', async () => {
    const r = await h.execute(call('music_control', { command: 'play', player: 'Home Assistant Voice 0a567a' }), ctx);
    expect(r.error).not.toMatch(/Unknown action|action is required/);
  });
});

describe('normalizeControlAction', () => {
  it('passes schema values through', () => {
    expect(normalizeControlAction('pause')).toBe('pause');
    expect(normalizeControlAction('Volume_Set')).toBe('volume_set');
  });
  it('maps everyday verbs onto the enum', () => {
    expect(normalizeControlAction('resume')).toBe('play');
    expect(normalizeControlAction('skip')).toBe('next');
    expect(normalizeControlAction('prev')).toBe('previous');
    expect(normalizeControlAction('louder')).toBe('volume_up');
    expect(normalizeControlAction('turn down')).toBe('volume_down');
    expect(normalizeControlAction('set volume')).toBe('volume_set');
  });
  it('returns undefined for nothing', () => {
    expect(normalizeControlAction(undefined)).toBeUndefined();
    expect(normalizeControlAction('  ')).toBeUndefined();
  });
});

describe('firstString', () => {
  it('prefers the schema name, then synonyms, skipping blanks', () => {
    expect(firstString({ media: '', uri: 'x' }, ['media', 'uri'])).toBe('x');
    expect(firstString({ media: 'a', uri: 'x' }, ['media', 'uri'])).toBe('a');
    expect(firstString({}, ['media'])).toBeUndefined();
  });
});
