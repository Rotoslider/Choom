// Watcher Loop — Inner evaluation loop for plan step results
// Evaluates tool execution results and decides whether to continue,
// retry, skip, rollback, or abort.

import type { ToolResult } from './types';
import type { PlanStep, ExecutionPlan } from './planner-loop';

// ============================================================================
// Types
// ============================================================================

export type WatcherDecision =
  | { action: 'continue' }
  | { action: 'retry'; modifiedArgs?: Record<string, unknown>; reason: string }
  | { action: 'rollback'; stepIds: string[]; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'abort'; reason: string };

export interface WatcherConfig {
  maxConsecutiveFailures: number; // Abort after N consecutive failures (default: 3)
  enableLLMEvaluation: boolean;  // Use LLM for ambiguous result evaluation (default: false for now)
}

const DEFAULT_CONFIG: WatcherConfig = {
  maxConsecutiveFailures: 3,
  enableLLMEvaluation: false,
};

// ============================================================================
// Watcher Loop Class
// ============================================================================

export class WatcherLoop {
  private config: WatcherConfig;
  private consecutiveFailures: number = 0;

  constructor(config?: Partial<WatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate a completed step's result and decide next action.
   * Uses heuristic rules first, with optional LLM fallback for ambiguous cases.
   */
  evaluate(step: PlanStep, result: ToolResult, plan: ExecutionPlan): WatcherDecision {
    // ---- Check for explicit errors ----
    if (result.error) {
      this.consecutiveFailures++;

      // Check if we've hit the consecutive failure threshold
      if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        return {
          action: 'abort',
          reason: `${this.consecutiveFailures} consecutive failures. Last error: ${result.error}`,
        };
      }

      // Analyze error type and decide
      return this.analyzeError(step, result, plan);
    }

    // ---- Check for success: false in result ----
    if (result.result && typeof result.result === 'object') {
      const resultObj = result.result as Record<string, unknown>;

      if (resultObj.success === false) {
        this.consecutiveFailures++;

        if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
          return {
            action: 'abort',
            reason: `${this.consecutiveFailures} consecutive failures. Last: ${resultObj.message || resultObj.error || 'success=false'}`,
          };
        }

        // Treat as retryable error
        const msg = (resultObj.message || resultObj.error || '') as string;
        return {
          action: 'retry',
          reason: `Tool returned success=false: ${msg}`,
        };
      }

      // ---- Check for empty write results ----
      if (step.toolName.includes('write') && resultObj.success === true) {
        // Verify content wasn't empty (for file write operations)
        if ('content' in step.args && !step.args.content) {
          return {
            action: 'retry',
            reason: 'Write operation with empty content',
          };
        }
      }
    }

    // ---- Success! Reset consecutive failures ----
    this.consecutiveFailures = 0;
    return { action: 'continue' };
  }

  /**
   * Analyze an error result and decide whether to retry, skip, or abort.
   */
  private analyzeError(step: PlanStep, result: ToolResult, _plan: ExecutionPlan): WatcherDecision {
    const error = result.error || '';
    const errorLower = error.toLowerCase();

    // ---- Network/timeout errors → retry ----
    if (errorLower.includes('timeout') || errorLower.includes('timed out') ||
        errorLower.includes('econnrefused') || errorLower.includes('econnreset') ||
        errorLower.includes('network') || errorLower.includes('fetch failed')) {
      return {
        action: 'retry',
        reason: `Network/timeout error: ${error.slice(0, 100)}`,
      };
    }

    // ---- Rate limiting → retry ----
    if (errorLower.includes('rate limit') || errorLower.includes('429') ||
        errorLower.includes('too many requests')) {
      return {
        action: 'retry',
        reason: `Rate limited: ${error.slice(0, 100)}`,
      };
    }

    // ---- Authentication errors → skip (retrying won't help) ----
    if (errorLower.includes('auth') || errorLower.includes('unauthorized') ||
        errorLower.includes('forbidden') || errorLower.includes('401') ||
        errorLower.includes('403') || errorLower.includes('token expired')) {
      return {
        action: 'skip',
        reason: `Authentication error: ${error.slice(0, 100)}`,
      };
    }

    // ---- Not found → skip ----
    if (errorLower.includes('not found') || errorLower.includes('404') ||
        errorLower.includes('does not exist') || errorLower.includes('no such')) {
      return {
        action: 'skip',
        reason: `Not found: ${error.slice(0, 100)}`,
      };
    }

    // ---- Invalid arguments → try to fix or skip ----
    if (errorLower.includes('invalid') || errorLower.includes('required') ||
        errorLower.includes('missing parameter') || errorLower.includes('validation')) {
      // If this is a first retry, attempt with no modifications (let the plan adjustments handle it)
      if (step.retries === 0) {
        return {
          action: 'retry',
          reason: `Validation error, retrying: ${error.slice(0, 100)}`,
        };
      }
      return {
        action: 'skip',
        reason: `Persistent validation error: ${error.slice(0, 100)}`,
      };
    }

    // ---- Path/file errors → skip if writing, retry if reading ----
    if (errorLower.includes('path traversal') || errorLower.includes('not allowed')) {
      return {
        action: 'skip',
        reason: `Security restriction: ${error.slice(0, 100)}`,
      };
    }

    // ---- Default: retry once, then skip ----
    if (step.retries === 0) {
      return {
        action: 'retry',
        reason: `Unknown error, retrying: ${error.slice(0, 100)}`,
      };
    }

    return {
      action: 'skip',
      reason: `Failed after retry: ${error.slice(0, 100)}`,
    };
  }

  /**
   * Reset the failure counter (e.g., when starting a new plan).
   */
  reset(): void {
    this.consecutiveFailures = 0;
  }
}
