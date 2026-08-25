/**
 * Skill-injection relevance thresholds — the "music_control keeps getting
 * shoved at us" incident (2026-08-25).
 *
 * Two engines misfired at once:
 *   1. matchSkills injected music-assistant's Level-2 docs into unrelated
 *      conversations because ONE description word ("control", "assistant",
 *      "play") scored +1 and anything > 0 made the top-3 cut. Once the chooms
 *      started COMPLAINING about it, "music control" in the transcript gave a
 *      +20 tool-name hit every turn — self-reinforcing.
 *   2. suggestToolNames answered a hallucinated "remote_control" (SSH work!)
 *      with "Did you mean: music_control?" via an exact single-token match.
 *
 * The floor now: pattern match (+5) or tool-name mention (+10) required;
 * description overlap alone caps at +2. Suggestions need ≥2 token agreement
 * or a near-exact full name.
 */
import { getSkillRegistry } from '../lib/skill-registry';
import { loadCoreSkills } from '../lib/skill-loader';
import { suggestToolNames } from '../lib/tool-name-suggest';

const registry = getSkillRegistry();

beforeAll(() => {
  // Next.js startup calls this once; jest starts with an empty registry.
  loadCoreSkills();
});

const skillNames = (msg: string): string[] => registry.matchSkills(msg, 3).map(s => s.metadata.name);

describe('matchSkills relevance floor', () => {
  test('a lone incidental word does NOT inject music docs', () => {
    // SSH/pie-room style messages that merely brush a description word.
    for (const msg of [
      'who controls the schedule today',
      'the assistant should verify the hash',
      'remote control of the tower cam',
      'play back the logs from last night',
    ]) {
      expect(skillNames(msg)).not.toContain('music-assistant');
    }
  });

  test('genuine music intent still injects', () => {
    expect(skillNames('play some jazz on the kitchen speaker')).toContain('music-assistant');
    expect(skillNames('pause the music')).toContain('music-assistant');
    expect(skillNames("what's on the playlist right now")).toContain('music-assistant');
    expect(skillNames('use music_control to skip this track')).toContain('music-assistant');
  });

  test('other skills keep their strong signals', () => {
    expect(skillNames("what's the weather tomorrow")).toContain('weather-forecasting');
    expect(skillNames('remember that Donny hates cilantro')).toContain('memory-management');
    expect(skillNames('run this python snippet')).toContain('code-execution');
    expect(skillNames('check my google tasks list')).toContain('google-tasks');
  });

  test('discussing a tool by name is still honored (strong signal)', () => {
    expect(skillNames('music control keeps misfiring')).toContain('music-assistant');
  });
});

describe('suggestToolNames generic-token bar', () => {
  const TOOLS = [
    'remember', 'search_memories', 'get_recent_memories',
    'workspace_read_file', 'workspace_write_file', 'workspace_list_files',
    'get_weather_forecast', 'generate_image', 'web_search',
    'ha_get_state', 'ha_call_service',
    'music_play', 'music_control', 'music_search',
  ];

  test('hallucinated remote_control does NOT suggest music_control', () => {
    const s = suggestToolNames('remote_control', TOOLS);
    expect(s).not.toContain('music_control');
  });

  test('file_control / device_control do not route to music either', () => {
    expect(suggestToolNames('file_control', TOOLS)).not.toContain('music_control');
    expect(suggestToolNames('device_control', TOOLS)).not.toContain('music_control');
  });

  test('near-exact music names still resolve', () => {
    expect(suggestToolNames('music_contol', TOOLS)).toContain('music_control');   // typo, dist 1
    // A near-miss inside the music family may suggest several music tools —
    // what must NEVER happen is a CROSS-DOMAIN redirect (music → ssh, etc.).
    const s = suggestToolNames('music_player', TOOLS);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every(n => n.startsWith('music_'))).toBe(true);
  });

  test('corpus cases keep working (multi-token agreement)', () => {
    expect(suggestToolNames('read_memory', TOOLS).length).toBeGreaterThan(0);
    expect(suggestToolNames('workspace_append_to_file', TOOLS)[0]).toMatch(/^workspace_/);
  });
});
