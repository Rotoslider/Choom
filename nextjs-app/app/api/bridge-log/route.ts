import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const LOG_PATH = path.resolve(process.cwd(), 'data', 'logs', 'bridge.log');
const MAX_TAIL_BYTES = 512 * 1024; // 512KB cap on bytes read off the tail
const MAX_LINES = 2000;

function tailFile(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

const LEVEL_RE = /\s-\s(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s-\s/;

function levelOf(line: string): string {
  const m = line.match(LEVEL_RE);
  return m ? m[1] : '';
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(MAX_LINES, Math.max(50, Number(searchParams.get('limit')) || 500));
    const levelFilter = (searchParams.get('level') || '').toUpperCase();
    const search = (searchParams.get('q') || '').trim().toLowerCase();

    if (!fs.existsSync(LOG_PATH)) {
      return NextResponse.json({
        path: LOG_PATH,
        exists: false,
        lines: [],
        message:
          'Bridge log file does not exist yet. Restart the Signal bridge so it can create it (the new logging config writes to data/logs/bridge.log).',
      });
    }

    const stat = fs.statSync(LOG_PATH);
    const raw = tailFile(LOG_PATH, MAX_TAIL_BYTES);
    const allLines = raw.split('\n').filter((l) => l.length > 0);

    let filtered = allLines;
    if (levelFilter && levelFilter !== 'ALL') {
      const wanted: Record<string, string[]> = {
        ERROR: ['ERROR', 'CRITICAL'],
        WARNING: ['WARNING', 'ERROR', 'CRITICAL'],
        INFO: ['INFO', 'WARNING', 'ERROR', 'CRITICAL'],
        DEBUG: ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'],
      };
      const allowed = new Set(wanted[levelFilter] || []);
      if (allowed.size) filtered = filtered.filter((l) => allowed.has(levelOf(l)));
    }
    if (search) {
      filtered = filtered.filter((l) => l.toLowerCase().includes(search));
    }

    const tail = filtered.slice(-limit);

    return NextResponse.json(
      {
        path: LOG_PATH,
        exists: true,
        size_bytes: stat.size,
        modified: stat.mtime.toISOString(),
        total_in_window: allLines.length,
        returned: tail.length,
        lines: tail,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
