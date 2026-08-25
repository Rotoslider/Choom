/**
 * Shared chat-route infrastructure (C-22 POST split).
 *
 * These helpers used to live at the top of app/api/chat/route.ts. They are
 * needed by the route prep phase AND by the carved-out stream modules
 * (lib/chat-stream.ts, lib/agentic-loop.ts), so they live here to keep the
 * dependency graph one-directional: route -> chat-stream -> agentic-loop,
 * all three -> chat-shared.
 */
import prisma from '@/lib/db';
import { messageTokens, toolSchemaTokens } from '@/lib/compaction-service';
import * as fs from 'fs';
import * as path from 'path';

// Diagnostic: when a request's context is large, log WHERE the tokens are going
// (system prompt vs tool schemas vs which conversation messages) and warn if it's
// near the model's context window (silent input truncation). Pure logging — no
// behavior change. Returns the accurate total (incl. tool_calls + tool schemas)
// so callers can replace the old content-only estimate that under-reported badly.
export function contextBreakdown(
  tag: string,
  messages: Array<{ role: string; content?: string | null; tool_calls?: unknown }>,
  tools: Array<{ name: string; description: string; parameters: unknown }>,
  contextLength: number,
  logThreshold = 60000,
): number {
  const toolTok = toolSchemaTokens(tools as Parameters<typeof toolSchemaTokens>[0]);
  const byRole: Record<string, number> = { system: 0, user: 0, assistant: 0, tool: 0 };
  const perMsg = messages.map((m, i) => {
    const t = messageTokens(m as Parameters<typeof messageTokens>[0]);
    byRole[m.role] = (byRole[m.role] || 0) + t;
    return { i, role: m.role, t, preview: (m.content || '').replace(/\s+/g, ' ').slice(0, 55) };
  });
  const msgTok = perMsg.reduce((a, b) => a + b.t, 0);
  const total = toolTok + msgTok;
  if (total >= logThreshold) {
    const top = [...perMsg].sort((a, b) => b.t - a.t).slice(0, 5);
    console.log(
      `   📐 ${tag} ~${total.toLocaleString()} tok = tools ${toolTok.toLocaleString()}(${tools.length}) + ` +
      `system ${byRole.system.toLocaleString()} + user ${byRole.user.toLocaleString()} + ` +
      `assistant ${byRole.assistant.toLocaleString()} + tool-results ${byRole.tool.toLocaleString()}`,
    );
    console.log(`   📐 ${tag} biggest: ` + top.map(m => `#${m.i}[${m.role} ${m.t.toLocaleString()}t "${m.preview}…"]`).join('  '));
    if (contextLength > 0 && total > contextLength * 0.95) {
      console.warn(`   ✂️  ${tag} TRUNCATION RISK: ~${total.toLocaleString()} tok ≥ 95% of contextLength ${contextLength.toLocaleString()} — the server will silently drop oldest messages. Lower contextLength or trim the task's reads.`);
    }
  }
  return total;
}

// Smart merge: skip empty strings, null, and undefined values so GUI defaults
// don't clobber real .env / bridge-config values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function smartMerge<T extends Record<string, any>>(defaults: T, overrides: Partial<T> | undefined): T {
  if (!overrides) return { ...defaults };
  const result = { ...defaults };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const val = overrides[key];
    if (val === '' || val === null || val === undefined) continue;
    result[key] = val as T[keyof T];
  }
  return result;
}

// GUI activity tracking — write a per-Choom timestamp file so the Python
// heartbeat scheduler can detect active GUI conversations and defer.
const ACTIVITY_DIR = path.join(process.cwd(), 'services', 'signal-bridge', '.gui-activity');
export function recordGuiActivity(choomName: string) {
  try {
    if (!fs.existsSync(ACTIVITY_DIR)) fs.mkdirSync(ACTIVITY_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ACTIVITY_DIR, `${choomName.toLowerCase()}.ts`),
      Date.now().toString(),
      'utf-8'
    );
  } catch { /* non-critical */ }
}
export function clearGuiActivity(choomName: string) {
  try {
    const f = path.join(ACTIVITY_DIR, `${choomName.toLowerCase()}.ts`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch { /* non-critical */ }
}

// Maximum agentic loop iterations
export const MAX_ITERATIONS = 50;
export const HEARTBEAT_DEFAULT_MAX_ITERATIONS = 15;

// Parse the <!-- max_iterations: N --> directive from a Choom's system prompt.
// Returns 0 when absent (caller falls back to project/default caps).
export function parseChoomMaxIterations(systemPrompt: string | null | undefined): number {
  const m = (systemPrompt || '').match(/<!--\s*max_iterations:\s*(\d+)\s*-->/);
  return m ? Math.max(3, parseInt(m[1], 10)) : 0;
}

export type IterationCapSource =
  | 'request-override'
  | 'choom-directive'
  | 'project'
  | 'heartbeat-default'
  | 'global-default';

export interface ResolvedIterationCap {
  maxIterations: number;
  source: IterationCapSource;
  /**
   * True when an EXPLICIT setting (request override, Choom directive, project
   * metadata) chose the cap. A locked cap is honored verbatim: neither the
   * post-plan reduction nor mid-turn project re-detection in the agentic loop
   * may raise or lower it.
   */
  locked: boolean;
  /** Lower-priority settings that lost the precedence race (for transparent logging). */
  shadowed: IterationCapSource[];
}

/**
 * Single source of truth for the agentic-loop iteration cap (one iteration =
 * one LLM round that may batch several parallel tool calls). Precedence:
 *   request override > <!-- max_iterations: N --> directive > project
 *   .choom-project.json metadata > defaults (heartbeat 15, global 50)
 *
 * Explicit settings win over contextual ones and are never moved by a
 * lower-priority source — before this resolver a project could silently
 * LOOSEN a Choom's directive, and could never TIGHTEN the global default,
 * so "limit by project" simply didn't work below 50.
 */
export function resolveMaxIterations(opts: {
  maxIterationsOverride?: unknown;
  choomMaxIterations?: number;
  projectMaxIterations?: number | null;
  isHeartbeat?: boolean;
}): ResolvedIterationCap {
  const override = typeof opts.maxIterationsOverride === 'number' && Number.isFinite(opts.maxIterationsOverride) && opts.maxIterationsOverride > 0
    ? opts.maxIterationsOverride : 0;
  const directive = typeof opts.choomMaxIterations === 'number' && Number.isFinite(opts.choomMaxIterations) && opts.choomMaxIterations > 0
    ? opts.choomMaxIterations : 0;
  const project = typeof opts.projectMaxIterations === 'number' && Number.isFinite(opts.projectMaxIterations) && opts.projectMaxIterations > 0
    ? opts.projectMaxIterations : 0;

  if (override > 0) {
    const shadowed: IterationCapSource[] = [];
    if (directive > 0) shadowed.push('choom-directive');
    if (project > 0) shadowed.push('project');
    return { maxIterations: override, source: 'request-override', locked: true, shadowed };
  }
  if (directive > 0) {
    return {
      maxIterations: directive, source: 'choom-directive', locked: true,
      shadowed: project > 0 ? ['project'] : [],
    };
  }
  if (project > 0) {
    return { maxIterations: project, source: 'project', locked: true, shadowed: [] };
  }
  if (opts.isHeartbeat) {
    return { maxIterations: HEARTBEAT_DEFAULT_MAX_ITERATIONS, source: 'heartbeat-default', locked: false, shadowed: [] };
  }
  return { maxIterations: MAX_ITERATIONS, source: 'global-default', locked: false, shadowed: [] };
}

// Server-side activity logging - writes directly to DB so both Signal and web GUI get logged
export async function serverLog(
  choomId: string, chatId: string,
  level: string, category: string,
  title: string, message: string,
  details?: unknown, duration?: number
) {
  try {
    await prisma.activityLog.create({
      data: { choomId, chatId, level, category, title, message,
              details: details ? JSON.stringify(details) : null,
              duration: duration || null }
    });
  } catch (e) {
    // Never let logging failures break chat — but don't fail silently either,
    // so a genuine write problem is visible in server logs instead of looking
    // like an empty Activity Log.
    console.warn(`   ⚠️  serverLog write failed (${category}/${title}):`, e instanceof Error ? e.message : e);
  }
}

// Fallback model slot (primary retry / configured fallback 1 & 2 / planner).
// route.ts builds these in prep; the stream modules consume them. The route
// keeps its own structurally-identical local type — TypeScript structural
// typing makes them interchangeable.
export type FallbackConfig = { model: string; providerId: string | null; label: string; retryDelayMs?: number; sameModelRetry?: boolean };

// Project detection result shape shared by route prep and the stream modules.
export type DetectedProject = {
  folder: string;
  metadata: { maxIterations?: number; name?: string; llmProviderId?: string; llmModel?: string; assignedChoom?: string };
};
