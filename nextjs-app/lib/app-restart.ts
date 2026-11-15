/**
 * Restart Choom from the app (the sidebar's Restart Choom button; Donny, Nov 15 2026: "a button on the
 * Choom Gui to restart Choom on the Mac", with an "are you sure" first).
 *
 * The server can't restart itself: `launchctl kickstart -k com.choom.dev` stops every process of the
 * dev server, a child it started included. So the button leaves a request in
 * data/restart-request.json and starts the restart agent (com.choom.weekly-restart, the weekly
 * restart's own launchd job) with `launchctl kickstart`. scripts/weekly-restart.py takes the request:
 * "now" restarts right away, "quiet" waits for a quiet moment (no Choom turn under way, no followup or
 * bridge task due; up to 40 minutes). Its lines go to data/logs/weekly-restart.log, which the dialog
 * shows while it works.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export type RestartMode = 'now' | 'quiet';
export const RESTART_AGENT = 'com.choom.weekly-restart';

const appRoot = () => process.cwd();
export const requestFile = () => process.env.CHOOM_RESTART_REQUEST_FILE || path.join(appRoot(), 'data', 'restart-request.json');
export const restartLog = () => process.env.CHOOM_RESTART_LOG_FILE || path.join(appRoot(), 'data', 'logs', 'weekly-restart.log');
const target = () => `gui/${process.getuid?.() ?? 501}/${RESTART_AGENT}`;

function launchctl(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('launchctl', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

/** Whether the restart agent is running now (a restart waiting for a quiet moment, or under way). */
export async function restartRunning(): Promise<boolean> {
  const { code, out } = await launchctl(['print', target()]);
  return code === 0 && /^\s*state = running\s*$/m.test(out);
}

/** The last lines of the restart log, from the newest restart's first line on. */
export function restartLogTail(max = 8): string[] {
  let text = '';
  try {
    const file = restartLog();
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 16_384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const start = lines.map((l) => /^\S+ \S+ (weekly restart|restart asked for)/.test(l)).lastIndexOf(true);
  return lines.slice(start >= 0 ? start : 0).slice(-max);
}

export type RestartStatus = {
  running: boolean;
  requested: RestartMode | null;
  log: string[];
  /** When this server process started (epoch ms): it changes once the restart has happened. */
  serverStarted: number;
};

export async function restartStatus(): Promise<RestartStatus> {
  let requested: RestartMode | null = null;
  try {
    const req = JSON.parse(fs.readFileSync(requestFile(), 'utf8'));
    requested = req.mode === 'now' ? 'now' : 'quiet';
  } catch { /* none waiting */ }
  return {
    running: await restartRunning(),
    requested,
    log: restartLogTail(),
    serverStarted: Math.round(Date.now() - process.uptime() * 1000),
  };
}

/**
 * Ask for a restart. The request is written first; then the agent is started, or, when it's already
 * running (waiting for a quiet moment), it picks up a request for now within 30 s.
 */
export async function requestRestart(mode: RestartMode): Promise<{ ok: boolean; already: boolean; error?: string }> {
  const file = requestFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mode, at: Date.now() / 1000, by: 'Restart Choom button' }));
  if (await restartRunning()) return { ok: true, already: true };
  const { code, out } = await launchctl(['kickstart', target()]);
  if (code !== 0) {
    try { fs.unlinkSync(file); } catch { /* gone already */ }
    return { ok: false, already: false, error: `launchctl kickstart ${RESTART_AGENT} failed (${code}): ${out.trim() || 'no output'}. Is the restart agent installed (launchd/ in the repo)?` };
  }
  return { ok: true, already: false };
}
