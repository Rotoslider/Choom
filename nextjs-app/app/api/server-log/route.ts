import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const pExecFile = promisify(execFile);

// The dev server runs as a systemd user unit (systemd-run --user --unit=choom-dev,
// the C-39-safe way), so its console output — everything the terminal used to
// show — lands in the user journal. This route reads it back out for the
// Settings → Logs → Agent Console view.
const UNIT = process.env.CHOOM_DEV_UNIT || 'choom-dev';
const MAX_LINES = 2000;
const JOURNAL_WINDOW = 6000; // raw lines fetched before filtering

export interface AgentLogLine {
  ts: string; // ISO timestamp from the journal
  source: string; // concurrently prefix: next | memory | ''
  text: string;
  cat: string; // category derived from the line's marker
}

// Marker → category. Order matters only for readability; first match wins.
const MARKERS: Array<[string, string]> = [
  ['🚨', 'phantom'],
  ['🔁', 'repeat'],
  ['🔄', 'nudge'],
  ['⚡', 'force'],
  ['🔬', 'diag'],
  ['🛑', 'error'],
  ['❌', 'error'],
  ['🧲', 'salvage'],
  ['🧹', 'salvage'],
  ['📊', 'tokens'],
  ['🖼', 'image'],
  ['🎨', 'image'],
  ['✅', 'ok'],
  ['🔊', 'media'],
  ['🎤', 'media'],
  ['🛠', 'setup'],
  ['⚙', 'setup'],
  ['📂', 'setup'],
  ['📜', 'setup'],
  ['🧠', 'setup'],
  ['🔗', 'setup'],
  ['🔒', 'setup'],
  ['🌱', 'setup'],
  ['🌤', 'setup'],
  ['🌡', 'setup'],
  ['⏸', 'nudge'],
  ['🔧', 'setup'],
];

function classify(text: string): string {
  const t = text.trimStart();
  // Turn-setup dumps reuse agent markers (✅ RESOLVED: model=..., 🔄 Fallback
  // 1: ...) — keep them out of 'agent' mode, which is for loop decisions.
  if (/^(?:✅ RESOLVED:|✅ Checkpoint|🔄 Fallback|🖼️?\s*(?:Choom Image Settings|Recent images))/u.test(t)) {
    return 'setup';
  }
  for (const [marker, cat] of MARKERS) {
    if (t.startsWith(marker)) return cat;
  }
  if (/\b(?:error|failed|exception)\b/i.test(t) && !/ 200 in /.test(t)) return 'error';
  return '';
}

// journalctl -o short-iso line shape:
//   2026-07-28T08:41:05-0600 host pnpm[1316268]: [next]    🚨 [Genesis] ...
const LINE_RE = /^(\S+)\s+\S+\s+\S+\[\d+\]:\s?(.*)$/;
const SOURCE_RE = /^\[(\w+)\]\s?/;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(MAX_LINES, Math.max(50, Number(searchParams.get('limit')) || 400));
    // agent: loop decisions only (nudges, phantoms, forces, errors) — the
    //        lines you'd scan the terminal for.
    // highlights: every marker line, including TTS/STT and setup chatter.
    // all: the raw firehose, HTTP logs and all.
    const mode = (searchParams.get('mode') || 'agent') as 'agent' | 'highlights' | 'all';
    const search = (searchParams.get('q') || '').trim().toLowerCase();

    let stdout: string;
    try {
      ({ stdout } = await pExecFile(
        'journalctl',
        ['--user', '-u', UNIT, '-n', String(JOURNAL_WINDOW), '--no-pager', '-o', 'short-iso'],
        { maxBuffer: 16 * 1024 * 1024 },
      ));
    } catch (err) {
      return NextResponse.json({
        unit: UNIT,
        exists: false,
        lines: [],
        message:
          `Could not read the journal for user unit "${UNIT}" — is the dev server running under systemd? ` +
          `Start it with: systemd-run --user --unit=${UNIT} --working-directory=$PWD pnpm dev` +
          (err instanceof Error ? ` (${err.message.split('\n')[0]})` : ''),
      });
    }

    const parsed: AgentLogLine[] = [];
    for (const raw of stdout.split('\n')) {
      if (!raw) continue;
      const m = raw.match(LINE_RE);
      if (!m) continue;
      let text = m[2];
      let source = '';
      const sm = text.match(SOURCE_RE);
      if (sm) {
        source = sm[1];
        text = text.slice(sm[0].length);
      }
      if (!text.trim()) continue;
      parsed.push({ ts: m[1], source, text, cat: classify(text) });
    }

    let filtered = parsed;
    if (mode === 'highlights') filtered = filtered.filter((l) => l.cat !== '');
    else if (mode === 'agent') filtered = filtered.filter((l) => l.cat !== '' && l.cat !== 'media' && l.cat !== 'setup');
    if (search) filtered = filtered.filter((l) => l.text.toLowerCase().includes(search));

    return NextResponse.json({
      unit: UNIT,
      exists: true,
      total_in_window: filtered.length,
      lines: filtered.slice(-limit),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read server log' },
      { status: 500 },
    );
  }
}
