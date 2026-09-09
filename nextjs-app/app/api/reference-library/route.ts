import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

const CATEGORIES = ['character', 'person', 'place', 'object', 'style'];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** GET /api/reference-library — every subject with its images. */
export async function GET() {
  try {
    const subjects = await prisma.referenceSubject.findMany({
      include: {
        images: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
      },
      orderBy: [{ category: 'asc' }, { slug: 'asc' }],
    });
    return NextResponse.json({ subjects });
  } catch (error) {
    console.error('Failed to list reference library:', error);
    return NextResponse.json({ error: 'Failed to list reference library', subjects: [] }, { status: 500 });
  }
}

/** POST /api/reference-library — create a subject. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = String(body.name || '').trim();
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const slug = slugify(body.slug || name);
    if (!slug) {
      return NextResponse.json({ error: 'name must contain letters or digits' }, { status: 400 });
    }

    const category = CATEGORIES.includes(body.category) ? body.category : 'object';

    const existing = await prisma.referenceSubject.findUnique({ where: { slug } });
    if (existing) {
      return NextResponse.json({ error: `A reference named "${slug}" already exists` }, { status: 409 });
    }

    const subject = await prisma.referenceSubject.create({
      data: {
        slug,
        name,
        description: body.description ? String(body.description).slice(0, 500) : null,
        category,
        choomId: body.choomId || null,
      },
      include: { images: true },
    });

    return NextResponse.json({ subject });
  } catch (error) {
    console.error('Failed to create reference subject:', error);
    return NextResponse.json({ error: 'Failed to create reference subject' }, { status: 500 });
  }
}
