/**
 * A read after a change runs fresh (2026-10-26): Genesis cancelled her trip watch, re-listed her
 * followups, and was served the cached list from before the cancel.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { dropStaleReads } from '@/lib/tool-dedup';

const key = (name: string, args: object) => `${name}:${JSON.stringify(args).toLowerCase()}`;
const readOnly = new Set(['list_self_followups', 'search_memories']);

describe('dropStaleReads', () => {
  test('a change drops the cached reads and their repeat counts', () => {
    const cancel = key('cancel_self_followup', { id: 'sf_bb519317' });
    const cache = new Map<string, unknown>([
      [key('list_self_followups', {}), { count: 34 }],
      [key('search_memories', { query: 'trip' }), []],
      [cancel, { success: true, remaining: 33 }],
    ]);
    const hits = new Map<string, number>([[key('list_self_followups', {}), 1]]);
    dropStaleReads(readOnly, 'cancel_self_followup', cache, hits);
    expect([...cache.keys()]).toEqual([cancel]); // the same cancel again is still caught
    expect(hits.size).toBe(0);
  });

  test('a read leaves the cache alone', () => {
    const cache = new Map<string, unknown>([[key('list_self_followups', {}), { count: 34 }]]);
    dropStaleReads(readOnly, 'search_memories', cache);
    expect(cache.size).toBe(1);
  });

  test('the loop drops them after each call it caches', () => {
    const loop = readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8');
    expect(loop).toContain("import { dropStaleReads } from '@/lib/tool-dedup';");
    expect(loop).toMatch(/executedToolCache\.set\(dedupKey, result\.result\);\s*\}\s*(?:\/\/[^\n]*\n\s*)*dropStaleReads\(PARALLEL_SAFE, tc\.name, executedToolCache, dedupHitCounts\);/);
  });
});
