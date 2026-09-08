import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const TEST_ROOT = mkdtempSync(path.join(tmpdir(), 'choom-lib-'));
process.env.REFERENCE_IMAGES_ROOT = TEST_ROOT;

// The library reads subjects from Prisma and images from disk. Stub Prisma so
// the resolution rules — ordering, auto-attach, grouping, the cap — are tested
// without a database.
const findMany = jest.fn();
jest.mock('@/lib/db', () => ({
  __esModule: true,
  default: { referenceSubject: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import { saveLibraryImage } from '../lib/reference-images';
import { resolveReferences, buildReferenceCatalog } from '../lib/reference-library';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8//8/AzGAiYFIMKoQPwAAtDkDA1x9AoIAAAAASUVORK5CYII=',
  'base64'
);

/** Put real files on disk for a subject so resolution has something to load. */
async function seed(subjectId: string, count: number) {
  const files: { id: string; file: string; kind: string; enabled: boolean; order: number }[] = [];
  for (let i = 0; i < count; i++) {
    const stored = await saveLibraryImage(subjectId, TINY_PNG);
    files.push({
      id: `${subjectId}-img${i}`,
      file: stored.file,
      kind: i === 0 ? 'sheet' : 'face',
      enabled: true,
      order: i,
    });
  }
  return files;
}

let GENESIS: Awaited<ReturnType<typeof seed>>;
let EVE: Awaited<ReturnType<typeof seed>>;
let OWNER: Awaited<ReturnType<typeof seed>>;
let HOUSE: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  GENESIS = await seed('sub-genesis', 2);
  EVE = await seed('sub-eve', 2);
  OWNER = await seed('sub-owner', 2);
  HOUSE = await seed('sub-house', 1);
});

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function library() {
  return [
    { id: 'sub-genesis', slug: 'genesis', name: 'Genesis', category: 'character', choomId: 'choom-genesis', images: GENESIS },
    { id: 'sub-eve', slug: 'eve', name: 'Eve', category: 'character', choomId: 'choom-eve', images: EVE },
    { id: 'sub-owner', slug: 'owner', name: 'Owner', category: 'person', choomId: null, images: OWNER },
    { id: 'sub-house', slug: 'cabin-exterior', name: 'Cabin exterior', category: 'place', choomId: null, images: HOUSE },
  ];
}

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue(library());
});

describe('reference resolution', () => {
  it('auto-attaches the Choom own subject on a self-portrait, sheet first', async () => {
    const result = await resolveReferences({ choomId: 'choom-genesis', isSelfPortrait: true });

    expect(result.used.map(u => u.slug)).toEqual(['genesis']);
    // Sheet then face — order is meaningful to Flux.2.
    expect(result.used[0].images.map(i => i.kind)).toEqual(['sheet', 'face']);
    expect(result.images).toHaveLength(2);
  });

  it('puts the Choom own subject before the ones it named', async () => {
    const result = await resolveReferences({
      choomId: 'choom-genesis',
      isSelfPortrait: true,
      requested: ['owner', 'cabin-exterior'],
    });

    expect(result.used.map(u => u.slug)).toEqual(['genesis', 'owner', 'cabin-exterior']);
    expect(result.images).toHaveLength(5); // 2 + 2 + 1
  });

  it('lets one Choom reference another (Genesis with her sister Eve)', async () => {
    const result = await resolveReferences({
      choomId: 'choom-genesis',
      isSelfPortrait: true,
      requested: ['eve'],
    });

    expect(result.used.map(u => u.slug)).toEqual(['genesis', 'eve']);
  });

  it('does not auto-attach on a general image', async () => {
    const result = await resolveReferences({
      choomId: 'choom-genesis',
      isSelfPortrait: false,
      requested: ['cabin-exterior'],
    });

    expect(result.used.map(u => u.slug)).toEqual(['cabin-exterior']);
  });

  it('tolerates the loose names models actually emit', async () => {
    const result = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['Cabin Exterior', 'cabin_exterior', 'Genesis'],
    });

    // All three resolve, and the duplicate collapses.
    expect(result.used.map(u => u.slug)).toEqual(['cabin-exterior', 'genesis']);
    expect(result.unknown).toEqual([]);
  });

  it('reports names that match nothing instead of failing', async () => {
    const result = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['eve', 'the-cabin-in-vermont'],
    });

    expect(result.used.map(u => u.slug)).toEqual(['eve']);
    expect(result.unknown).toEqual(['the-cabin-in-vermont']);
    expect(result.images).toHaveLength(2);
  });

  it('trims whole subjects at the cap so a sheet is never split from its face', async () => {
    const result = await resolveReferences({
      choomId: 'choom-genesis',
      isSelfPortrait: true,
      requested: ['eve', 'owner'],
      maxReferences: 5,
    });

    // genesis(2) + eve(2) = 4; owner(2) would make 6, so owner drops entirely.
    expect(result.used.map(u => u.slug)).toEqual(['genesis', 'eve']);
    expect(result.images).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing when the library is empty', async () => {
    findMany.mockResolvedValue([]);
    const result = await resolveReferences({ choomId: 'choom-genesis', isSelfPortrait: true });
    expect(result).toEqual({ images: [], used: [], unknown: [], truncated: false });
  });

  it('skips a subject whose images are all disabled', async () => {
    findMany.mockResolvedValue(
      library().map(s => (s.slug === 'eve' ? { ...s, images: [] } : s))
    );
    const result = await resolveReferences({ choomId: 'choom-genesis', requested: ['eve'] });
    expect(result.used).toEqual([]);
    expect(result.images).toEqual([]);
  });
});

describe('catalogue offered to the model', () => {
  it('lists slug, category and description, skipping imageless subjects', async () => {
    findMany.mockResolvedValue([
      { slug: 'genesis', name: 'Genesis', description: 'Genesis, blonde AI companion', category: 'character', _count: { images: 2 } },
      { slug: 'blue-pickup', name: 'Blue pickup', description: null, category: 'object', _count: { images: 1 } },
      { slug: 'empty', name: 'Nothing here', description: 'x', category: 'place', _count: { images: 0 } },
    ]);

    const catalog = await buildReferenceCatalog();

    expect(catalog).toEqual([
      '"genesis" (character) — Genesis, blonde AI companion',
      // Falls back to the display name when there is no description.
      '"blue-pickup" (object) — Blue pickup',
    ]);
  });
});
