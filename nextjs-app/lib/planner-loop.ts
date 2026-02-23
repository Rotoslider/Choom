// Planner Loop — Outer agentic loop for multi-step tasks
// Creates structured execution plans and orchestrates step-by-step execution
// with real-time progress streaming to the client.

import type { ToolCall, ToolResult, ToolDefinition } from './types';
import type { ChatMessage, ChatCompletionChunk } from './llm-client';
import type { SkillRegistry } from './skill-registry';
import type { WatcherLoop } from './watcher-loop';

// Duck-typed LLM client interface (supports both LLMClient and AnthropicClient)
interface LLMClientLike {
  streamChat: (
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required' | 'none'
  ) => AsyncGenerator<ChatCompletionChunk, void, unknown>;
}

// ============================================================================
// Types
// ============================================================================

export interface PlanStep {
  id: string;
  description: string;
  skillName: string;
  toolName: string;
  args: Record<string, unknown>;
  dependsOn: string[];
  expectedOutcome: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back' | 'skipped';
  result?: ToolResult;
  retries: number;
  rollbackAction?: { toolName: string; args: Record<string, unknown> };
  // Delegation support: when type is 'delegate', route through choom-delegation handler
  type?: 'tool' | 'delegate';
  choomName?: string; // Target Choom for delegate steps
  task?: string;      // Task description for delegate steps
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  maxRetries: number;
}

export type PlanStreamCallback = (data: Record<string, unknown>) => void;

// SSE event types for plan progress
export interface PlanCreatedEvent {
  type: 'plan_created';
  goal: string;
  steps: Array<{ id: string; description: string; toolName: string; status: string }>;
}

export interface PlanStepUpdateEvent {
  type: 'plan_step_update';
  stepId: string;
  status: string;
  description?: string;
  result?: string;
}

export interface PlanCompletedEvent {
  type: 'plan_completed';
  summary: string;
  succeeded: number;
  failed: number;
  total: number;
}

// ============================================================================
// Multi-step detection heuristic
// ============================================================================

const MULTI_STEP_PATTERNS = [
  /\b(research|investigate|analyze)\b.*\b(and|then)\b.*\b(write|create|summarize|report|compare)/i,
  /\b(step by step|step-by-step)\b/i,
  /\b(compare|contrast)\b.*\band\b/i,
  /\b(find|search|look up)\b.*\b(then|and then|after that)\b/i,
  /\b(create|build|make)\b.*\b(based on|using|from)\b.*\b(search|research|analysis)/i,
  /\b(download|fetch|get)\b.*\b(and|then)\b.*\b(process|convert|save|upload)/i,
  /\b(scrape|crawl)\b.*\b(and|then)\b.*\b(extract|save|write)/i,
  /\b(first|1\))\b.*\b(then|2\)|second)\b/i,
];

/**
 * Check if a user message looks like a multi-step task that would benefit
 * from a structured plan vs. the simple agentic loop.
 */
export function isMultiStepRequest(message: string): boolean {
  return MULTI_STEP_PATTERNS.some(p => p.test(message));
}

// ============================================================================
// Plan extraction from LLM response
// ============================================================================

/**
 * Ask the LLM to create a structured plan from the conversation.
 * Returns null if the LLM determines no plan is needed (simple request).
 */
export async function createPlan(
  messages: ChatMessage[],
  registry: SkillRegistry,
  llmClient: LLMClientLike,
  tools: ToolDefinition[]
): Promise<ExecutionPlan | null> {
  const skillSummaries = registry.getLevel1Summaries();

  const planPrompt: ChatMessage = {
    role: 'user',
    content: `[System — Plan Creation]
You are creating a structured execution plan. Based on the conversation so far, break the user's request into discrete tool-calling steps.

Available skills and tools:
${skillSummaries}

Respond with ONLY a JSON object in this format (no markdown, no backticks):
{
  "goal": "Brief description of overall goal",
  "steps": [
    {
      "id": "step_1",
      "type": "tool",
      "description": "Human-readable description of what this step does",
      "skillName": "skill-name",
      "toolName": "tool_name",
      "args": { "param": "value" },
      "dependsOn": [],
      "expectedOutcome": "What success looks like for this step"
    },
    {
      "id": "step_2",
      "type": "delegate",
      "description": "Delegate research to Genesis",
      "choomName": "Genesis",
      "task": "Detailed task for the target Choom including context from {{step_1.result.field}}",
      "dependsOn": ["step_1"],
      "expectedOutcome": "Genesis returns research findings"
    }
  ]
}

Rules:
- Each step is either type "tool" (calls a tool directly) or type "delegate" (sends task to another Choom)
- Use type "delegate" when the task needs another Choom's expertise (research, coding, image analysis)
- For delegate steps, specify choomName and task (not toolName/args)
- Use dependsOn to reference step IDs that must complete first
- Use {{step_N.result.field}} syntax in args/task to reference previous step outputs
- If the request is simple (1-2 steps), respond with: {"goal": null}
- Maximum 10 steps per plan
- Only use tools from the available skills listed above`,
  };

  // Build planning messages: keep system + last few user/assistant messages + plan prompt
  const planMessages: ChatMessage[] = [
    messages[0], // system prompt
    ...messages.slice(-6), // recent conversation context
    planPrompt,
  ];

  // Get LLM response (non-streaming for plan creation)
  let responseText = '';
  try {
    for await (const chunk of llmClient.streamChat(planMessages, [], undefined, 'none')) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        responseText += choice.delta.content;
      }
    }
  } catch (err) {
    console.warn('[Planner] Failed to get plan from LLM:', err instanceof Error ? err.message : err);
    return null;
  }

  // Parse the JSON response
  try {
    // Strip markdown code fences if present
    const cleaned = responseText
      .replace(/^```json?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!parsed.goal || parsed.goal === null) {
      return null; // LLM determined this is a simple request
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }

    // Validate and normalize steps
    const steps: PlanStep[] = parsed.steps.slice(0, 10).map((s: Record<string, unknown>, i: number) => ({
      id: (s.id as string) || `step_${i + 1}`,
      description: (s.description as string) || `Step ${i + 1}`,
      skillName: (s.skillName as string) || '',
      toolName: (s.toolName as string) || '',
      args: (s.args as Record<string, unknown>) || {},
      dependsOn: (s.dependsOn as string[]) || [],
      expectedOutcome: (s.expectedOutcome as string) || '',
      status: 'pending' as const,
      retries: 0,
      // Delegation fields
      type: (s.type as 'tool' | 'delegate') || 'tool',
      choomName: (s.choomName as string) || undefined,
      task: (s.task as string) || undefined,
    }));

    // Validate that all referenced tools exist
    for (const step of steps) {
      const skill = registry.getSkillForTool(step.toolName);
      if (!skill) {
        console.warn(`[Planner] Step ${step.id} references unknown tool: ${step.toolName}`);
        // Don't fail the whole plan; we'll handle it at execution time
      }
    }

    return {
      goal: parsed.goal,
      steps,
      maxRetries: 2,
    };
  } catch (err) {
    console.warn('[Planner] Failed to parse plan JSON:', err instanceof Error ? err.message : err);
    console.warn('[Planner] Raw response:', responseText.slice(0, 500));
    return null;
  }
}

// ============================================================================
// Template variable resolution
// ============================================================================

/**
 * Resolve {{step_N.result.field}} template variables in step arguments
 * using results from previous steps.
 */
function resolveTemplateVars(
  args: Record<string, unknown>,
  completedSteps: Map<string, ToolResult>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      resolved[key] = value.replace(/\{\{(\w+)\.result\.(\w+)\}\}/g, (_match, stepId, field) => {
        const stepResult = completedSteps.get(stepId);
        if (!stepResult?.result || typeof stepResult.result !== 'object') {
          return `[unresolved: ${stepId}.${field}]`;
        }
        const resultObj = stepResult.result as Record<string, unknown>;
        const val = resultObj[field];
        return val !== undefined ? String(val) : `[unresolved: ${stepId}.${field}]`;
      });
      // Also handle {{prev.result.field}} as shorthand for the immediately preceding step
      resolved[key] = (resolved[key] as string).replace(/\{\{prev\.result\.(\w+)\}\}/g, (_match, field) => {
        // Find the last completed step
        let lastResult: ToolResult | undefined;
        for (const [, r] of completedSteps) {
          lastResult = r;
        }
        if (!lastResult?.result || typeof lastResult.result !== 'object') {
          return `[unresolved: prev.${field}]`;
        }
        const resultObj = lastResult.result as Record<string, unknown>;
        const val = resultObj[field];
        return val !== undefined ? String(val) : `[unresolved: prev.${field}]`;
      });
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

// ============================================================================
// Plan execution
// ============================================================================

/**
 * Execute a plan step-by-step with watcher evaluation after each step.
 * Streams progress to the client via the send callback.
 */
export async function executePlan(
  plan: ExecutionPlan,
  executeToolFn: (toolCall: ToolCall, iteration: number) => Promise<ToolResult>,
  watcher: WatcherLoop,
  send: PlanStreamCallback
): Promise<{ succeeded: number; failed: number; results: Map<string, ToolResult> }> {
  const completedSteps = new Map<string, ToolResult>();
  let succeeded = 0;
  let failed = 0;
  let toolCallCounter = 0;

  // Stream plan creation event
  send({
    type: 'plan_created',
    goal: plan.goal,
    steps: plan.steps.map(s => ({
      id: s.id,
      description: s.description,
      toolName: s.type === 'delegate' ? `delegate → ${s.choomName}` : s.toolName,
      status: s.status,
      type: s.type || 'tool',
    })),
  });

  for (const step of plan.steps) {
    // Check dependencies
    const unmetDeps = step.dependsOn.filter(depId => {
      const depStep = plan.steps.find(s => s.id === depId);
      return depStep && depStep.status !== 'completed';
    });

    if (unmetDeps.length > 0) {
      console.log(`[Planner] Skipping step ${step.id}: unmet dependencies [${unmetDeps.join(', ')}]`);
      step.status = 'skipped';
      send({ type: 'plan_step_update', stepId: step.id, status: 'skipped', description: `Skipped: depends on ${unmetDeps.join(', ')}` });
      failed++;
      continue;
    }

    // Resolve template variables (for both args and delegate task text)
    const resolvedArgs = resolveTemplateVars(step.args, completedSteps);
    const resolvedTask = step.task ? resolveTemplateVars({ _task: step.task }, completedSteps)._task as string : undefined;

    // Mark step as running
    step.status = 'running';
    send({ type: 'plan_step_update', stepId: step.id, status: 'running' });

    // Build tool call — delegate steps route through delegate_to_choom
    toolCallCounter++;
    let toolCall: ToolCall;
    if (step.type === 'delegate' && step.choomName) {
      toolCall = {
        id: `plan_tc_${toolCallCounter}`,
        name: 'delegate_to_choom',
        arguments: {
          choom_name: step.choomName,
          task: resolvedTask || step.description,
          context: `Part of plan: "${plan.goal}". Step ${step.id}: ${step.description}`,
        },
      };
      console.log(`[Planner] Step ${step.id}: delegating to "${step.choomName}"`);
    } else {
      toolCall = {
        id: `plan_tc_${toolCallCounter}`,
        name: step.toolName,
        arguments: resolvedArgs,
      };
    }

    // Execute
    let result: ToolResult;
    try {
      result = await executeToolFn(toolCall, toolCallCounter);
      step.result = result;
    } catch (err) {
      result = {
        toolCallId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Execution error: ${err instanceof Error ? err.message : 'Unknown'}`,
      };
      step.result = result;
    }

    // Evaluate with watcher
    const decision = watcher.evaluate(step, result, plan);

    switch (decision.action) {
      case 'continue': {
        step.status = 'completed';
        completedSteps.set(step.id, result);
        succeeded++;
        const resultPreview = result.result
          ? JSON.stringify(result.result).slice(0, 150)
          : result.error || 'No result';
        send({ type: 'plan_step_update', stepId: step.id, status: 'completed', result: resultPreview });
        break;
      }

      case 'retry': {
        if (step.retries < plan.maxRetries) {
          step.retries++;
          console.log(`[Planner] Retrying step ${step.id} (attempt ${step.retries}/${plan.maxRetries}): ${decision.reason}`);
          send({ type: 'plan_step_update', stepId: step.id, status: 'running', description: `Retrying: ${decision.reason}` });

          // Execute again with potentially modified args
          const retryToolCall: ToolCall = {
            id: `plan_tc_${++toolCallCounter}`,
            name: step.toolName,
            arguments: decision.modifiedArgs || resolvedArgs,
          };

          try {
            const retryResult = await executeToolFn(retryToolCall, toolCallCounter);
            step.result = retryResult;

            if (!retryResult.error) {
              step.status = 'completed';
              completedSteps.set(step.id, retryResult);
              succeeded++;
              send({ type: 'plan_step_update', stepId: step.id, status: 'completed', result: JSON.stringify(retryResult.result).slice(0, 150) });
            } else {
              step.status = 'failed';
              failed++;
              send({ type: 'plan_step_update', stepId: step.id, status: 'failed', result: retryResult.error });
            }
          } catch {
            step.status = 'failed';
            failed++;
            send({ type: 'plan_step_update', stepId: step.id, status: 'failed', result: 'Retry failed' });
          }
        } else {
          step.status = 'failed';
          failed++;
          send({ type: 'plan_step_update', stepId: step.id, status: 'failed', result: `Max retries (${plan.maxRetries}) exceeded` });
        }
        break;
      }

      case 'skip': {
        step.status = 'skipped';
        failed++;
        send({ type: 'plan_step_update', stepId: step.id, status: 'skipped', description: decision.reason });
        break;
      }

      case 'rollback': {
        console.log(`[Planner] Rolling back steps: ${decision.stepIds.join(', ')}: ${decision.reason}`);
        // Execute rollback for specified steps
        for (const rollbackId of decision.stepIds) {
          const rbStep = plan.steps.find(s => s.id === rollbackId);
          if (rbStep?.rollbackAction) {
            const rbToolCall: ToolCall = {
              id: `plan_rb_${++toolCallCounter}`,
              name: rbStep.rollbackAction.toolName,
              arguments: rbStep.rollbackAction.args,
            };
            try {
              await executeToolFn(rbToolCall, toolCallCounter);
              rbStep.status = 'rolled_back';
              send({ type: 'plan_step_update', stepId: rbStep.id, status: 'rolled_back', description: 'Rolled back' });
            } catch {
              console.warn(`[Planner] Rollback failed for step ${rollbackId}`);
            }
          }
        }
        step.status = 'failed';
        failed++;
        send({ type: 'plan_step_update', stepId: step.id, status: 'failed', result: `Rolled back: ${decision.reason}` });
        break;
      }

      case 'abort': {
        step.status = 'failed';
        failed++;
        send({ type: 'plan_step_update', stepId: step.id, status: 'failed', result: `Aborted: ${decision.reason}` });
        // Mark all remaining steps as skipped
        for (const remaining of plan.steps) {
          if (remaining.status === 'pending') {
            remaining.status = 'skipped';
            failed++;
            send({ type: 'plan_step_update', stepId: remaining.id, status: 'skipped', description: 'Aborted by watcher' });
          }
        }
        // Early exit
        send({
          type: 'plan_completed',
          summary: `Plan aborted: ${decision.reason}. ${succeeded} succeeded, ${failed} failed/skipped out of ${plan.steps.length} steps.`,
          succeeded,
          failed,
          total: plan.steps.length,
        });
        return { succeeded, failed, results: completedSteps };
      }
    }
  }

  // Stream completion
  const summary = `Plan completed: ${succeeded}/${plan.steps.length} steps succeeded${failed > 0 ? `, ${failed} failed/skipped` : ''}.`;
  send({
    type: 'plan_completed',
    summary,
    succeeded,
    failed,
    total: plan.steps.length,
  });

  return { succeeded, failed, results: completedSteps };
}

/**
 * Generate a human-readable summary of plan execution results.
 */
export function summarizePlan(plan: ExecutionPlan): string {
  const completed = plan.steps.filter(s => s.status === 'completed').length;
  const failed = plan.steps.filter(s => s.status === 'failed').length;
  const skipped = plan.steps.filter(s => s.status === 'skipped').length;
  const rolledBack = plan.steps.filter(s => s.status === 'rolled_back').length;

  const parts = [`${completed}/${plan.steps.length} steps completed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (rolledBack > 0) parts.push(`${rolledBack} rolled back`);

  return `Plan "${plan.goal}": ${parts.join(', ')}`;
}
