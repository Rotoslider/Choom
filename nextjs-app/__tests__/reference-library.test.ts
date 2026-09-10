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

// 16x16, not 4x4: libvips 8.18.x fails a 4x4 PNG through
// rotate().resize().png() with "vipspng: libpng read error", while the same
// chain succeeds from 16x16 up. That is a fixture artefact, not a bug in
// storeImage — real uploads are never that small.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGElEQVQokWOoiLIhCTGMaogaDaWK4Zo0AMdDDhBBWdBNAAAAAElFTkSuQmCC',
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
    { id: 'sub-genesis', slug: 'genesis', name: 'Genesis', category: 'character', choomId: 'choom-genesis', description: 'Genesis, blonde, glasses', choom: null, images: GENESIS },
    { id: 'sub-eve', slug: 'eve', name: 'Eve', category: 'character', choomId: 'choom-eve', description: 'Eve, blonde, blue eyes', choom: null, images: EVE },
    { id: 'sub-owner', slug: 'owner', name: 'Owner', category: 'person', choomId: null, description: 'Owner, tall', choom: null, images: OWNER },
    { id: 'sub-house', slug: 'cabin-exterior', name: 'Cabin exterior', category: 'place', choomId: null, description: 'Cabin exterior', choom: null, images: HOUSE },
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
    // genesis(2) + owner(2) + cabin(1): all fit under the cap, nothing shed.
    expect(result.images).toHaveLength(5);
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

  it('resolves the decorated slugs models actually send', async () => {
    // Observed live: asked for "genesis" and "donny", the model sent
    // "genesis_reference" and "donny_reference", and both were dropped.
    // (fixtures call the owner subject "owner".)
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['genesis_reference', 'owner_reference', 'eve sheet'],
    });
    expect(res.used.map((u) => u.slug).sort()).toEqual(['eve', 'genesis', 'owner']);
    expect(res.unknown).toEqual([]);
  });

  it('does NOT collapse an era slug onto the base subject', async () => {
    // "genesis-2026" must stay unknown when no such subject exists. Silently
    // resolving it to "genesis" would hand back the wrong decade's face, which
    // is worse than reporting the miss.
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['genesis-2031'],
    });
    expect(res.used.map((u) => u.slug)).not.toContain('genesis');
    expect(res.unknown).toEqual(['genesis-2031']);
  });

  it('orders references the way the prompt introduces people', async () => {
    // Observed live: a four-person portrait resolved aloy, eve, genesis, donny
    // while the prompt read Donny, Eve, Aloy, Genesis — and only the first
    // reference came out looking right, because Flux.2 bleeds features from
    // earlier references onto later ones.
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['genesis', 'eve', 'owner'],
      prompt: 'Owner stands on the left, Eve beside him, Genesis on the right.',
    });
    expect(res.used.map((u) => u.slug)).toEqual(['owner', 'eve', 'genesis']);
  });

  it('leaves order alone when the prompt names nobody', async () => {
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['eve', 'owner'],
      isSelfPortrait: true,
      prompt: 'a warm photo at golden hour on the porch',
    });
    // Bare selfie prompt: the Choom's own subject still leads.
    expect(res.used[0]?.slug).toBe('genesis');
  });

  it('keeps sheet and face for everyone while the cap allows it', async () => {
    // Three people at sheet+face is six images — comfortably under the cap of
    // eight, so nothing is shed. (An earlier rule cut everyone to one image at
    // three subjects; that came from a 20GB card and threw sheets away for
    // nothing on a card with headroom.)
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['genesis', 'eve', 'owner'],
    });
    expect(res.used).toHaveLength(3);
    expect(res.images).toHaveLength(6);
    for (const u of res.used) expect(u.images).toHaveLength(2);
  });

  it('sheds sheets from the back before dropping anyone', async () => {
    // genesis(2) + eve(2) + owner(2) = 6 against a cap of 5: the LAST-named
    // subject loses its sheet and keeps its face. Nobody is dropped.
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['genesis', 'eve', 'owner'],
      maxReferences: 5,
    });
    expect(res.used.map((u) => u.slug)).toEqual(['genesis', 'eve', 'owner']);
    expect(res.images).toHaveLength(5);
    expect(res.used[0].images).toHaveLength(2);
    expect(res.used[1].images).toHaveLength(2);
    expect(res.used[2].images.map((i) => i.kind)).toEqual(['face']);
    expect(res.truncated).toBe(false);
  });

  it('keeps the sheet as well when only one or two subjects are in frame', async () => {
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['genesis', 'eve'],
    });
    expect(res.used).toHaveLength(2);
    expect(res.images).toHaveLength(4);
  });

  it('attaches a subject the prompt names but references omitted', async () => {
    // Observed: "aloy and donny, intimate night portrait ... donny tall and
    // rugged" resolved to aloy alone, so the man was painted from imagination.
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: [],
      isSelfPortrait: true,
      prompt: 'genesis and owner sitting on the porch steps at night under the stars',
    });
    expect(res.used.map((u) => u.slug).sort()).toEqual(['genesis', 'owner']);
  });

  it('does not fire on a word that merely contains a subject name', async () => {
    // "eve" inside "evening" must not drag Eve into a solo portrait — these
    // prompts are full of golden hours and evenings.
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: [],
      isSelfPortrait: true,
      prompt: 'a quiet evening on the porch, whatever the weather',
    });
    expect(res.used.map((u) => u.slug)).toEqual(['genesis']);
  });

  it('seats references left to right when the prompt says where people sit', async () => {
    // Reference order is placement: the first reference lands leftmost. A
    // prompt that lists "Owner, Eve and Genesis" but seats Genesis on the left
    // must send Genesis first, or her face ends up in someone else's seat.
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['owner', 'eve', 'genesis'],
      prompt: 'Owner, Eve and Genesis on the bench. Owner in the middle in a cream sweater. '
        + 'Genesis on the left in a rust cardigan. Eve on the right in a dark henley.',
    });
    expect(res.used.map((u) => u.slug)).toEqual(['genesis', 'owner', 'eve']);
  });

  it('falls back to mention order unless everyone has a seat', async () => {
    // "to Eve's right" is a relation, not a seat; nothing says where Owner is.
    const res = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['owner', 'eve', 'genesis'],
      prompt: 'Owner laughing, Eve beside him, Genesis standing to Eve\'s right.',
    });
    expect(res.used.map((u) => u.slug)).toEqual(['owner', 'eve', 'genesis']);
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

  it('sheds a sheet rather than dropping the person', async () => {
    // genesis(2) + eve(2) = 4 against a cap of 3: Eve keeps her face and loses
    // her sheet. She is still in the picture.
    const result = await resolveReferences({
      choomId: 'choom-genesis',
      isSelfPortrait: true,
      requested: ['eve'],
      maxReferences: 3,
    });
    expect(result.used.map((u) => u.slug)).toEqual(['genesis', 'eve']);
    expect(result.used[0].images).toHaveLength(2);
    expect(result.used[1].images.map((i) => i.kind)).toEqual(['face']);
    expect(result.images).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it('drops whole subjects only once everyone is already down to one image', async () => {
    // Cap of 2 for three people: every sheet goes first, and only then is the
    // last-named subject dropped entirely.
    const result = await resolveReferences({
      choomId: 'choom-genesis',
      requested: ['genesis', 'eve', 'owner'],
      maxReferences: 2,
    });
    expect(result.used.map((u) => u.slug)).toEqual(['genesis', 'eve']);
    for (const u of result.used) expect(u.images.map((i) => i.kind)).toEqual(['face']);
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
