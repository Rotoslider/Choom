/**
 * Phase 4 (2026-09-12): a rolling summary of everything older than a room's
 * transcript window, stored per room, refreshed only when new older messages
 * appear, and injected as EARLIER IN THIS ROOM.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureRoomDigest, setRoomDigestDir, readDigest, buildSummaryPrompt, formatDigestBlock } from '@/lib/room-digest';
import { stripDsmlMarkup } from '@/lib/agentic-loop';

jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));

const msg = (i: number, author = 'Donny') => ({ id: `m${i}`, authorName: author, content: `message number ${i} about the rack`, createdAt: new Date(2026, 8, 12, 10, i) });

describe('ensureRoomDigest', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-')); setRoomDigestDir(dir); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('nothing older than the window → no block, no summarizer call', async () => {
    const chat = jest.fn();
    const r = await ensureRoomDigest('room1', [], { chat });
    expect(r.block).toBe('');
    expect(chat).not.toHaveBeenCalled();
  });

  test('first refresh summarizes, second call with no new messages reads the file', async () => {
    const chat = jest.fn().mockResolvedValue({ content: 'They planned the rack and Genesis made a nameplate.' });
    const older = [msg(1), msg(2, 'Genesis'), msg(3, 'Aloy')];
    const r1 = await ensureRoomDigest('room1', older, { chat });
    expect(r1.refreshed).toBe(true);
    expect(r1.block).toContain('## EARLIER IN THIS ROOM');
    expect(r1.block).toContain('3 room messages before');
    expect(r1.block).toContain('nameplate');
    expect(readDigest('room1')?.throughId).toBe('m3');
    const r2 = await ensureRoomDigest('room1', older, { chat });
    expect(r2.refreshed).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  test('new older messages extend the existing summary rather than restarting it', async () => {
    const chat = jest.fn()
      .mockResolvedValueOnce({ content: 'First summary.' })
      .mockResolvedValueOnce({ content: 'First summary, then they argued about fans.' });
    await ensureRoomDigest('room1', [msg(1), msg(2)], { chat });
    const r = await ensureRoomDigest('room1', [msg(1), msg(2), msg(3), msg(4)], { chat });
    expect(r.refreshed).toBe(true);
    const prompt = chat.mock.calls[1][0][1].content as string;
    expect(prompt).toContain('EXISTING SUMMARY:\nFirst summary.');
    expect(prompt).toContain('[Donny]: message number 3');
    expect(prompt).not.toContain('message number 1'); // already covered
    expect(readDigest('room1')?.coveredCount).toBe(4);
  });

  test('a summarizer failure falls back mechanically and still writes a digest', async () => {
    const chat = jest.fn().mockRejectedValue(new Error('model down'));
    const r = await ensureRoomDigest('room1', [msg(1), msg(2)], { chat });
    expect(r.block).toContain('message number 2');
    expect(readDigest('room1')).not.toBeNull();
  });

  test('prompt excerpts are bounded', () => {
    const long = { id: 'x', authorName: 'Eve', content: 'y'.repeat(2000), createdAt: new Date() };
    expect(buildSummaryPrompt(null, [long]).length).toBeLessThan(1200);
    expect(formatDigestBlock('', 0)).toBe('');
  });
});

describe('stripDsmlMarkup', () => {
  test('removes DeepSeek-style tool markup a tool-less small model wrote as text', () => {
    const t = 'Good morning!\n<｜DSML｜invoke name="search_memories">\n<｜DSML｜parameter name="query" string="true">rack</｜DSML｜parameter>\n</｜DSML｜invoke>\nThat is all.';
    expect(stripDsmlMarkup(t)).toBe('Good morning!\n\nThat is all.');
    expect(stripDsmlMarkup('plain text')).toBe('plain text');
  });
});

describe('group-chat route: owner preemption and user-asked rooms (source contract)', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'group-chat', 'route.ts'), 'utf-8');
  test('an owner message into a running room asks the run to yield and waits for the lock', () => {
    expect(route).toContain('preemptRequested.add(roomId);');
    expect(route).toContain('while (runningRooms.has(roomId) && Date.now() < waitUntil)');
    expect(route).toContain('if (preemptRequested.has(roomId)) {');
  });
  test('a room the user asked her to start from a chat is never a "duplicate"', () => {
    expect(route).toContain("const isInitiatorRun = !!initiatorChoomId && !continueRun && triggerSourceForLock !== 'chat';");
  });
});

describe('group-chat round cap (2026-09-12)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'api', 'group-chat', 'route.ts'), 'utf-8') as string;
  test('an owner message honours an explicit rounds override (rounds: 0 = one round, no auto-rounds)', () => {
    expect(src).toContain(': 1 + Math.max(0, roundsOverride ?? room.autoRounds);');
    expect(src).not.toContain(': 1 + Math.max(0, room.autoRounds);');
  });
});
