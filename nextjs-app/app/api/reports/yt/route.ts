import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const REPORTS_DIR = path.resolve(process.cwd(), 'data', 'yt_reports');

interface YTReportSummary {
  id: string;
  generated_at: string;
  total_downloaded: number;
  total_errors: number;
  channels_run: number;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function listReports(): YTReportSummary[] {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  const out: YTReportSummary[] = [];
  for (const fname of fs.readdirSync(REPORTS_DIR)) {
    if (!fname.endsWith('.json')) continue;
    const id = fname.slice(0, -5);
    try {
      const data = safeParse(fs.readFileSync(path.join(REPORTS_DIR, fname), 'utf-8')) as
        | Partial<YTReportSummary>
        | null;
      if (!data) continue;
      out.push({
        id,
        generated_at: String(data.generated_at ?? ''),
        total_downloaded: Number(data.total_downloaded ?? 0),
        total_errors: Number(data.total_errors ?? 0),
        channels_run: Number(data.channels_run ?? 0),
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { reports: listReports() },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (!/^[a-zA-Z0-9_\-:.]+$/.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }
    const file = path.join(REPORTS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) {
      return NextResponse.json({ error: `No report ${id}` }, { status: 404 });
    }
    const data = safeParse(fs.readFileSync(file, 'utf-8'));
    if (!data) return NextResponse.json({ error: 'Malformed report' }, { status: 500 });
    return NextResponse.json(
      { id, report: data },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
