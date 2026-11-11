import { NextResponse } from 'next/server';
import { turnsOpen } from '@/lib/turns-open';

export const dynamic = 'force-dynamic';

// GET /api/turns: the Choom turns under way right now (lib/turns-open.ts). The weekly restart
// (scripts/weekly-restart.py) waits for { open: 0 }.
export async function GET() {
  const turns = turnsOpen();
  return NextResponse.json({ open: turns.length, turns });
}
