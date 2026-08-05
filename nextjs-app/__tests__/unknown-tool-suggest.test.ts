/**
 * Test: suggestToolNames — nearest-real-tool suggestions for hallucinated
 * tool names. The registry auto-corrects deterministic transforms; this
 * covers the semantic near-misses it correctly refuses to auto-execute.
 * Both primary cases are verbatim from the trace corpus (blank walls the
 * doctor's detector flagged): "read_memory" (Genesis 2026-08-01) and
 * "workspace_append_to_file" (2026-08-04).
 */
import { suggestToolNames } from '../lib/tool-name-suggest';

const TOOLS = [
  'remember', 'search_memories', 'get_recent_memories', 'get_memory_stats',
  'search_by_type', 'search_by_tags', 'search_by_date_range',
  'workspace_read_file', 'workspace_write_file', 'workspace_list_files',
  'workspace_create_folder', 'workspace_delete_file', 'workspace_read_pdf',
  'get_weather', 'get_weather_forecast', 'web_search', 'generate_image',
  'analyze_image', 'create_reminder', 'get_calendar_events', 'send_notification',
  'ha_get_state', 'ha_call_service', 'music_play', 'music_control',
];

describe('suggestToolNames', () => {
  test('read_memory suggests the real memory tools (corpus case)', () => {
    const s = suggestToolNames('read_memory', TOOLS);
    expect(s.length).toBeGreaterThan(0);
    expect(s.some(n => ['search_memories', 'get_recent_memories', 'remember', 'get_memory_stats'].includes(n))).toBe(true);
  });

  test('workspace_append_to_file suggests workspace file tools (corpus case)', () => {
    const s = suggestToolNames('workspace_append_to_file', TOOLS);
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]).toMatch(/^workspace_/);
    expect(s.some(n => n === 'workspace_write_file' || n === 'workspace_read_file')).toBe(true);
  });

  test('close single-token typo still finds its tool', () => {
    const s = suggestToolNames('generate_img', TOOLS);
    expect(s).toContain('generate_image');
  });

  test('gibberish with no token overlap suggests nothing', () => {
    const s = suggestToolNames('frobnicate_quux', TOOLS);
    expect(s).toEqual([]);
  });

  test('suggestions are capped at 3', () => {
    const s = suggestToolNames('search_memory_files', TOOLS);
    expect(s.length).toBeLessThanOrEqual(3);
  });

  test('exact-ish match ranks first over weaker overlaps', () => {
    const s = suggestToolNames('get_weather_forcast', TOOLS); // typo'd forecast
    expect(s[0]).toBe('get_weather_forecast');
  });
});
