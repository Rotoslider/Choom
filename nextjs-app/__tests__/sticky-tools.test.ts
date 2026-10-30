/**
 * 2026-10-29: in skills mode the tool list followed each message (Eve: 31
 * tools one turn, 30 the next), and the list comes first in the prompt, so
 * the prompt cache never matched. A conversation now keeps its tools.
 */
import { stickyToolNames } from '@/lib/tool-exposure';

const store = () => new Map<string, Set<string>>();

describe('stickyToolNames', () => {
  test('a conversation only gains tools, so after a few turns the list stops changing', () => {
    const s = store();
    const t1 = stickyToolNames('eve:chat1', ['search_memories', 'get_weather', 'analyze_image'], 48, s);
    expect(t1.added).toBe(3);
    const t2 = stickyToolNames('eve:chat1', ['search_memories', 'ha_get_state', 'ha_get_history'], 48, s);
    expect([...t2.names].sort()).toEqual(['analyze_image', 'get_weather', 'ha_get_history', 'ha_get_state', 'search_memories']);
    expect(t2.added).toBe(2);
    const t3 = stickyToolNames('eve:chat1', ['get_weather', 'ha_get_state'], 48, s);
    expect(t3.added).toBe(0); // nothing new: same list as last turn
    expect(t3.names).toEqual(t2.names);
  });

  test('past the cap it starts over from this turn', () => {
    const s = store();
    stickyToolNames('c', ['a', 'b', 'c', 'd'], 5, s);
    const r = stickyToolNames('c', ['e', 'f'], 5, s);
    expect(r.reset).toBe(true);
    expect([...r.names]).toEqual(['e', 'f']);
  });

  test('conversations are kept apart', () => {
    const s = store();
    stickyToolNames('aloy:main', ['ha_get_camera_snapshot'], 48, s);
    const g = stickyToolNames('genesis:main', ['web_search'], 48, s);
    expect([...g.names]).toEqual(['web_search']);
  });
});
