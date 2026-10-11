/** 2026-09-13: tool results hand a Choom local time, never a bare UTC ISO stamp (Eve read a 2:23 PM snapshot as "8:23"). */
import { localTimeString, localFileStamp, localizeTimestamps } from '@/lib/time-context';
import { readFileSync } from 'fs';
import path from 'path';

describe('local time stamps', () => {
  const d = new Date('2026-09-13T20:23:00Z'); // 2:23 PM MDT
  test('localTimeString names the zone and the local hour', () => {
    const s = localTimeString(d);
    expect(s).toContain('2:23 PM');
    expect(s).toMatch(/MDT|MST|GMT-[67]/);
    expect(s).not.toContain('20:23');
  });
  test('localFileStamp is local wall-clock, not UTC', () => {
    expect(localFileStamp(d)).toBe('2026-09-13_14-23');
    expect(localFileStamp(new Date('2026-09-14T05:30:00Z'))).toBe('2026-09-13_23-30');
  });
  test('the camera snapshot uses them for its file name and captured_at', () => {
    const src = readFileSync(path.join(__dirname, '..', 'skills', 'core', 'home-assistant', 'handler.ts'), 'utf-8');
    expect(src).toContain('const stamp = localFileStamp();');
    expect(src).toContain('captured_at: localTimeString(),');
    expect(src).not.toContain("captured_at: new Date().toISOString()");
  });
});

describe('Home Assistant times reach her in local time (2026-10-10)', () => {
  // The rain gauge's last rain, read as "02:35" when it had rained at 8:35 PM.
  test('a timestamp sensor, a state change and a history are all local', () => {
    const out = localizeTimestamps({
      entity_id: 'sensor.stonedesert_last_rain',
      state: '2026-10-11T02:35:00+00:00',
      last_changed: '2026-10-11T02:35:03.832787+00:00',
      changes: [{ time: '2026-10-11T01:00:00Z', state: '0.00' }, { time: '2026-10-11T02:35:00Z', state: '0.02' }],
      samples: 4,
      ok: true,
    });
    expect(out.state).toContain('8:35 PM');
    expect(out.state).toMatch(/Oct 10/);
    expect(out.last_changed).toContain('8:35 PM');
    expect(out.changes[0].time).toContain('7:00 PM');
    expect(out.changes[1].state).toBe('0.02');
    expect(out.samples).toBe(4);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/T0[12]:/);
  });
  test('inside a line of text too; plain numbers, dates and zoneless times are left alone', () => {
    expect(localizeTimestamps('changed to 2026-10-11T02:35:00+00:00 after a gust')).toMatch(/^changed to Sat, Oct 10, 8:35 PM \S+ after a gust$/);
    expect(localizeTimestamps('29.97 mph')).toBe('29.97 mph');
    expect(localizeTimestamps('2026-10-10')).toBe('2026-10-10');
    expect(localizeTimestamps('2026-10-10 20:35:00')).toBe('2026-10-10 20:35:00');
    expect(localizeTimestamps(null)).toBeNull();
  });
  test('every Home Assistant tool result goes through it', () => {
    const src = readFileSync(path.join(__dirname, '..', 'skills', 'core', 'home-assistant', 'handler.ts'), 'utf-8');
    expect(src).toContain('return r.result == null ? r : { ...r, result: localizeTimestamps(r.result) };');
  });
});
