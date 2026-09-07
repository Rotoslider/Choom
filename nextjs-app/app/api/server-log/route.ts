import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { open, stat } from 'fs/promises';
import path from 'path';

const pExecFile = promisify(execFile);

// Where the dev server's console output — everything the terminal used to
// show — is captured, so Settings → Logs → Agent Console can read it back.
//
// Linux: the dev server runs as a systemd user unit (systemd-run --user
//   --unit=choom-dev, the C-39-safe way) and its output lands in the user
//   journal, which we read with journalctl.
// macOS: launchd has no journal — com.choom.dev.plist redirects stdout to a
//   plain file and log-filter.js stamps each line (CHOOM_LOG_TIMESTAMPS=1).
//   We tail that file instead.
//
// $CHOOM_DEV_LOG forces the file reader on any platform.
const UNIT = process.env.CHOOM_DEV_UNIT || 'choom-dev';
const DEFAULT_LOG_FILE = path.join(process.cwd(), 'data', 'logs', 'choom-dev.log');
const LOG_FILE = process.env.CHOOM_DEV_LOG || (process.platform === 'darwin' ? DEFAULT_LOG_FILE : '');
const USE_FILE = LOG_FILE !== '';
const MAX_LINES = 2000;
const JOURNAL_WINDOW = 6000; // raw lines fetched before filtering
const TAIL_BYTES = 4 * 1024 * 1024; // how far back we read a log file

/** Read the last TAIL_BYTES of a file without slurping the whole thing. */
async function tailFile(file: string): Promise<string> {
  const { size } = await stat(file);
  const start = Math.max(0, size - TAIL_BYTES);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A partial first line is likely when we seek into the middle of the file.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

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
// Log-file line shape. log-filter.js stamps each line (CHOOM_LOG_TIMESTAMPS=1)
// and concurrently prefixes its name *after* that pipe, so the source comes
// first when present:
//   [next] 2026-07-28T14:41:05.123Z    🚨 [Genesis] ...
const FILE_LINE_RE = /^(?:\[(\w+)\]\s+)?(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/;
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

    const source = USE_FILE ? LOG_FILE : `journalctl --user -u ${UNIT}`;

    let stdout: string;
    if (USE_FILE) {
      try {
        stdout = await tailFile(LOG_FILE);
      } catch (err) {
        return NextResponse.json({
          unit: source,
          exists: false,
          lines: [],
          message:
            `Could not read the dev server log at ${LOG_FILE} — is the dev server running under launchd? ` +
            `Start it with: launchctl kickstart -k gui/$(id -u)/com.choom.dev` +
            (err instanceof Error ? ` (${err.message.split('\n')[0]})` : ''),
        });
      }
    } else {
      try {
        ({ stdout } = await pExecFile(
          'journalctl',
          ['--user', '-u', UNIT, '-n', String(JOURNAL_WINDOW), '--no-pager', '-o', 'short-iso'],
          { maxBuffer: 16 * 1024 * 1024 },
        ));
      } catch (err) {
        return NextResponse.json({
          unit: source,
          exists: false,
          lines: [],
          message:
            `Could not read the journal for user unit "${UNIT}" — is the dev server running under systemd? ` +
            `Start it with: systemd-run --user --unit=${UNIT} --working-directory=$PWD pnpm dev` +
            (err instanceof Error ? ` (${err.message.split('\n')[0]})` : ''),
        });
      }
    }

    const parsed: AgentLogLine[] = [];
    for (const raw of stdout.split('\n')) {
      if (!raw) continue;
      let ts: string;
      let text: string;
      let source = '';
      if (USE_FILE) {
        const m = raw.match(FILE_LINE_RE);
        if (!m) continue;
        source = m[1] || '';
        ts = m[2];
        text = m[3];
      } else {
        const m = raw.match(LINE_RE);
        if (!m) continue;
        ts = m[1];
        text = m[2];
      }
      // The journal carries concurrently's "[next] " prefix inline; strip it.
      const sm = text.match(SOURCE_RE);
      if (sm) {
        source = source || sm[1];
        text = text.slice(sm[0].length);
      }
      if (!text.trim()) continue;
      parsed.push({ ts, source, text, cat: classify(text) });
    }

    let filtered = parsed;
    if (mode === 'highlights') filtered = filtered.filter((l) => l.cat !== '');
    else if (mode === 'agent') filtered = filtered.filter((l) => l.cat !== '' && l.cat !== 'media' && l.cat !== 'setup');
    if (search) filtered = filtered.filter((l) => l.text.toLowerCase().includes(search));

    return NextResponse.json({
      unit: source,
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
