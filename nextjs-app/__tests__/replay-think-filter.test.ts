/**
 * C-24-style replay oracle: run every real assistant message from the local
 * DB through createThinkFilter at several chunk sizes and assert
 * chunking-invariance — the filter must produce byte-identical output no
 * matter where the stream splits. This is the check that would have caught
 * both the C-20 split-'</tool_call>' bug and the C-43 split/unpaired
 * '</think>' leak before they shipped.
 *
 * Skips (with a warning) when prisma/dev.db or python3 is unavailable, so
 * the suite still runs on a fresh checkout.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { createThinkFilter } from '../lib/tool-call-parsing';

const DB = path.join(__dirname, '..', 'prisma', 'dev.db');
const CHUNK_SIZES = [1, 3, 7, 17, 64];

function loadCorpus(): string[] | null {
  if (!existsSync(DB)) return null;
  try {
    const out = execFileSync(
      'python3',
      ['-c', [
        'import sqlite3, json, sys',
        `db = sqlite3.connect(${JSON.stringify(DB)})`,
        "rows = db.execute(\"SELECT content FROM Message WHERE role='assistant' AND content IS NOT NULL AND length(content) > 0\").fetchall()",
        'json.dump([r[0] for r in rows], sys.stdout)',
      ].join('\n')],
      { maxBuffer: 256 * 1024 * 1024 },
    ).toString();
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function runFilter(text: string, chunkSize: number): string {
  const f = createThinkFilter();
  let out = '';
  for (let i = 0; i < text.length; i += chunkSize) {
    out += f(text.slice(i, i + chunkSize));
  }
  return out;
}

describe('think filter replay over real assistant messages', () => {
  const corpus = loadCorpus();

  (corpus ? it : it.skip)('is chunking-invariant on the whole corpus', () => {
    expect(corpus!.length).toBeGreaterThan(0);
    let checked = 0;
    for (const msg of corpus!) {
      const whole = runFilter(msg, msg.length || 1);
      for (const size of CHUNK_SIZES) {
        const chunked = runFilter(msg, size);
        if (chunked !== whole) {
          throw new Error(
            `Chunk size ${size} diverged from whole-string pass on message: ${msg.slice(0, 120)}...`,
          );
        }
      }
      checked++;
    }
    console.log(`   replayed ${checked} messages × ${CHUNK_SIZES.length} chunk sizes`);
  });

  (corpus ? it : it.skip)('never leaves a think tag in the output', () => {
    for (const msg of corpus!) {
      const out = runFilter(msg, 7);
      expect(out).not.toContain('<think>');
      expect(out).not.toContain('</think>');
    }
  });
});
