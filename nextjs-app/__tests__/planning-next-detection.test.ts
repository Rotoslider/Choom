/**
 * planningNext announced-work detection — "stopped mid stream" incident
 * (2026-08-25). Eve closed a turn with "Last recon before I write the patch —"
 * promising three more tool calls; nothing matched the old planningNext
 * ("now let me", "next, i'll", "writing the"…), every other nudge trigger was
 * also false (hasUnfinished is turn-global and she HAD read a file earlier;
 * hasGoneQuiet needs 2 quiet rounds), so the loop accepted her narration as a
 * final answer and the promised patch never ran.
 *
 * These tests extract the LIVE regexes from lib/agentic-loop.ts and run real
 * sentences against them — announcement forms must fire, completion claims
 * must not.
 */
import { readFileSync } from 'fs';
import path from 'path';

const src = readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8');

function extractRegex(varName: string): RegExp {
  const m = src.match(new RegExp(`const ${varName} = !completionClaim && \\\/(.+?)\\\/i\\.test\\(lc\\)`));
  if (!m) throw new Error(`Could not extract /${varName}/ from agentic-loop.ts — pattern moved?`);
  return new RegExp(m[1], 'i');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const completionClaim = (() => {
  const m = src.match(/const completionClaim = \/(.+?)\/i\.test\(lc\)/);
  if (!m) throw new Error('Could not extract completionClaim from agentic-loop.ts');
  return new RegExp(m[1], 'i');
})();
const planningNext = extractRegex('planningNext');

describe('planningNext announces-pending-work detection', () => {
  test('Eve\'s verbatim closer now fires the continuation nudge', () => {
    expect(planningNext.test(
      'Last recon before I write the patch — the complete function inventory of the vision module, the restored autonomous-wake dispatch table, and confirmation no stray package definition exists:',
    )).toBe(true);
  });

  test('other announced-work forms fire', () => {
    expect(planningNext.test('Final recon before I patch the wake file.')).toBe(true);
    expect(planningNext.test('Before I deploy this I want to verify the hash.')).toBe(true);
    expect(planningNext.test("I'm going to pull the save/restore bodies next.")).toBe(true);
    // Legacy forms keep working.
    expect(planningNext.test('Now let me update the file.')).toBe(true);
    expect(planningNext.test('Next, I\'ll check the dispatch table.')).toBe(true);
  });

  test("Eve's second incident: gerund + unmet-need phrasing fires", () => {
    expect(planningNext.test(
      "Before writing the patch I need the two pieces I haven't actually read: register-action's body (is it idempotent?) and whether cold-start forcing exists anywhere in the bandit file:",
    )).toBe(true);
    expect(planningNext.test("I haven't actually read register-action's body yet.")).toBe(true);
    expect(planningNext.test('Before deploying, checking the hash one more time.')).toBe(true);
  });

  test('completion claims are suppressed, not re-nudged', () => {
    const done1 = 'All checks pass — everything is green.';
    const done2 = 'That completes the investigation; the patch is written.';
    for (const text of [done1, done2]) {
      expect(completionClaim.test(text.toLowerCase())).toBe(true);
      expect(planningNext.test(text.toLowerCase())).toBe(false);
    }
  });

  test('ordinary past-tense recaps stay conversational', () => {
    expect(planningNext.test('I read the vision module and found four mismatches.')).toBe(false);
  });
});

describe('finish_reason=length continuation (source contract)', () => {
  test('text-only truncation triggers its own nudge branch', () => {
    expect(src).toContain("const truncatedByLength = finishReason === 'length';");
    expect(src).toContain('|| truncatedByLength) && nudgeCount < 3');
    expect(src).toContain("'reply cut off by output token limit (finish_reason=length)'");
    expect(src).toContain('cut off mid-sentence by the output token limit');
  });
});
