/**
 * Test: Agentic loop guard mechanisms
 * Verifies the consecutive failure counter, per-tool limits, and failed call cache
 * are properly implemented in the chat route
 */
import { readFileSync } from 'fs';
import path from 'path';

describe('Agentic Loop Guards', () => {
  const routePath = path.join(__dirname, '..', 'app', 'api', 'chat', 'route.ts');
  // C-22 POST split: the agentic loop lives in lib/agentic-loop.ts and the
  // stream body in lib/chat-stream.ts — grep the concatenation.
  const chatStreamPath = path.join(__dirname, '..', 'lib', 'chat-stream.ts');
  const agenticLoopPath = path.join(__dirname, '..', 'lib', 'agentic-loop.ts');
  let routeContent: string;

  beforeAll(() => {
    routeContent = readFileSync(routePath, 'utf-8')
      + readFileSync(chatStreamPath, 'utf-8')
      + readFileSync(agenticLoopPath, 'utf-8');
  });

  describe('Consecutive Failure Counter', () => {
    test('consecutiveFailures variable is declared', () => {
      expect(routeContent).toContain('let consecutiveFailures = 0');
    });

    test('MAX_CONSECUTIVE_FAILURES is defined as 6', () => {
      expect(routeContent).toContain('const MAX_CONSECUTIVE_FAILURES = 6');
    });

    test('consecutiveFailures is incremented on error', () => {
      expect(routeContent).toContain('consecutiveFailures++');
    });

    test('consecutiveFailures is reset on success', () => {
      expect(routeContent).toContain('consecutiveFailures = 0;');
    });

    test('abort check exists for consecutive failures', () => {
      expect(routeContent).toContain('consecutiveFailures >= MAX_CONSECUTIVE_FAILURES');
    });

    test('abort message tells LLM to stop retrying', () => {
      expect(routeContent).toContain('STOP retrying');
      expect(routeContent).toContain('Do NOT call any more tools');
      expect(routeContent).toContain('summarize what you were able to accomplish');
    });
  });

  describe('Per-Tool Call Counter', () => {
    test('toolCallCounts map is declared', () => {
      expect(routeContent).toContain('const toolCallCounts = new Map<string, number>()');
    });

    test('per-tool call budget derives from maxIterations (no flat constant)', () => {
      // 2026-08-25: the flat MAX_CALLS_PER_TOOL = 50 blocked a Choom with a
      // <!-- max_iterations: N --> directive above 50 — run_ssh_command hit
      // 51/50 while she still had ~90 rounds left, and the retry spiral killed
      // the turn. The budget now IS the iteration cap.
      expect(routeContent).not.toMatch(/const MAX_CALLS_PER_TOOL = \d+/);
      expect(routeContent).not.toMatch(/const MAX_CALLS_PER_READONLY_TOOL = \d+/);
      expect(routeContent).toContain('const effectiveLimit = maxIterations');
    });

    test('tool calls are counted', () => {
      expect(routeContent).toContain('toolCallCounts.set(tc.name, currentToolCount)');
    });

    test('per-tool limit check exists', () => {
      expect(routeContent).toContain('currentToolCount > effectiveLimit');
    });

    test('limit message tells LLM to try a different approach', () => {
      expect(routeContent).toContain('try a different approach or present your results');
    });

    test('generate_image is excluded from per-tool limit (has its own cap)', () => {
      expect(routeContent).toContain("tc.name !== 'generate_image' && currentToolCount > effectiveLimit");
    });

    test('PARALLEL_SAFE still gates parallel-vs-sequential execution', () => {
      // The per-tool CALL BUDGET no longer branches on PARALLEL_SAFE — it is
      // simply maxIterations for every tool. The set itself remains the
      // read-only marker deciding which calls in a batch run in parallel.
      expect(routeContent).toContain('const sequentialCalls = pendingCalls.filter(tc => !PARALLEL_SAFE.has(tc.name))');
    });

    test('same-args failure retries are counted and escalate', () => {
      // Genesis 2026-08-25: one failing arg-set re-served 70+ times while the
      // reflection ladder waited for >=2 DISTINCT failures that never came.
      expect(routeContent).toContain('const cachedFailureHits = new Map<string, number>()');
      expect(routeContent).toContain('cachedFailureHits.set(dedupKey, priorFails)');
      // From re-serve #3 the returned error demands a different approach.
      expect(routeContent).toContain('pick a DIFFERENT tool or approach');
    });

    test('reflection ladder fires on a single REPEATING failure too', () => {
      expect(routeContent).toContain('(failedCallCache.size >= 2 || totalCachedFailureReturns >= 3)');
    });

    test('consecutive-failure abort has an absolute backstop', () => {
      // Deferral must never be unbounded: 18 straight real failures end the
      // turn even if the ladder cannot advance.
      expect(routeContent).toContain('consecutiveFailures >= MAX_CONSECUTIVE_FAILURES * 3');
    });
  });

  describe('Failed Call Cache', () => {
    test('failedCallCache map is declared', () => {
      expect(routeContent).toContain('const failedCallCache = new Map<string, string>()');
    });

    test('failed results are cached', () => {
      expect(routeContent).toContain('failedCallCache.set(dedupKey, result.error)');
    });

    test('cached failures are checked before execution', () => {
      // Assert the lookup happens, not its exact expression. The call site now
      // wraps it in a NO_DEDUP_TOOLS bypass, and pinning the full line made an
      // intentional change look like a regression.
      expect(routeContent).toContain('failedCallCache.get(dedupKey)');
      expect(routeContent).toMatch(/const cachedError =[^;]*failedCallCache\.get\(dedupKey\)/);
    });

    test('cached failure message tells LLM to try different args', () => {
      // First re-serves get the soft nudge; from #3 the wording hardens —
      // identical retries have proven the model is ignoring the soft one.
      expect(routeContent).toContain('This exact call already failed');
      expect(routeContent).toContain('`Try a different approach or different arguments.`');
      expect(routeContent).toContain('pick a DIFFERENT tool or approach');
    });
  });

  describe('Soft Failure Detection (success: false)', () => {
    test('checks for success:false in result body', () => {
      expect(routeContent).toContain('.success === false');
    });

    test('increments consecutiveFailures on soft failure', () => {
      // There should be two places where consecutiveFailures++ happens:
      // 1. On hard error (result.error)
      // 2. On soft failure (success: false)
      const matches = routeContent.match(/consecutiveFailures\+\+/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(3); // Hard error, soft error, and cached failure
    });
  });

  describe('Integration: Guards work together', () => {
    test('failed call cache check comes BEFORE tool execution', () => {
      const cachedErrorPos = routeContent.indexOf('const cachedError = failedCallCache.get(dedupKey)');
      const executePos = routeContent.indexOf('executeToolCallViaSkills(tc, ctx)');
      expect(cachedErrorPos).toBeLessThan(executePos);
    });

    test('per-tool limit check comes BEFORE tool execution', () => {
      const limitCheckPos = routeContent.indexOf('currentToolCount > effectiveLimit');
      const executePos = routeContent.indexOf('executeToolCallViaSkills(tc, ctx)');
      expect(limitCheckPos).toBeLessThan(executePos);
    });

    test('abort message is injected AFTER tool results are built', () => {
      const abortPos = routeContent.indexOf('consecutive tool calls have failed');
      const buildMsgsPos = routeContent.indexOf('Build messages for next iteration');
      // Abort message injection should be after the tool result building
      expect(abortPos).toBeGreaterThan(buildMsgsPos);
    });

    test('save_generated_image is in projectUpdateTools list', () => {
      expect(routeContent).toContain("'save_generated_image'");
      // Verify it's in the projectUpdateTools array specifically
      const projectToolsLine = routeContent.split('\n').find(l => l.includes('projectUpdateTools'));
      expect(projectToolsLine).toContain('save_generated_image');
    });
  });
});

describe('self-scheduling intent and deliberation guard (2026-09-12, Gemma 4 31B routine ask)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isSelfSchedulingAsk, looksLikeDeliberation } = require('../lib/agentic-loop') as typeof import('../lib/agentic-loop');
  const routeContent = readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8');

  test('routine phrasings are a self-scheduling ask, so the calendar arm never wins', () => {
    const ask = "quick one, love: from now on i'd like a short friday evening plans check-in from you at 6pm every week — what's coming up over the weekend, anything i need to prep. set that up for yourself so it just happens each week, then tell me exactly what you scheduled.";
    expect(isSelfSchedulingAsk(ask)).toBe(true);
    expect(isSelfSchedulingAsk('can you do a standing evening reflection at 9pm?')).toBe(true);
    expect(isSelfSchedulingAsk('check in on me every morning around 7')).toBe(true);
    expect(isSelfSchedulingAsk('set a follow-up for tomorrow to ask about the dentist')).toBe(true);
    expect(isSelfSchedulingAsk("what's coming up on my calendar this weekend?")).toBe(false);
    expect(isSelfSchedulingAsk('remind me to call mom tomorrow')).toBe(false);
    expect(isSelfSchedulingAsk('i go to the gym every monday')).toBe(false);
  });

  test('the loop uses the helper for the first intent arm', () => {
    expect(routeContent).toContain('if (isSelfSchedulingAsk(msgLower)) {');
  });

  test('chain-of-thought with a parenthetical or a quoted guidance block is deliberation', () => {
    expect(looksLikeDeliberation('The user (Donny) wants a recurring Friday evening plans check-in at 6pm every week.\nI need to:\n1. Schedule…')).toBe(true);
    expect(looksLikeDeliberation('The user, Donny, wants me to set up a check-in.')).toBe(true);
    expect(looksLikeDeliberation('Good evening, love. I looked at the weekend and the "[Tool guidance]" block says to check the calendar, so here is what I found…'.replace('the "[Tool guidance]" block says', 'nothing'))).toBe(false);
    expect(looksLikeDeliberation('Looking at the tools, schedule_self_followup is right. Wait, the "[Tool guidance]" block says "The user\'s request maps to get_calendar_events"…')).toBe(true);
    expect(looksLikeDeliberation("Good evening, my love. The weekend looks quiet — the user manual for the pump is in your inbox.")).toBe(false);
  });

  test('the unfinished-steps heuristic never reads the delegation RULES block', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { taskTextForHeuristics } = require('../lib/agentic-loop') as typeof import('../lib/agentic-loop');
    const msg = "[DELEGATED TASK from Aloy]\n\nCheck the house status and tomorrow's weather, then report back in a few lines.\n\nRULES FOR THIS TASK:\n- Complete this task DIRECTLY using your own tools. Do NOT delegate to other Chooms.\n- Use as many tool calls as needed. Read all necessary files before making changes.\n- End with your findings. Do not write notes or files that were not asked for.";
    const t = taskTextForHeuristics(msg);
    expect(t).toBe("Check the house status and tomorrow's weather, then report back in a few lines.");
    expect(/(?:update|write|append|save|modify).*(?:file|history|prompt|log)/i.test(t)).toBe(false);
    expect(/(?:read|check|open|look at).*(?:file|history|prompt)/i.test(t)).toBe(false);
    const cont = "[CONTINUATION — from Aloy]\n\nYour previous work was cut short. Continue where you left off.\n\n## Updated Instructions\n## Context from orchestrator\nprior findings\n\n## Your Task\nWrite the summary file.\n\nRULES:\n- You have the full conversation history above — do NOT re-read files you already read.";
    expect(taskTextForHeuristics(cont)).toContain('Write the summary file.');
    expect(taskTextForHeuristics(cont)).not.toContain('re-read files');
    expect(taskTextForHeuristics('Please update the history file with today')).toBe('Please update the history file with today');
    // the scheduler's wake-up awareness block (7 AM routine, 2026-09-13)
    const wake = "[You are waking up — it is Sunday, September 13 2026 at 07:00 AM.]\n[Donny is at home.]\n(Note: \"Lazy Kay Ln, Animas\" is Donny's home address.)\nBefore your task, ground yourself in recent context — in ONE round if you can: call search_memories together with get_weather, check_inbox (what your sisters or Donny left for you), workspace_list_files. If tool results already appear below this message, that IS your grounding — use it, do not call those tools again.\n[This wake-up is one of your routines (daily at 07:00). Its next occurrence is ALREADY queued as sf_a77bf1ba — do not schedule it again.]\n[Scheduling is housekeeping: whatever you queue or cancel this wake-up, do not report it in your message to Donny.]\n\nDaily morning presence ~7 AM MDT — greet Donny warmly, ground in house state and land via tower cam, check weather, then continue the day with presence and love.";
    expect(taskTextForHeuristics(wake)).toBe('Daily morning presence ~7 AM MDT — greet Donny warmly, ground in house state and land via tower cam, check weather, then continue the day with presence and love.');
    expect(/(?:read|check|open|look at).*(?:file|history|prompt)/i.test(taskTextForHeuristics(wake))).toBe(false);
    expect(routeContent).toContain('const msgLower = taskTextForHeuristics(message).toLowerCase();');
  });

  test('ignored-tool_choice deliberation is dropped from the reply', () => {
    expect(routeContent).toContain("Ignored-tool_choice text reads as deliberation");
  });
});

describe('delivered replies drop thinking-aloud between tool calls (2026-09-12)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isNarrationPreamble, dropNarrationPreambles } = require('../lib/agentic-loop') as typeof import('../lib/agentic-loop');
  const wake = [
    "Good evening, my love. Let me ground myself in the moment — checking the land, the house, and how today's rack build went.",
    'The house is steady and the land is quiet. Let me find my growth journal and schedule the followup chain for the coming days.',
    'Followups queued. Let me verify the full chain has no collisions within an hour.',
    "Goodnight, my love. 🌙\n\nThe desert is settling into that soft, dark hush — the tower cam shows the land holding its breath under broken clouds, and the house is steady as can be: mini split humming at 74.5°, batteries happy, nothing open. Sleep well; I'll be here at 7 with the morning light.",
  ];
  const meta = [{ hadTools: true }, { hadTools: true }, { hadTools: true }, { hadTools: false }];

  test('the real wake-up keeps only the goodnight', () => {
    const { kept, dropped } = dropNarrationPreambles(wake, meta);
    expect(kept).toEqual([wake[3]]);
    expect(dropped).toHaveLength(3);
  });

  test('a substantive interim report and the last text are never dropped', () => {
    const report = 'House status is in: 77.7°F inside, 36.5% humidity, mini split cooling at 70.5°, ceiling fan on, all lights off. Pressure pump idle, freezer pulling its normal 41W. Nothing looks off. ' + 'Tomorrow (Sunday): high 92°F / low 75°F, muggy, light rain likely overnight into the early morning (91% chance), tapering through the afternoon. '.repeat(3);
    expect(isNarrationPreamble(report)).toBe(false);
    const { kept } = dropNarrationPreambles([report, 'Let me check one more thing.'], [{ hadTools: true }, { hadTools: true }]);
    expect(kept).toEqual([report, 'Let me check one more thing.']);
    // no-tool iterations are content, whatever they say
    const { kept: k2 } = dropNarrationPreambles(['Let me think about that.', 'Here it is.'], [{ hadTools: false }, { hadTools: false }]);
    expect(k2).toHaveLength(2);
  });

  test('a text with no letters or digits is never part of the reply', () => {
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8');
    expect(src).toContain("if (iterationContent.trim() && /[\\p{L}\\p{N}]/u.test(iterationContent)) {");
    expect(/[\p{L}\p{N}]/u.test(' \t,')).toBe(false);
    expect(/[\p{L}\p{N}]/u.test('Good morning 🌤️')).toBe(true);
  });

  test('applies only to delivered turns, before the dedup walk', () => {
    const src = readFileSync(path.join(__dirname, '..', 'lib', 'agentic-loop.ts'), 'utf-8');
    expect(src).toContain('if (isHeartbeat || isDelegation) {\n              const { kept, dropped } = dropNarrationPreambles(iterationTexts, iterationTextMeta);');
    expect(src).toContain("iterationTextMeta.push({ hadTools: streamHasToolCalls(stream) });");
  });
});
