/**
 * Iteration-cap resolution: <!-- max_iterations: N --> per Choom, per-project
 * caps, request overrides.
 *
 * The production bugs these pin down (2026-08-25):
 *   1. A project's .choom-project.json maxIterations could never TIGHTEN the
 *      cap below the global default (50) — "limit by project" only worked
 *      upward, so a project capped at 10 still ran 50 rounds.
 *   2. Conversely a project could silently LOOSEN an explicit Choom directive
 *      (directive 12 + project 100 → ran 100), breaking "the directive IS the
 *      intended limit".
 * Both fixed by a single precedence: override > directive > project > default,
 * where an explicit setting locks the cap against later modification.
 */
import {
  MAX_ITERATIONS,
  HEARTBEAT_DEFAULT_MAX_ITERATIONS,
  parseChoomMaxIterations,
  resolveMaxIterations,
} from '../lib/chat-shared';

describe('parseChoomMaxIterations', () => {
  it('parses the documented directive format', () => {
    expect(parseChoomMaxIterations('You are Eve.\n<!-- max_iterations: 100 -->\nBe kind.')).toBe(100);
  });

  it('tolerates whitespace variations', () => {
    expect(parseChoomMaxIterations('<!--max_iterations:12-->')).toBe(12);
    expect(parseChoomMaxIterations('<!--   max_iterations:   7   -->')).toBe(7);
  });

  it('returns 0 when absent', () => {
    expect(parseChoomMaxIterations('no directive here')).toBe(0);
    expect(parseChoomMaxIterations('')).toBe(0);
    expect(parseChoomMaxIterations(null)).toBe(0);
    expect(parseChoomMaxIterations(undefined)).toBe(0);
  });

  it('takes the first directive when several are present', () => {
    expect(parseChoomMaxIterations('<!-- max_iterations: 5 --><!-- max_iterations: 99 -->')).toBe(5);
  });

  it('floors implausibly tiny values at 3', () => {
    expect(parseChoomMaxIterations('<!-- max_iterations: 1 -->')).toBe(3);
  });
});

describe('resolveMaxIterations precedence', () => {
  it('defaults to the global cap, unlocked', () => {
    const r = resolveMaxIterations({});
    expect(r.maxIterations).toBe(MAX_ITERATIONS); // 50
    expect(r.source).toBe('global-default');
    expect(r.locked).toBe(false);
    expect(r.shadowed).toEqual([]);
  });

  it('defaults heartbeats tighter than normal chats, unlocked', () => {
    const r = resolveMaxIterations({ isHeartbeat: true });
    expect(r.maxIterations).toBe(HEARTBEAT_DEFAULT_MAX_ITERATIONS); // 15
    expect(r.source).toBe('heartbeat-default');
    expect(r.locked).toBe(false);
  });

  it('a Choom directive overrides defaults and heartbeat tightening', () => {
    const r = resolveMaxIterations({ choomMaxIterations: 100, isHeartbeat: true });
    expect(r.maxIterations).toBe(100);
    expect(r.source).toBe('choom-directive');
    expect(r.locked).toBe(true);
  });

  it('BUG 1 regression: a project cap TIGHTENS the default (10 < 50 applies)', () => {
    const r = resolveMaxIterations({ projectMaxIterations: 10 });
    expect(r.maxIterations).toBe(10);
    expect(r.source).toBe('project');
    expect(r.locked).toBe(true);
  });

  it('a project cap also RAISES the default for dedicated work', () => {
    const r = resolveMaxIterations({ projectMaxIterations: 100 });
    expect(r.maxIterations).toBe(100);
    expect(r.source).toBe('project');
  });

  it('BUG 2 regression: a Choom directive is never loosened by a higher project cap', () => {
    const r = resolveMaxIterations({ choomMaxIterations: 12, projectMaxIterations: 100 });
    expect(r.maxIterations).toBe(12);
    expect(r.source).toBe('choom-directive');
    // The shadowed project is reported so logs can explain why it lost.
    expect(r.shadowed).toEqual(['project']);
  });

  it('a Choom directive is never tightened by a lower project cap either', () => {
    const r = resolveMaxIterations({ choomMaxIterations: 12, projectMaxIterations: 5 });
    expect(r.maxIterations).toBe(12);
  });

  it('a request override beats directive and project (scheduler goal_review path)', () => {
    const r = resolveMaxIterations({
      maxIterationsOverride: 30,
      choomMaxIterations: 100,
      projectMaxIterations: 200,
    });
    expect(r.maxIterations).toBe(30);
    expect(r.source).toBe('request-override');
    expect(r.locked).toBe(true);
    expect(r.shadowed).toEqual(['choom-directive', 'project']);
  });

  it('ignores invalid settings in every slot instead of applying them', () => {
    // String override (API callers must pass numbers) falls through to defaults.
    expect(resolveMaxIterations({ maxIterationsOverride: '100' as unknown as number }).source).toBe('global-default');
    // Zero / negative / NaN never count as set.
    expect(resolveMaxIterations({ choomMaxIterations: 0 }).maxIterations).toBe(MAX_ITERATIONS);
    expect(resolveMaxIterations({ choomMaxIterations: -5 }).maxIterations).toBe(MAX_ITERATIONS);
    expect(resolveMaxIterations({ projectMaxIterations: Number.NaN }).maxIterations).toBe(MAX_ITERATIONS);
    expect(resolveMaxIterations({ maxIterationsOverride: 0, choomMaxIterations: 7 }).maxIterations).toBe(7);
  });
});
