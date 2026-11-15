/**
 * Restart Choom (lib/app-restart.ts, /api/restart): the button leaves a request for the restart agent and
 * starts it with launchctl; it never restarts anything itself. launchctl is stubbed here: no test may
 * restart the live app.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
import { execFile } from 'child_process';
import { requestRestart, restartLogTail, restartStatus } from '@/lib/app-restart';
import { GET, POST } from '@/app/api/restart/route';

type Call = { args: string[] };
let calls: Call[];
let agentRunning: boolean;
let kickstartFails: boolean;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-restart-'));
  process.env.CHOOM_RESTART_REQUEST_FILE = path.join(dir, 'restart-request.json');
  process.env.CHOOM_RESTART_LOG_FILE = path.join(dir, 'weekly-restart.log');
  calls = [];
  agentRunning = false;
  kickstartFails = false;
  (execFile as unknown as jest.Mock).mockImplementation((cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
    expect(cmd).toBe('launchctl');
    calls.push({ args });
    if (args[0] === 'print') return cb(null, `gui/501/com.choom.weekly-restart = {\n\tstate = ${agentRunning ? 'running' : 'not running'}\n}\n`, '');
    if (args[0] === 'kickstart') return kickstartFails ? cb(Object.assign(new Error('x'), { code: 113 }), '', 'Could not find service') : cb(null, '', '');
    cb(new Error('unexpected'), '', '');
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CHOOM_RESTART_REQUEST_FILE;
  delete process.env.CHOOM_RESTART_LOG_FILE;
  jest.restoreAllMocks();
});

const request = () => JSON.parse(fs.readFileSync(process.env.CHOOM_RESTART_REQUEST_FILE!, 'utf8'));

test('asking for a restart leaves the request and starts the restart agent (never com.choom.dev itself)', async () => {
  const r = await requestRestart('now');
  expect(r).toEqual({ ok: true, already: false });
  expect(request().mode).toBe('now');
  expect(Math.abs(request().at - Date.now() / 1000)).toBeLessThan(5);
  const kick = calls.find((c) => c.args[0] === 'kickstart')!;
  expect(kick.args).toEqual(['kickstart', expect.stringMatching(/^gui\/\d+\/com\.choom\.weekly-restart$/)]);
  expect(calls.some((c) => c.args.includes('-k') || c.args.some((a) => a.includes('com.choom.dev')))).toBe(false);
});

test('a restart already waiting for a quiet moment gets the new request instead of a second start', async () => {
  agentRunning = true;
  const r = await requestRestart('now');
  expect(r).toEqual({ ok: true, already: true });
  expect(request().mode).toBe('now');
  expect(calls.some((c) => c.args[0] === 'kickstart')).toBe(false);
});

test('when the agent cannot start, it says so and leaves no request behind', async () => {
  kickstartFails = true;
  const r = await requestRestart('quiet');
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/kickstart com\.choom\.weekly-restart failed \(113\)/);
  expect(fs.existsSync(process.env.CHOOM_RESTART_REQUEST_FILE!)).toBe(false);
});

test('the log shown is the newest restart, from its first line', () => {
  fs.writeFileSync(process.env.CHOOM_RESTART_LOG_FILE!, [
    '2026-11-11 07:23:02   quiet: restarting com.choom.dev',
    '2026-11-15 01:30:05 weekly restart: memory 6167 MB, next-server 16967 MB',
    '2026-11-15 01:30:40   back in 5 s: memory 699 MB, next-server 1310 MB',
    '2026-11-15 13:02:00 restart asked for in the app (at a quiet moment): memory 1 MB',
    '2026-11-15 13:02:01   waiting: turns under way: Genesis (chat, 40 s)',
    '',
  ].join('\n'));
  expect(restartLogTail()).toEqual([
    '2026-11-15 13:02:00 restart asked for in the app (at a quiet moment): memory 1 MB',
    '2026-11-15 13:02:01   waiting: turns under way: Genesis (chat, 40 s)',
  ]);
});

test('status: running, the request waiting, and when this server started', async () => {
  agentRunning = true;
  fs.writeFileSync(process.env.CHOOM_RESTART_REQUEST_FILE!, JSON.stringify({ mode: 'quiet', at: Date.now() / 1000 }));
  const s = await restartStatus();
  expect(s.running).toBe(true);
  expect(s.requested).toBe('quiet');
  expect(Math.abs(s.serverStarted - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000);
});

test('the route: a mode is needed, another site is refused, GET reports', async () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    POST(new Request('http://localhost:3000/api/restart', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }));
  expect((await post({})).status).toBe(400);
  expect((await post({ mode: 'later' })).status).toBe(400);
  expect((await post({ mode: 'now' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  expect(calls.some((c) => c.args[0] === 'kickstart')).toBe(false);
  const ok = await post({ mode: 'quiet' }, { 'Sec-Fetch-Site': 'same-origin' });
  expect(ok.status).toBe(200);
  expect(request().mode).toBe('quiet');
  const status = await (await GET()).json();
  expect(status).toEqual(expect.objectContaining({ running: false, requested: 'quiet', log: [] }));
});
