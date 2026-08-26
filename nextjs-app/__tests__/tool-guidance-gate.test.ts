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
 *
 * Also pinned here: the tool-execution SSE heartbeat and the SSH timeout cap
 * that together fix the "no stream output for 304s" idle-watchdog kill from
 * the same day.
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

  test('group turns never force tool_choice', () => {
    // The forcing line itself already excludes rooms; guidance depends on it.
    expect(agenticLoop).toMatch(/forceToolCall = !isGroupTurn && \(strongToolIntent \|\| !!intentToolHint\)/);
  });
});

describe('tool-execution SSE heartbeat', () => {
  test('tools emit status ticks so the room idle-watchdog sees liveness', () => {
    // A hung run_ssh_command produced 304s of zero stream bytes; the 300s
    // idle watchdog killed Eve's turn mid-sentence before the SSH timeout
    // could return an error she could act on.
    expect(agenticLoop).toContain("send({ type: 'status', content: 'tool running…' })");
    expect(agenticLoop).toContain('stopToolHeartbeat();');
    expect(agenticLoop).toContain('toolHeartbeatTicks > 30'); // leak-proof self-clear
  });
});

describe('ssh timeout vs idle watchdog', () => {
  const sshSrc = readFileSync(path.join(__dirname, '..', 'lib', 'ssh-executor.ts'), 'utf-8');

  test('SSH default timeout stays under the 300s idle watchdog', () => {
    expect(sshSrc).toMatch(/const DEFAULT_TIMEOUT_MS = 240_000;/);
    expect(sshSrc).not.toMatch(/330_000/);
  });
});
