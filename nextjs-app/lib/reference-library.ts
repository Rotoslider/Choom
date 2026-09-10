/**
 * The shared reference-image library.
 *
 * A *subject* is a thing a Choom can name in a `generate_image` call — a
 * character, a person, a place, a vehicle. Each subject holds one or more
 * images (a character sheet, a face closeup, another angle). Naming a subject
 * sends all of its enabled images, in order, so "genesis" contributes the sheet
 * and then the face closeup: on a multi-panel sheet the face is only a small
 * fraction of the pixels, and the closeup is what sharpens the likeness.
 *
 * The library is global — every Choom can name every subject — because the
 * whole point is scenes like "Genesis with her sister Eve camping", where one
 * Choom needs another Choom's sheet.
 */
import prisma from '@/lib/db';
import { readLibraryImage } from '@/lib/reference-images';

/** Hard ceiling on references per image: each one costs a VAE encode and VRAM. */
export const MAX_REFERENCES_PER_IMAGE = 8;

export interface ResolvedSubject {
  slug: string;
  name: string;
  category: string;
  /** What this subject actually looks like, for the prompt roster. */
  appearance: string;
  images: { id: string; file: string; kind: string }[];
}

export interface ResolvedReferences {
  /** Base64 payloads in the order Forge should receive them. */
  images: string[];
  /** Subjects that made it in, in order — for logging and the tool result. */
  used: ResolvedSubject[];
  /** True when the prompt gave every subject a seat and references were sorted by it. */
  seated: boolean;
  /** Names the model asked for that matched nothing. */
  unknown: string[];
  /** True when the cap trimmed the request. */
  truncated: boolean;
}

type SubjectRow = {
  id: string;
  slug: string;
  name: string;
  category: string;
  choomId: string | null;
  description: string | null;
  choom: { imageSettings: string | null } | null;
  images: { id: string; file: string; kind: string; enabled: boolean; order: number }[];
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Match what the model asked for against a subject. Models are inconsistent
 * about slugs — "Cabin (exterior)", "cabin_exterior" and
 * "the cabin exterior" should all land on `cabin-exterior` — so
 * match the normalised slug first, then the normalised display name.
 */
function matchSubject(request: string, subjects: SubjectRow[]): SubjectRow | undefined {
  const wanted = normalize(request);
  if (!wanted) return undefined;
  return (
    subjects.find((s) => normalize(s.slug) === wanted) ||
    subjects.find((s) => normalize(s.name) === wanted) ||
    // Models decorate slugs: asked for "genesis", they send "genesis_reference"
    // or "eve_sheet". Strip a trailing word from a KNOWN vocabulary only, then
    // retry the exact match. Deliberately not a general suffix rule — an era
    // slug like "genesis-2026" must stay unknown when it does not exist rather
    // than quietly resolving to "genesis" and returning the wrong decade.
    (() => {
      const stripped = wanted.replace(
        /-(reference|references|ref|refs|sheet|sheets|image|images|img|photo|photos|portrait|pic|pics)$/,
        '',
      );
      if (stripped === wanted || !stripped) return undefined;
      return (
        subjects.find((s) => normalize(s.slug) === stripped) ||
        subjects.find((s) => normalize(s.name) === stripped)
      );
    })() ||
    // Last resort: a unique prefix match, so "genesis" finds "genesis-choom".
    (() => {
      const hits = subjects.filter(
        (s) => normalize(s.slug).startsWith(wanted) || normalize(s.name).startsWith(wanted)
      );
      return hits.length === 1 ? hits[0] : undefined;
    })()
  );
}

async function loadSubjects(): Promise<SubjectRow[]> {
  return prisma.referenceSubject.findMany({
    where: { enabled: true },
    select: {
      id: true,
      slug: true,
      name: true,
      category: true,
      choomId: true,
      description: true,
      choom: { select: { imageSettings: true } },
      images: {
        where: { enabled: true },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, file: true, kind: true, enabled: true, order: true },
      },
    },
    orderBy: { slug: 'asc' },
  });
}

/**
 * Resolve the references for one generation.
 *
 * A Choom's own subject is prepended automatically on self-portraits, so
 * selfies keep working from a bare prompt with no reference argument, and the
 * subject of the image stays first — reference order is meaningful to Flux.2.
 */
export async function resolveReferences(options: {
  choomId: string;
  requested?: string[];
  isSelfPortrait?: boolean;
  maxReferences?: number;
  /** The image prompt, used to order references the way the prompt reads. */
  prompt?: string;
}): Promise<ResolvedReferences> {
  const { choomId, requested = [], isSelfPortrait = false, prompt = '' } = options;
  const cap = options.maxReferences ?? MAX_REFERENCES_PER_IMAGE;

  const subjects = await loadSubjects();
  if (subjects.length === 0) {
    return { images: [], used: [], seated: false, unknown: [], truncated: false };
  }

  let ordered: SubjectRow[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];

  const push = (subject: SubjectRow | undefined) => {
    if (!subject || seen.has(subject.id) || subject.images.length === 0) return;
    seen.add(subject.id);
    ordered.push(subject);
  };

  // The Choom itself goes first on a self-portrait.
  if (isSelfPortrait) {
    push(subjects.find((s) => s.choomId === choomId));
  }

  for (const request of requested) {
    if (typeof request !== 'string' || !request.trim()) continue;
    const subject = matchSubject(request, subjects);
    if (subject) {
      push(subject);
    } else {
      unknown.push(request);
    }
  }

  // A subject named in the prompt but left out of `references` still needs its
  // reference images. Observed: "aloy and donny, intimate night portrait ...
  // donny tall and rugged with salt-and-pepper beard" resolved to aloy alone, so
  // the man was painted from imagination — no error, nothing unknown, just a
  // person who did not look like himself. Naming someone in the prompt is a
  // clear enough signal of intent to attach them.
  if (prompt.trim()) {
    for (const subject of subjects) {
      if (seen.has(subject.id) || subject.images.length === 0) continue;
      // Word boundaries matter: "eve" must not fire on "evening", and these
      // prompts are full of them. Two-character names are skipped as too risky.
      const candidates = [subject.slug, subject.name]
        .filter((v) => v && v.replace(/[^A-Za-z0-9]/g, '').length >= 3)
        .map((v) => v.replace(/[-_]+/g, ' ').trim());
      for (const c of candidates) {
        const re = new RegExp(`(^|[^a-z0-9])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
        if (re.test(prompt)) {
          push(subject);
          break;
        }
      }
    }
  }

  // Reference order is meaningful to Flux.2: features bleed from earlier
  // references onto later ones unless the prompt introduces people in the same
  // order. Models do not naturally do that — a four-person portrait resolved
  // aloy, eve, genesis, donny while the prompt read Donny, Eve, Aloy, Genesis,
  // and only the first reference came out right. Rather than asking the model to
  // keep two lists in sync, sort the references to match the prompt.
  if (prompt.trim() && ordered.length > 1) {
    const haystack = prompt.toLowerCase();
    const mentionAt = (subject: SubjectRow): number => {
      const needles = [subject.slug, subject.name]
        .filter(Boolean)
        .map((v) => v.toLowerCase().replace(/[-_]+/g, ' '));
      let best = Infinity;
      for (const n of needles) {
        if (!n) continue;
        const i = haystack.indexOf(n);
        if (i !== -1 && i < best) best = i;
      }
      return best;
    };
    const positions = new Map(ordered.map((sub) => [sub.id, mentionAt(sub)]));
    // Stable: subjects the prompt never names keep their existing relative order
    // at the end, so a bare-prompt selfie still leads with the Choom herself.
    ordered = ordered
      .map((sub, i) => ({ sub, i }))
      .sort((a, b) => {
        const pa = positions.get(a.sub.id) ?? Infinity;
        const pb = positions.get(b.sub.id) ?? Infinity;
        return pa === pb ? a.i - b.i : pa - pb;
      })
      .map((e) => e.sub);
  }

  // Reference order IS left-to-right placement. Tested on Forge with a fixed
  // seed: whichever subject is the first reference lands in the leftmost seat,
  // and the prompt then dresses that seat — so "Genesis on the left" with the
  // references sent Aloy-first produced Aloy's face in Genesis's cardigan.
  // Reordering the references (and the roster, which is read the same way) to
  // match the described seating put all three people in the right place.
  //
  // When the prompt states where everyone sits, sort by that. Only when every
  // subject has a position; a half-sorted list is worse than mention order.
  let seated = false;
  if (prompt.trim() && ordered.length > 1) {
    const text = prompt;
    const nameForms = (sub: SubjectRow) =>
      [sub.slug, sub.name]
        .filter(Boolean)
        .map((v) => v.replace(/[-_]+/g, ' ').trim())
        .filter((v) => v.replace(/[^A-Za-z0-9]/g, '').length >= 3);
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A seat word and where it sits in a chunk; the nearest one to the name wins.
    const SEAT = /(?:on|to|at|from) the (?:far )?(left|right)\b|\b(left|right)(?:most| side)\b|\bin the (middle|center|centre)\b|\b(between)\b|\b(LEFT|MIDDLE|CENTER|CENTRE|RIGHT|BACK)\s*:|\b(behind|back row|in the back|in back)\b/gi;
    const seatIn = (chunk: string, pickLast: boolean): number | undefined => {
      let found: { at: number; seat: number } | undefined;
      for (const m of chunk.matchAll(SEAT)) {
        const word = (m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || '').toLowerCase();
        // Back row sorts after the front row: four-person tests placed the
        // person "standing behind" correctly as the last reference.
        const seat = word === 'left' ? 0 : word === 'right' ? 2 : /back|behind/.test(word) ? 3 : 1;
        const at = m.index ?? 0;
        if (!found || (pickLast ? at > found.at : at < found.at)) found = { at, seat };
      }
      return found?.seat;
    };
    const seatOf = (subject: SubjectRow): number | undefined => {
      const others = ordered.filter((o) => o.id !== subject.id).flatMap(nameForms);
      const otherRe = others.length
        ? new RegExp(`(^|[^a-z0-9])(?:${others.map(esc).join('|')})(?=[^a-z0-9]|$)`, 'i')
        : null;
      let best: { dist: number; seat: number } | undefined;
      for (const n of nameForms(subject)) {
        const re = new RegExp(`(^|[^a-z0-9])${esc(n)}(?=[^a-z0-9]|$)`, 'gi');
        for (const m of text.matchAll(re)) {
          const at = (m.index ?? 0) + m[1].length;
          // Same clause only: stop at punctuation or at another subject's name,
          // or "Eve and Genesis on the bench. Owner in the middle" hands Eve
          // the middle seat.
          let after = text.slice(at + n.length, at + n.length + 90);
          const stopA = after.search(/[.!?;]/);
          if (stopA !== -1) after = after.slice(0, stopA);
          const oa = otherRe ? after.search(otherRe) : -1;
          if (oa !== -1) after = after.slice(0, oa);
          let before = text.slice(Math.max(0, at - 60), at);
          const stopB = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf(';'));
          if (stopB !== -1) before = before.slice(stopB + 1);
          const a = seatIn(after, false);
          if (a !== undefined && (!best || best.dist > 0)) best = { dist: 0, seat: a };
          const b = seatIn(before, true);
          if (b !== undefined && !best) best = { dist: 1, seat: b };
        }
      }
      return best?.seat;
    };
    const seats = ordered.map((sub) => seatOf(sub));
    seated = seats.every((seat) => seat !== undefined);
    if (seated) {
      ordered = ordered
        .map((sub, i) => ({ sub, i, seat: seats[i] as number }))
        .sort((a, b) => (a.seat === b.seat ? a.i - b.i : a.seat - b.seat))
        .map((e) => e.sub);
    }
  }

  // Every subject starts with all of its enabled images, in stored order. When
  // the total exceeds the cap, shed from the BACK: the last-mentioned subject
  // loses its least important image (an extra, then its sheet), then the one
  // before it, and so on. A face is never shed while the subject still has one —
  // on a multi-panel sheet the face is a small fraction of the pixels, so the
  // crop is the stronger likeness signal. Only when everyone is already down to
  // a single image and it still does not fit are whole subjects dropped from
  // the end.
  //
  // So a four-person portrait sends sheet+face for all four (8), and adding the
  // truck costs the last-named person their sheet, not their face.
  //
  // This replaces a rule that cut everyone to one image at three subjects. That
  // came from a 20GB card where six reference latents OOMed with Klein
  // resident; on a card with headroom it threw sheets away for no reason. The
  // cap is the lever if the generator moves back to a small card.
  const rank = (k: string) => (k === 'face' ? 0 : k === 'sheet' ? 1 : 2);
  const budgeted = ordered.map((subject) => ({ ...subject, images: [...subject.images] }));
  const total = () => budgeted.reduce((n, sub) => n + sub.images.length, 0);

  while (total() > cap) {
    const victim = [...budgeted].reverse().find((sub) => sub.images.length > 1);
    if (!victim) break;
    let worst = 0;
    victim.images.forEach((img, i) => {
      if (rank(img.kind) >= rank(victim.images[worst].kind)) worst = i;
    });
    victim.images.splice(worst, 1);
  }
  let truncated = false;
  while (total() > cap && budgeted.length > 0) {
    budgeted.pop();
    truncated = true;
  }

  const used: ResolvedSubject[] = [];
  const files: { subjectId: string; file: string }[] = [];
  for (const subject of budgeted) {
    used.push({
      slug: subject.slug,
      name: subject.name,
      category: subject.category,
      appearance: choomAppearance(subject.choom?.imageSettings ?? null) || (subject.description ?? '').trim(),
      images: subject.images.map((i) => ({ id: i.id, file: i.file, kind: i.kind })),
    });
    for (const image of subject.images) {
      files.push({ subjectId: subject.id, file: image.file });
    }
  }

  const loaded = await Promise.all(
    files.map(async ({ subjectId, file }) => {
      try {
        return (await readLibraryImage(subjectId, file)).toString('base64');
      } catch (err) {
        console.warn(
          `   ⚠️ Library reference unavailable (${file}): ${err instanceof Error ? err.message : err}`
        );
        return null;
      }
    })
  );

  return {
    images: loaded.filter((b): b is string => b !== null),
    used,
    seated,
    unknown,
    truncated,
  };
}

/**
 * The canonical look of a Choom, from the characterPrompt on her self-portrait
 * settings. This is the description the reference images actually depict, so it
 * belongs in the catalogue — otherwise a Choom describing a *different* Choom
 * has nothing to go on and makes one up.
 */
function choomAppearance(imageSettings: string | null): string {
  if (!imageSettings) return '';
  try {
    const parsed = JSON.parse(imageSettings) as Record<string, { characterPrompt?: string }>;
    const raw = parsed?.selfPortrait?.characterPrompt?.trim();
    if (!raw) return '';
    // characterPrompts are written as raw SD prompts, so they carry parenthetical
    // weighting like "(cinematic)". Strip those and tidy the punctuation, but
    // leave the words alone — aggressive keyword filtering turned
    // "(cinematic) photo of girl, Long blonde wavy hair" into "of girl" and threw
    // away the very detail the line exists to convey.
    return raw
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s*,\s*(?=,|$)/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
      .slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * The catalogue the model sees, as one line per subject. This is injected into
 * the `generate_image` schema per request, so a Choom always sees the current
 * library without a round trip to look it up.
 */
export async function buildReferenceCatalog(): Promise<string[]> {
  const subjects = await prisma.referenceSubject.findMany({
    where: { enabled: true },
    select: {
      slug: true,
      name: true,
      description: true,
      category: true,
      // A subject that IS a Choom already has a canonical appearance in her
      // image settings. Fold it into the catalogue line so the model does not
      // have to guess: told only "Eve character sheet and close up portrait" it
      // invented "long dark brown hair" for a blonde Choom, and the invented
      // description then beat the reference image.
      choom: { select: { imageSettings: true } },
      _count: { select: { images: true } },
    },
    orderBy: [{ category: 'asc' }, { slug: 'asc' }],
  });

  return subjects
    .filter((s) => s._count.images > 0)
    .map((s) => {
      const description = s.description?.trim();
      const appearance = choomAppearance(s.choom?.imageSettings ?? null);
      const detail = [description || s.name, appearance].filter(Boolean).join('. ');
      return `"${s.slug}" (${s.category}) — ${detail}`;
    });
}
