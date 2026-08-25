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
