/**
 * [Tool guidance] gate — "Call that tool directly" injections (2026-08-25).
 *
 * Eve + Genesis caught music_control guidance arriving in GROUP ROOMS with no
 * music anywhere in the conversation. Root cause: the [Tool guidance] message
 * was pushed whenever ANY intent hint regex matched the raw `message` — but in
 * rooms, `message` IS the siblings' chatter ("stop", "track", "resume",
 * "speaker" all occur naturally), and the push never checked isGroupTurn,
 * forceToolCall, or whether the hinted tool was even exposed.
 *
 * Contract: guidance rides ONLY on an enforced 1:1 intent — group turns and
 * unenforced/unexposed hints must never produce it.
 */
import { readFileSync } from 'fs';
import path from 'path';

const agenticLoop = readFileSync(
  path.join(__dirname, '..', 'lib', 'agentic-loop.ts'),
  'utf-8',
);

describe('[Tool guidance] gating', () => {
  test('guidance requires non-group + forced + exposed hint', () => {
    expect(agenticLoop).toContain(
      'if (!isGroupTurn && forceToolCall && intentForcedTool && activeTools.length > 0) {',
    );
  });

  test('the unguarded legacy condition is gone', () => {
    expect(agenticLoop).not.toContain('if (intentToolHint && activeTools.length > 0) {');
  });

  test('guidance still names the single hinted tool', () => {
    expect(agenticLoop).toContain('Call that tool directly');
  });

  test('group turns never force tool_choice', () => {
    // The forcing line itself already excludes rooms; guidance depends on it.
    expect(agenticLoop).toMatch(/forceToolCall = !isGroupTurn && \(strongToolIntent \|\| !!intentToolHint\)/);
  });
});
