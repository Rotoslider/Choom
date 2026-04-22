/**
 * Execution Trace Logger
 *
 * Records structured traces of every agentic loop execution for diagnostics,
 * self-improvement analysis, and the nightly doctor job.
 *
 * Traces are written as JSON files to: data/traces/YYYY-MM-DD/chat-{chatId}.json
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ToolCallTrace {
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  error?: string;
  errorClass?: 'config' | 'param' | 'path' | 'gpu_busy' | 'no_data' | 'timeout' | 'other';
  iteration: number;
  parallel: boolean;
  cached: boolean;
  blocked: boolean;
}

export interface ExecutionTrace {
  // Identity
  traceId: string;
  chatId: string;
  choomId: string;
  choomName: string;
  timestamp: string;

  // Model info
  model: string;
  provider: string;
  endpoint: string;

  // Request context
  source: 'chat' | 'delegation' | 'heartbeat';
  isDelegation: boolean;
  isHeartbeat: boolean;
  planMode: boolean;

  // Loop metrics
  iterations: number;
  maxIterations: number;
  status: 'complete' | 'max_iterations' | 'error' | 'stream_closed';
  durationMs: number;

  // Tool metrics
  toolCalls: ToolCallTrace[];
  toolCallCount: number;
  toolSuccessCount: number;
  toolFailureCount: number;
  uniqueToolsUsed: string[];
  brokenTools: string[];

  // Behavior metrics
  nudgeCount: number;
  nudgeTypes: string[];
  fallbackActivated: boolean;
  fallbackModel?: string;
  consecutiveFailuresMax: number;
  forceToolCallUsed: boolean;

  // Token metrics
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensEstimated: boolean;

  // Content metrics
  responseLength: number;

  // Context management
  compactionTriggered: boolean;
}

// ── Trace Builder ──────────────────────────────────────────────────────────

export class TraceBuilder {
  private trace: ExecutionTrace;
  private toolStartTimes = new Map<string, number>();
  private maxConsecutiveFailures = 0;
  private currentConsecutiveFailures = 0;

  constructor(init: {
    chatId: string;
    choomId: string;
    choomName: string;
    model: string;
    provider: string;
    endpoint: string;
    isDelegation: boolean;
    isHeartbeat: boolean;
    maxIterations: number;
  }) {
    this.trace = {
      traceId: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      chatId: init.chatId,
      choomId: init.choomId,
      choomName: init.choomName,
      timestamp: new Date().toISOString(),
      model: init.model,
      provider: init.provider,
      endpoint: init.endpoint,
      source: init.isDelegation ? 'delegation' : init.isHeartbeat ? 'heartbeat' : 'chat',
      isDelegation: init.isDelegation,
      isHeartbeat: init.isHeartbeat,
      planMode: false,
      iterations: 0,
      maxIterations: init.maxIterations,
      status: 'complete',
      durationMs: 0,
      toolCalls: [],
      toolCallCount: 0,
      toolSuccessCount: 0,
      toolFailureCount: 0,
      uniqueToolsUsed: [],
      brokenTools: [],
      nudgeCount: 0,
      nudgeTypes: [],
      fallbackActivated: false,
      consecutiveFailuresMax: 0,
      forceToolCallUsed: false,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokensEstimated: false,
      responseLength: 0,
      compactionTriggered: false,
    };
  }

  /** Mark that plan mode was used */
  setPlanMode(): void {
    this.trace.planMode = true;
  }

  /** Record that force tool_choice was used */
  setForceToolCall(): void {
    this.trace.forceToolCallUsed = true;
  }

  /** Record a nudge event */
  recordNudge(type: 'tool_use' | 'task_continuation' | 'unfinished_steps' | 'forced_tool_choice_ignored'): void {
    this.trace.nudgeCount++;
    this.trace.nudgeTypes.push(type);
  }

  /** Record fallback model activation */
  recordFallback(model: string): void {
    this.trace.fallbackActivated = true;
    this.trace.fallbackModel = model;
  }

  /** Mark start of a tool call (for duration tracking) */
  toolCallStart(toolCallId: string): void {
    this.toolStartTimes.set(toolCallId, Date.now());
  }

  /** Record a completed tool call */
  recordToolCall(tc: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    success: boolean;
    error?: string;
    errorClass?: ToolCallTrace['errorClass'];
    iteration: number;
    parallel: boolean;
    cached?: boolean;
    blocked?: boolean;
  }): void {
    const startTime = this.toolStartTimes.get(tc.id);
    const durationMs = startTime ? Date.now() - startTime : 0;
    this.toolStartTimes.delete(tc.id);

    // Strip large values from args for storage
    const cleanArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tc.args || {})) {
      if (typeof v === 'string' && v.length > 500) {
        cleanArgs[k] = v.slice(0, 200) + `...[${v.length} chars]`;
      } else {
        cleanArgs[k] = v;
      }
    }

    this.trace.toolCalls.push({
      tool: tc.name,
      args: cleanArgs,
      success: tc.success,
      durationMs,
      error: tc.error ? tc.error.slice(0, 300) : undefined,
      errorClass: tc.errorClass,
      iteration: tc.iteration,
      parallel: tc.parallel,
      cached: tc.cached || false,
      blocked: tc.blocked || false,
    });

    this.trace.toolCallCount++;
    if (tc.success) {
      this.trace.toolSuccessCount++;
      this.currentConsecutiveFailures = 0;
    } else {
      this.trace.toolFailureCount++;
      this.currentConsecutiveFailures++;
      this.maxConsecutiveFailures = Math.max(
        this.maxConsecutiveFailures,
        this.currentConsecutiveFailures
      );
    }
  }

  /** Record compaction event */
  recordCompaction(): void {
    this.trace.compactionTriggered = true;
  }

  /** Finalize the trace with end-of-request data */
  finalize(data: {
    iterations: number;
    status: ExecutionTrace['status'];
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    tokensEstimated: boolean;
    responseLength: number;
    brokenTools: string[];
  }): void {
    this.trace.iterations = data.iterations;
    this.trace.status = data.status;
    this.trace.durationMs = data.durationMs;
    this.trace.promptTokens = data.promptTokens;
    this.trace.completionTokens = data.completionTokens;
    this.trace.totalTokens = data.promptTokens + data.completionTokens;
    this.trace.tokensEstimated = data.tokensEstimated;
    this.trace.responseLength = data.responseLength;
    this.trace.brokenTools = data.brokenTools;
    this.trace.consecutiveFailuresMax = this.maxConsecutiveFailures;

    // Compute unique tools
    const toolSet = new Set(this.trace.toolCalls.map(tc => tc.tool));
    this.trace.uniqueToolsUsed = [...toolSet];
  }

  /** Get the built trace */
  getTrace(): ExecutionTrace {
    return this.trace;
  }
}

// ── File Writer ────────────────────────────────────────────────────────────

const TRACES_DIR = path.join(process.cwd(), 'data', 'traces');

/**
 * Write an execution trace to disk.
 * Creates data/traces/YYYY-MM-DD/chat-{chatId}-{timestamp}.json
 * Non-blocking: errors are logged but never thrown.
 */
export function writeTrace(trace: ExecutionTrace): void {
  try {
    const date = new Date(trace.timestamp);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const dayDir = path.join(TRACES_DIR, dateStr);

    // Ensure directory exists
    fs.mkdirSync(dayDir, { recursive: true });

    const filename = `chat-${trace.chatId}-${Date.now()}.json`;
    const filePath = path.join(dayDir, filename);

    fs.writeFileSync(filePath, JSON.stringify(trace, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[ExecutionTrace] Failed to write trace:', err instanceof Error ? err.message : err);
  }
}
