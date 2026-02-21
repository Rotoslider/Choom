/**
 * Test: Agentic loop guard mechanisms
 * Verifies the consecutive failure counter, per-tool limits, and failed call cache
 * are properly implemented in the chat route
 */
import { readFileSync } from 'fs';
import path from 'path';

describe('Agentic Loop Guards', () => {
  const routePath = path.join(__dirname, '..', 'app', 'api', 'chat', 'route.ts');
  let routeContent: string;

  beforeAll(() => {
    routeContent = readFileSync(routePath, 'utf-8');
  });

  describe('Consecutive Failure Counter', () => {
    test('consecutiveFailures variable is declared', () => {
      expect(routeContent).toContain('let consecutiveFailures = 0');
    });

    test('MAX_CONSECUTIVE_FAILURES is defined as 3', () => {
      expect(routeContent).toContain('const MAX_CONSECUTIVE_FAILURES = 3');
    });

    test('consecutiveFailures is incremented on error', () => {
      expect(routeContent).toContain('consecutiveFailures++');
    });

    test('consecutiveFailures is reset on success', () => {
      expect(routeContent).toContain('consecutiveFailures = 0; // Reset on success');
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

    test('MAX_CALLS_PER_TOOL is defined as 5', () => {
      expect(routeContent).toContain('const MAX_CALLS_PER_TOOL = 5');
    });

    test('tool calls are counted', () => {
      expect(routeContent).toContain('toolCallCounts.set(tc.name, currentToolCount)');
    });

    test('per-tool limit check exists', () => {
      expect(routeContent).toContain('currentToolCount > MAX_CALLS_PER_TOOL');
    });

    test('limit message tells LLM to try a different approach', () => {
      expect(routeContent).toContain('try a different approach or present your results');
    });

    test('generate_image is excluded from per-tool limit (has its own cap)', () => {
      expect(routeContent).toContain("tc.name !== 'generate_image' && currentToolCount > MAX_CALLS_PER_TOOL");
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
      expect(routeContent).toContain('const cachedError = failedCallCache.get(dedupKey)');
    });

    test('cached failure message tells LLM to try different args', () => {
      expect(routeContent).toContain('This exact call already failed. Try a different approach or different arguments.');
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
      const limitCheckPos = routeContent.indexOf('currentToolCount > MAX_CALLS_PER_TOOL');
      const executePos = routeContent.indexOf('executeToolCallViaSkills(tc, ctx)');
      expect(limitCheckPos).toBeLessThan(executePos);
    });

    test('abort message is injected AFTER tool results are built', () => {
      const abortPos = routeContent.indexOf('Injected abort message after');
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
