import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const REPORTS_DIR = path.resolve(process.cwd(), 'data', 'traces', 'reports');

function listReports(): { date: string; size: number; modified: string }[] {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  const out: { date: string; size: number; modified: string }[] = [];
  for (const fname of fs.readdirSync(REPORTS_DIR)) {
    const m = fname.match(/^report-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    try {
      const stat = fs.statSync(path.join(REPORTS_DIR, fname));
      out.push({ date: m[1], size: stat.size, modified: stat.mtime.toISOString() });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get('date');

    if (!date) {
      return NextResponse.json(
        { reports: listReports() },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
    }
    const file = path.join(REPORTS_DIR, `report-${date}.json`);
    if (!fs.existsSync(file)) {
      return NextResponse.json({ error: `No report for ${date}` }, { status: 404 });
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return NextResponse.json(
      { date, report: data },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
