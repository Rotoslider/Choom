// Skill Eval System (Phase 6)
// Auto-generates and runs test cases when skills are created or modified.

import type { ToolDefinition, ToolCall, ToolResult } from './types';
import type { BaseSkillHandler, SkillHandlerContext } from './skill-handler';

// ============================================================================
// Eval Definition — JSON-serializable test case
// ============================================================================

export interface SkillEval {
  id: string;
  skillName: string;
  toolName: string;
  description: string;
  input: { arguments: Record<string, unknown> };
  expected: {
    success: boolean;
    resultContains?: string[];
    errorContains?: string;
  };
  auto: boolean; // true = auto-generated, false = custom
}

// ============================================================================
// Eval Result — outcome of running a single eval
// ============================================================================

export interface EvalResult {
  evalId: string;
  passed: boolean;
  duration: number; // ms
  actual: {
    success: boolean;
    result?: unknown;
    error?: string;
  };
  reason?: string; // Why it failed
}

// ============================================================================
// Eval Suite — all evals for a skill, plus aggregate results
// ============================================================================

export interface EvalSuite {
  skillName: string;
  evals: SkillEval[];
  results: EvalResult[];
  generatedAt: string; // ISO timestamp
  passRate: number; // 0-1
}

// ============================================================================
// Default test values by type
// ============================================================================

const DEFAULT_VALUES: Record<string, unknown> = {
  string: 'test',
  number: 1,
  boolean: true,
  array: [],
  object: {},
};

/**
 * Generate a type-appropriate test value for a tool parameter.
 * Respects enum constraints by picking the first enum value.
 */
function generateTestValue(
  paramDef: { type: string; enum?: string[]; items?: { type: string }; default?: unknown }
): unknown {
  // If param has a default, use it
  if (paramDef.default !== undefined) {
    return paramDef.default;
  }

  // If param has enum values, use the first one
  if (paramDef.enum && paramDef.enum.length > 0) {
    return paramDef.enum[0];
  }

  // Fall back to type-based defaults
  return DEFAULT_VALUES[paramDef.type] ?? 'test';
}

// ============================================================================
// SkillEvalRunner — generates and runs evals
// ============================================================================

export class SkillEvalRunner {
  /**
   * Auto-generate evals from tool definitions for a given skill.
   *
   * Rules:
   *  1. Happy path: all required params filled with type-appropriate test values
   *  2. Missing required param: one eval per required param, omitting it (expects error)
   *  3. Enum coverage: one eval per enum value for params that have enums
   */
  autoGenerate(toolDefinitions: ToolDefinition[], skillName: string): SkillEval[] {
    const evals: SkillEval[] = [];

    for (const tool of toolDefinitions) {
      const properties = tool.parameters.properties;
      const required = tool.parameters.required ?? [];

      // ---------------------------------------------------------------
      // 1. Happy path — fill all required params with test values
      // ---------------------------------------------------------------
      const happyArgs: Record<string, unknown> = {};
      for (const [paramName, paramDef] of Object.entries(properties)) {
        if (required.includes(paramName)) {
          happyArgs[paramName] = generateTestValue(paramDef);
        }
      }

      evals.push({
        id: `${skillName}::${tool.name}::happy-path`,
        skillName,
        toolName: tool.name,
        description: `Happy path: call ${tool.name} with all required params`,
        input: { arguments: happyArgs },
        expected: { success: true },
        auto: true,
      });

      // ---------------------------------------------------------------
      // 2. Missing required param — one eval per required param
      // ---------------------------------------------------------------
      for (const missingParam of required) {
        const argsWithout: Record<string, unknown> = {};
        for (const [paramName, paramDef] of Object.entries(properties)) {
          if (required.includes(paramName) && paramName !== missingParam) {
            argsWithout[paramName] = generateTestValue(paramDef);
          }
        }

        evals.push({
          id: `${skillName}::${tool.name}::missing-${missingParam}`,
          skillName,
          toolName: tool.name,
          description: `Missing required param "${missingParam}" for ${tool.name}`,
          input: { arguments: argsWithout },
          expected: {
            success: false,
            errorContains: missingParam,
          },
          auto: true,
        });
      }

      // ---------------------------------------------------------------
      // 3. Enum coverage — one eval per enum value per param
      // ---------------------------------------------------------------
      for (const [paramName, paramDef] of Object.entries(properties)) {
        if (!paramDef.enum || paramDef.enum.length === 0) continue;

        for (const enumValue of paramDef.enum) {
          // Build args: all required params at defaults, override this param with the enum value
          const enumArgs: Record<string, unknown> = {};
          for (const [pName, pDef] of Object.entries(properties)) {
            if (required.includes(pName)) {
              enumArgs[pName] = generateTestValue(pDef);
            }
          }
          // Override (or add) this param with the specific enum value
          enumArgs[paramName] = enumValue;

          evals.push({
            id: `${skillName}::${tool.name}::enum-${paramName}-${enumValue}`,
            skillName,
            toolName: tool.name,
            description: `Enum coverage: ${tool.name} with ${paramName}="${enumValue}"`,
            input: { arguments: enumArgs },
            expected: { success: true },
            auto: true,
          });
        }
      }
    }

    return evals;
  }

  /**
   * Run a single eval against a handler.
   *
   * The eval constructs a synthetic ToolCall, invokes handler.execute(),
   * then checks the result against the expected outcome.
   */
  async runEval(
    evalDef: SkillEval,
    handler: BaseSkillHandler,
    ctx: SkillHandlerContext
  ): Promise<EvalResult> {
    const startTime = Date.now();

    // Build synthetic ToolCall
    const toolCall: ToolCall = {
      id: `eval-${evalDef.id}-${Date.now()}`,
      name: evalDef.toolName,
      arguments: evalDef.input.arguments,
    };

    let toolResult: ToolResult;
    try {
      toolResult = await handler.execute(toolCall, ctx);
    } catch (err) {
      // Handler threw an unhandled exception — treat as failure
      const duration = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      return {
        evalId: evalDef.id,
        passed: !evalDef.expected.success, // If we expected failure, an exception is a pass
        duration,
        actual: {
          success: false,
          error: errorMsg,
        },
        reason: evalDef.expected.success
          ? `Handler threw an unhandled exception: ${errorMsg}`
          : undefined,
      };
    }

    const duration = Date.now() - startTime;

    // Determine if the tool result indicates success or error
    const actualSuccess = !toolResult.error;
    const actualError = toolResult.error;
    const actualResult = toolResult.result;

    // ---------------------------------------------------------------
    // Check: success/failure match
    // ---------------------------------------------------------------
    if (evalDef.expected.success !== actualSuccess) {
      return {
        evalId: evalDef.id,
        passed: false,
        duration,
        actual: {
          success: actualSuccess,
          result: actualResult,
          error: actualError,
        },
        reason: evalDef.expected.success
          ? `Expected success but got error: ${actualError}`
          : `Expected error but got success`,
      };
    }

    // ---------------------------------------------------------------
    // Check: resultContains (substring matching on JSON-serialized result)
    // ---------------------------------------------------------------
    if (evalDef.expected.resultContains && evalDef.expected.resultContains.length > 0) {
      const resultStr = typeof actualResult === 'string'
        ? actualResult
        : JSON.stringify(actualResult);

      for (const expected of evalDef.expected.resultContains) {
        if (!resultStr.includes(expected)) {
          return {
            evalId: evalDef.id,
            passed: false,
            duration,
            actual: {
              success: actualSuccess,
              result: actualResult,
              error: actualError,
            },
            reason: `Result does not contain expected substring: "${expected}"`,
          };
        }
      }
    }

    // ---------------------------------------------------------------
    // Check: errorContains (substring matching on error message)
    // ---------------------------------------------------------------
    if (evalDef.expected.errorContains && actualError) {
      if (!actualError.toLowerCase().includes(evalDef.expected.errorContains.toLowerCase())) {
        return {
          evalId: evalDef.id,
          passed: false,
          duration,
          actual: {
            success: actualSuccess,
            result: actualResult,
            error: actualError,
          },
          reason: `Error does not contain expected substring: "${evalDef.expected.errorContains}" (actual: "${actualError}")`,
        };
      }
    }

    // All checks passed
    return {
      evalId: evalDef.id,
      passed: true,
      duration,
      actual: {
        success: actualSuccess,
        result: actualResult,
        error: actualError,
      },
    };
  }

  /**
   * Run all evals for a skill, returning results in order.
   *
   * Evals run sequentially to avoid overwhelming external services
   * and to keep eval output deterministic.
   */
  async runAll(
    skillName: string,
    evals: SkillEval[],
    handler: BaseSkillHandler,
    ctx: SkillHandlerContext
  ): Promise<EvalResult[]> {
    const results: EvalResult[] = [];

    for (const evalDef of evals) {
      // Safety: only run evals that belong to this skill
      if (evalDef.skillName !== skillName) continue;

      // Safety: confirm handler can actually handle this tool
      if (!handler.canHandle(evalDef.toolName)) {
        results.push({
          evalId: evalDef.id,
          passed: false,
          duration: 0,
          actual: { success: false, error: `Handler does not support tool: ${evalDef.toolName}` },
          reason: `Handler.canHandle("${evalDef.toolName}") returned false`,
        });
        continue;
      }

      const result = await this.runEval(evalDef, handler, ctx);
      results.push(result);
    }

    return results;
  }

  /**
   * Build a full EvalSuite: auto-generate evals, merge any custom evals, and run them.
   */
  async buildAndRun(
    skillName: string,
    toolDefinitions: ToolDefinition[],
    handler: BaseSkillHandler,
    ctx: SkillHandlerContext,
    customEvals: SkillEval[] = []
  ): Promise<EvalSuite> {
    const autoEvals = this.autoGenerate(toolDefinitions, skillName);
    const allEvals = [...autoEvals, ...customEvals];
    const results = await this.runAll(skillName, allEvals, handler, ctx);

    const passed = results.filter((r) => r.passed).length;
    const total = results.length;

    return {
      skillName,
      evals: allEvals,
      results,
      generatedAt: new Date().toISOString(),
      passRate: total > 0 ? passed / total : 1,
    };
  }

  /**
   * Pretty-print eval results for logging / CLI output.
   */
  formatResults(suite: EvalSuite): string {
    const lines: string[] = [];
    const passedCount = suite.results.filter((r) => r.passed).length;
    const failedCount = suite.results.length - passedCount;

    lines.push(`Eval Suite: ${suite.skillName}`);
    lines.push(`Generated: ${suite.generatedAt}`);
    lines.push(`Total: ${suite.results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
    lines.push(`Pass Rate: ${(suite.passRate * 100).toFixed(1)}%`);
    lines.push('---');

    for (const result of suite.results) {
      const evalDef = suite.evals.find((e) => e.id === result.evalId);
      const status = result.passed ? 'PASS' : 'FAIL';
      const desc = evalDef?.description ?? result.evalId;
      const durationStr = `${result.duration}ms`;

      lines.push(`[${status}] ${desc} (${durationStr})`);
      if (!result.passed && result.reason) {
        lines.push(`       Reason: ${result.reason}`);
      }
    }

    return lines.join('\n');
  }
}
