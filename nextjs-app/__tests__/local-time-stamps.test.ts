/** 2026-09-13: tool results hand a Choom local time, never a bare UTC ISO stamp (Eve read a 2:23 PM snapshot as "8:23"). */
import { localTimeString, localFileStamp } from '@/lib/time-context';
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
