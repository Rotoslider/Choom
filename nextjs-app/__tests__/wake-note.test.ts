/**
 * A wake-up's note, without the scheduler's awareness block (2026-09-28).
 * Auto-recall embedded the boilerplate in front of it and recalled the same
 * "how I self-schedule" memories on every wake-up.
 */
import { wakeNoteTask } from '../lib/wake-note';

const NOTE = 'Friday morning check-in (~9:30 AM Sep 25): has the canvas arrived? Check memories first.';
const WAKE = "[You are waking up — it is Friday, September 25 2026 at 09:37 AM.]\n[You wrote this note on Thu, Sep 24 at 6:25 AM — 27 hours ago.]\nDonny is AWAY — at San Simon. (GPS: 42D Forest Road)\nBefore your task, ground yourself in recent context — in ONE round if you can. …\n[Scheduling is housekeeping: whatever you queue or cancel this wake-up, do not report it in your message to Donny — no 'self-scheduling update' footer. He hears every word.]\n\n" + NOTE;

describe('wakeNoteTask', () => {
  test('returns only the note from a wake-up message', () => {
    expect(wakeNoteTask(WAKE)).toBe(NOTE);
  });

  test('any other message passes through unchanged', () => {
    const chat = 'Genesis, the canvas is on our wall. Check the family room.';
    expect(wakeNoteTask(chat)).toBe(chat);
  });

  test('auto-recall queries with the note (source contract)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/chat-context.ts'), 'utf8');
    expect(src).toContain("const memQuery = wakeNoteTask(String(message)).slice(0, 1500).replace(/[\\uD800-\\uDBFF]$/, '');");
  });
});
