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
  // Pivot tracking: when a step's tool fails after maxRetries, the executor
  // can ask the LLM for an alternative shape and rewrite this step in-place.
  // Cap at 1 pivot attempt per step to prevent loops.
  pivoted?: boolean;
  pivotedFrom?: { toolName: string; args: Record<string, unknown>; reason: string };
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  maxRetries: number;
}

export type PlanStreamCallback = (data: Record<string, unknown>) => void;

// SSE event types for plan progress
export interface PlanWaveStartEvent {
  type: 'plan_wave_start';
  wave: number;
  stepIds: string[];
}

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
  // Project-style multi-step requests
  /\b(build|create|set up|start)\b.*\b(project|app|application|system|pipeline|workflow)\b/i,
  /\b(plan|design|architect)\b.*\b(and|then)\b/i,
  /\b(delegate|have \w+ do|ask \w+ to)\b.*\b(and|while|then)\b/i,
  /\bcreate a plan\b/i,
  /\buse.+chooms?\b/i,
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
  tools: ToolDefinition[],
  callerChoomName?: string,
): Promise<ExecutionPlan | null> {
  const skillSummaries = registry.getLevel1Summaries();

  // Build compact parameter reference so the LLM knows required args
  const toolParamRef = tools.map(t => {
    const props = t.parameters?.properties;
    const required = t.parameters?.required || [];
    if (!props || Object.keys(props).length === 0) return `  ${t.name}()`;
    const params = Object.entries(props).map(([name, schema]) => {
      const isReq = required.includes(name);
      const enumVals = schema.enum ? ` [${schema.enum.join('|')}]` : '';
      return `${isReq ? '*' : ''}${name}:${schema.type}${enumVals}`;
    });
    return `  ${t.name}(${params.join(', ')})`;
  }).join('\n');

  const planPrompt: ChatMessage = {
    role: 'user',
    content: `[System — Plan Creation]
You are creating a structured execution plan. Based on the conversation so far, break the user's request into discrete tool-calling steps.

Available skills and tools:
${skillSummaries}

Tool parameters (* = required):
${toolParamRef}

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
- For delegate steps, specify choomName and task (not toolName/args) — the target Choom does its OWN research/work, so delegate steps should NOT depend on your web_search steps
- ONLY use dependsOn when a step truly needs DATA from a previous step's result (e.g. writing a file that uses {{step_1.result.field}}). If a step can run independently, leave dependsOn empty
- Delegate steps are independent by default — the target Choom has its own tools and does its own searches. Do NOT chain delegate steps after web_search steps unless the delegate literally needs a specific result value
- Use {{step_N.result.field}} syntax in args/task to reference previous step outputs
- Limit web_search to 2-3 calls max per plan to avoid rate limiting. Prefer delegating research to other Chooms
- If the request is simple (1-2 steps), respond with: {"goal": null}
- **Prefer 2-4 steps. Maximum 10.** Plans with 6+ steps are rare and only justified when each step is independently verifiable — bigger plans usually mean over-decomposition. Open-ended creative requests ("surprise me") are NOT a license for 10 steps; pick a single creative thread and execute it tightly.
- Only use tools from the available skills listed above${callerChoomName ? `
- **YOU ARE ${callerChoomName}.** Do NOT generate a delegate step with choomName="${callerChoomName}" — you cannot delegate to yourself. If a step needs ${callerChoomName}'s capability, make it a "tool" step using ${callerChoomName}'s own tools, not a "delegate" step.` : ''}
- Every "tool" step MUST have a non-empty toolName. Every "delegate" step MUST have a non-empty choomName + task. Steps missing these fields will be rejected and the plan will be discarded.
- Keep "description" and "expectedOutcome" SHORT — under 80 chars each. The whole plan must fit in the response token budget; verbose descriptions cause JSON truncation and the plan is discarded`,
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
    // Extract JSON from markdown code block anywhere in the response
    // (LLMs often add preamble text before the ```json block)
    const codeBlockMatch = responseText.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/i);
    let cleaned: string;
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    } else {
      // No code block — try the raw response (strip leading/trailing whitespace)
      cleaned = responseText.trim();
    }

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

    // Per-step validation: mark bad steps as pre-failed but KEEP THE PLAN.
    // A 10-step plan with one self-delegation should still execute the other
    // 9 steps. Pre-failing the bad step lets dependents skip with a clear
    // reason, while independent steps proceed normally. Only fall back to
    // the simple loop if EVERY step is invalid (truly nothing to execute).
    let badStepCount = 0;
    for (const step of steps) {
      let reason: string | null = null;

      if (step.type === 'delegate') {
        if (!step.choomName || !String(step.choomName).trim()) {
          reason = 'delegate step has empty choomName';
        } else if (callerChoomName && step.choomName.toLowerCase() === callerChoomName.toLowerCase()) {
          reason = `cannot delegate to yourself (${callerChoomName}) — should have been a direct tool call`;
        } else if (!step.task || !String(step.task).trim()) {
          reason = 'delegate step has empty task';
        }
      } else {
        // type === 'tool'
        if (!step.toolName || !String(step.toolName).trim()) {
          reason = 'tool step has empty toolName';
        } else if (!registry.getSkillForTool(step.toolName)) {
          reason = `unknown tool "${step.toolName}"`;
        }
      }

      if (reason) {
        badStepCount++;
        console.warn(`[Planner] Pre-failing ${step.id}: ${reason}`);
        // Mutate the step so the executor skips it and dependents see the
        // reason in their cascade-skip log lines.
        (step as PlanStep & { status: PlanStep['status']; error?: string }).status = 'failed';
        (step as PlanStep & { error?: string }).error = `Validation: ${reason}`;
      }
    }
    if (badStepCount === steps.length) {
      console.warn('[Planner] All steps failed validation — falling back to simple agentic loop.');
      return null;
    }
    if (badStepCount > 0) {
      console.warn(`[Planner] Plan has ${badStepCount}/${steps.length} pre-failed steps; remaining ${steps.length - badStepCount} will still execute.`);
    }

    return {
      goal: parsed.goal,
      steps,
      maxRetries: 2,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Detect truncation: "Unterminated string" / "Expected ... but reached end"
    // means the LLM ran out of tokens mid-plan. Log it distinctly so it's
    // obvious the plan failed (vs the LLM choosing to skip planning).
    const looksTruncated = /Unterminated|Unexpected end of JSON|Expected.*end of/i.test(errMsg);
    if (looksTruncated) {
      console.warn(`[Planner] Plan JSON appears TRUNCATED (likely hit max_tokens=${responseText.length} chars output). Falling back to simple loop. Consider raising the model's maxTokens or shortening step descriptions.`);
    } else {
      console.warn('[Planner] Failed to parse plan JSON:', errMsg);
    }
    console.warn('[Planner] Raw response (first 500 chars):', responseText.slice(0, 500));
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
      // Handle {{step_N.result.field}} — access a specific field
      resolved[key] = value.replace(/\{\{(\w+)\.result\.(\w+)\}\}/g, (_match, stepId, field) => {
        const stepResult = completedSteps.get(stepId);
        if (!stepResult?.result || typeof stepResult.result !== 'object') {
          return `[unresolved: ${stepId}.${field}]`;
        }
        const resultObj = stepResult.result as Record<string, unknown>;
        const val = resultObj[field];
        return val !== undefined ? String(val) : `[unresolved: ${stepId}.${field}]`;
      });
      // Handle {{step_N.result}} — entire result (no field name)
      resolved[key] = (resolved[key] as string).replace(/\{\{(\w+)\.result\}\}/g, (_match, stepId) => {
        const stepResult = completedSteps.get(stepId);
        if (!stepResult?.result) {
          return `[unresolved: ${stepId}]`;
        }
        const r = stepResult.result;
        if (typeof r === 'string') return r;
        // For objects, prefer 'formatted' field (human-readable), then JSON
        if (typeof r === 'object' && r !== null) {
          const obj = r as Record<string, unknown>;
          if (typeof obj.formatted === 'string') return obj.formatted;
          return JSON.stringify(r);
        }
        return String(r);
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
      // Handle {{prev.result}} — entire result of preceding step
      resolved[key] = (resolved[key] as string).replace(/\{\{prev\.result\}\}/g, () => {
        let lastResult: ToolResult | undefined;
        for (const [, r] of completedSteps) {
          lastResult = r;
        }
        if (!lastResult?.result) return '[unresolved: prev]';
        const r = lastResult.result;
        if (typeof r === 'string') return r;
        if (typeof r === 'object' && r !== null) {
          const obj = r as Record<string, unknown>;
          if (typeof obj.formatted === 'string') return obj.formatted;
          return JSON.stringify(r);
        }
        return String(r);
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
 * Execute a single plan step: build tool call, run it, handle retries.
 * Returns the final ToolResult after execution + any retries.
 */
/**
 * Step-level pivot. When a plan step's tool has failed after maxRetries,
 * ask the LLM for an alternative shape (different tool or different
 * arguments — same outcome) before giving up and cascading. Returns a
 * mutated copy of the step's tool/args/etc. on success, or null when no
 * viable alternative could be parsed.
 *
 * Capped: caller MUST set step.pivoted = true after applying so this is
 * not invoked twice on the same step.
 */
async function pivotStep(opts: {
  step: PlanStep;
  errorMessage: string;
  plan: ExecutionPlan;
  registry: SkillRegistry;
  llmClient: LLMClientLike;
  callerChoomName?: string;
}): Promise<Pick<PlanStep, 'type' | 'toolName' | 'args' | 'choomName' | 'task' | 'description'> | null> {
  const { step, errorMessage, plan, registry, llmClient, callerChoomName } = opts;

  // Compact skill catalog so the LLM sees what's available to substitute.
  const skillSummaries = registry.getLevel1Summaries();

  const originalShape =
    step.type === 'delegate'
      ? `delegate(choomName="${step.choomName || ''}", task=...)`
      : `${step.toolName}(${Object.keys(step.args).join(', ')})`;

  const pivotPrompt: ChatMessage = {
    role: 'user',
    content: `[System — Plan Step Pivot]
A plan step has failed after the maximum number of retries. Generate ONE alternative step that achieves the SAME outcome via a different approach.

Plan goal: ${plan.goal}
Step that failed:
  id: ${step.id}
  description: ${step.description}
  expectedOutcome: ${step.expectedOutcome}
  original shape: ${originalShape}

Failure reason:
${errorMessage.slice(0, 800)}

${callerChoomName ? `You are ${callerChoomName}. Do NOT generate a delegate step with choomName="${callerChoomName}" — that's self-delegation and will be rejected.\n\n` : ''}Available skills and tools:
${skillSummaries}

Rules for the alternative:
- Reach the SAME expectedOutcome — don't lower the bar.
- Either pick a different tool entirely OR keep the same tool with materially different arguments. Don't just retry the same call.
- If the original was a tool step, the alternative can be either tool or delegate. Same in reverse.
- If no viable alternative exists, respond with: {"alternative": null, "reason": "short explanation"}

Respond with ONLY a JSON object (no markdown):
{
  "alternative": {
    "type": "tool" | "delegate",
    "description": "short — under 80 chars",
    "toolName": "...",          // for type=tool
    "args": { ... },            // for type=tool
    "choomName": "...",         // for type=delegate (must NOT equal "${callerChoomName || ''}")
    "task": "..."               // for type=delegate
  },
  "rationale": "one sentence explaining why this should work where the original didn't"
}`,
  };

  let responseText = '';
  try {
    for await (const chunk of llmClient.streamChat([pivotPrompt], [], undefined, 'none')) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) responseText += choice.delta.content;
    }
  } catch (err) {
    console.warn(`[Planner] Pivot LLM call failed for ${step.id}:`, err instanceof Error ? err.message : err);
    return null;
  }

  // Parse JSON, tolerating ```json``` wrapping and stray prose
  let cleaned = responseText.trim();
  const codeBlockMatch = cleaned.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

  let parsed: { alternative?: Record<string, unknown> | null; rationale?: string } | null = null;
  try { parsed = JSON.parse(cleaned); } catch { return null; }
  if (!parsed?.alternative) {
    console.log(`[Planner] Pivot for ${step.id}: LLM declined (no viable alternative)`);
    return null;
  }

  const alt = parsed.alternative;
  const altType = (alt.type as string) === 'delegate' ? 'delegate' : 'tool';

  if (altType === 'delegate') {
    const altChoom = String(alt.choomName || '').trim();
    const altTask = String(alt.task || '').trim();
    if (!altChoom || !altTask) return null;
    if (callerChoomName && altChoom.toLowerCase() === callerChoomName.toLowerCase()) {
      console.log(`[Planner] Pivot for ${step.id}: rejected — self-delegation`);
      return null;
    }
    return {
      type: 'delegate',
      toolName: '',
      args: {},
      choomName: altChoom,
      task: altTask,
      description: String(alt.description || step.description).slice(0, 80),
    };
  }

  const altToolName = String(alt.toolName || '').trim();
  if (!altToolName) return null;
  if (!registry.getSkillForTool(altToolName)) {
    console.log(`[Planner] Pivot for ${step.id}: rejected — unknown tool "${altToolName}"`);
    return null;
  }
  // Reject if the alternative is byte-identical to the original (no real pivot)
  const altArgs = (alt.args as Record<string, unknown>) || {};
  if (
    altToolName === step.toolName &&
    JSON.stringify(altArgs) === JSON.stringify(step.args)
  ) {
    console.log(`[Planner] Pivot for ${step.id}: rejected — alternative identical to original`);
    return null;
  }
  return {
    type: 'tool',
    toolName: altToolName,
    args: altArgs,
    choomName: undefined,
    task: undefined,
    description: String(alt.description || step.description).slice(0, 80),
  };
}

async function executeStep(
  step: PlanStep,
  plan: ExecutionPlan,
  completedSteps: Map<string, ToolResult>,
  executeToolFn: (toolCall: ToolCall, iteration: number) => Promise<ToolResult>,
  watcher: WatcherLoop,
  send: PlanStreamCallback,
  toolCallCounter: { value: number },
  delayMs: number = 0,
): Promise<{ step: PlanStep; result: ToolResult; decision: ReturnType<WatcherLoop['evaluate']> }> {
  // Rate-limit stagger: delay before execution if requested (e.g. web_search in parallel wave)
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  // Resolve template variables (for both args and delegate task text)
  const resolvedArgs = resolveTemplateVars(step.args, completedSteps);
  const resolvedTask = step.task ? resolveTemplateVars({ _task: step.task }, completedSteps)._task as string : undefined;

  // Mark step as running
  step.status = 'running';
  send({ type: 'plan_step_update', stepId: step.id, status: 'running' });

  // Build tool call — delegate steps route through delegate_to_choom
  const tcId = ++toolCallCounter.value;
  let toolCall: ToolCall;
  if (step.type === 'delegate' && step.choomName) {
    toolCall = {
      id: `plan_tc_${tcId}`,
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
      id: `plan_tc_${tcId}`,
      name: step.toolName,
      arguments: resolvedArgs,
    };
  }

  // Execute
  let result: ToolResult;
  try {
    result = await executeToolFn(toolCall, tcId);
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

  // Handle retry inline (step stays in same wave cycle)
  if (decision.action === 'retry' && step.retries < plan.maxRetries) {
    step.retries++;
    console.log(`[Planner] Retrying step ${step.id} (attempt ${step.retries}/${plan.maxRetries}): ${decision.reason}`);
    send({ type: 'plan_step_update', stepId: step.id, status: 'running', description: `Retrying: ${decision.reason}` });

    const retryToolCall: ToolCall = {
      id: `plan_tc_${++toolCallCounter.value}`,
      name: step.type === 'delegate' ? 'delegate_to_choom' : step.toolName,
      arguments: decision.modifiedArgs || resolvedArgs,
    };

    try {
      const retryResult = await executeToolFn(retryToolCall, toolCallCounter.value);
      step.result = retryResult;
      const retryDecision = watcher.evaluate(step, retryResult, plan);
      return { step, result: retryResult, decision: retryDecision };
    } catch {
      const failResult: ToolResult = {
        toolCallId: retryToolCall.id, name: retryToolCall.name,
        result: null, error: 'Retry failed',
      };
      step.result = failResult;
      return { step, result: failResult, decision: { action: 'skip', reason: 'Retry execution failed' } };
    }
  }

  return { step, result, decision };
}

/**
 * Execute a plan using wave-based parallel scheduling.
 * Steps with satisfied dependencies run concurrently within each wave.
 * Streams progress to the client via the send callback.
 */
export async function executePlan(
  plan: ExecutionPlan,
  executeToolFn: (toolCall: ToolCall, iteration: number) => Promise<ToolResult>,
  watcher: WatcherLoop,
  send: PlanStreamCallback,
  pivotCtx?: {
    registry: SkillRegistry;
    llmClient: LLMClientLike;
    callerChoomName?: string;
  },
): Promise<{ succeeded: number; failed: number; results: Map<string, ToolResult> }> {
  const completedSteps = new Map<string, ToolResult>();
  const completedIds = new Set<string>();
  let succeeded = 0;
  // Pre-count steps that failed validation at plan-creation time. Their
  // dependents will get cascade-skipped by the deadlock pass below;
  // independent steps will still execute. We just need the live tally to
  // reflect that some steps were dead before we even started.
  let failed = plan.steps.filter(s => s.status === 'failed').length;
  if (failed > 0) {
    console.log(`[Planner] ${failed} step(s) pre-failed at validation; remaining ${plan.steps.length - failed} will execute`);
  }
  const toolCallCounter = { value: 0 }; // Shared mutable counter across parallel steps
  let aborted = false;

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

  let waveNum = 0;

  while (!aborted) {
    // Find all steps whose dependencies are fully satisfied
    const readySteps = plan.steps.filter(s =>
      s.status === 'pending' && s.dependsOn.every(depId => completedIds.has(depId))
    );

    if (readySteps.length === 0) break; // All done or deadlocked

    waveNum++;
    const isParallel = readySteps.length > 1;
    console.log(`[Planner] Wave ${waveNum}: ${readySteps.length} step(s) [${readySteps.map(s => s.id).join(', ')}]${isParallel ? ' (parallel)' : ''}`);

    send({
      type: 'plan_wave_start',
      wave: waveNum,
      stepIds: readySteps.map(s => s.id),
    });

    // Reset watcher consecutive failures at the start of each wave
    // to prevent N parallel failures in one wave from prematurely aborting
    watcher.reset();

    // Calculate per-step delays for rate limiting (stagger web_search calls by 2s)
    const stepDelays = new Map<string, number>();
    let webSearchDelay = 0;
    for (const step of readySteps) {
      const toolName = step.type === 'delegate' ? 'delegate_to_choom' : step.toolName;
      if (toolName === 'web_search') {
        stepDelays.set(step.id, webSearchDelay);
        webSearchDelay += 2000;
      } else {
        stepDelays.set(step.id, 0);
      }
    }

    // Execute all ready steps concurrently
    const waveResults = await Promise.allSettled(
      readySteps.map(step =>
        executeStep(
          step, plan, completedSteps, executeToolFn, watcher, send,
          toolCallCounter, stepDelays.get(step.id) || 0,
        )
      )
    );

    // Process wave results
    for (const settled of waveResults) {
      if (settled.status === 'rejected') {
        // Unexpected — executeStep catches errors internally, but handle gracefully
        console.warn(`[Planner] Wave ${waveNum}: step rejected unexpectedly:`, settled.reason);
        failed++;
        continue;
      }

      const { step, result, decision } = settled.value;

      switch (decision.action) {
        case 'continue': {
          step.status = 'completed';
          completedSteps.set(step.id, result);
          completedIds.add(step.id);
          succeeded++;
          const resultPreview = result.result
            ? JSON.stringify(result.result).slice(0, 150)
            : result.error || 'No result';
          send({ type: 'plan_step_update', stepId: step.id, status: 'completed', result: resultPreview });
          break;
        }

        case 'retry': {
          // Retries were exhausted inside executeStep. Before giving up, try
          // a pivot: ask the LLM for an alternative shape (different tool or
          // different args, same outcome). Only attempt once per step. If a
          // viable alternative comes back, mutate the step in-place and
          // requeue (status='pending') so the next wave picks it up. If not,
          // mark failed and cascade as before.
          const pivotErrMessage = result.error || 'Max retries exceeded with no specific error';
          let pivoted = false;
          if (pivotCtx && !step.pivoted) {
            try {
              const alt = await pivotStep({
                step,
                errorMessage: pivotErrMessage,
                plan,
                registry: pivotCtx.registry,
                llmClient: pivotCtx.llmClient,
                callerChoomName: pivotCtx.callerChoomName,
              });
              if (alt) {
                console.log(
                  `[Planner] 🔀 Pivoting ${step.id}: ${step.type === 'delegate' ? 'delegate→' + step.choomName : step.toolName} → ${alt.type === 'delegate' ? 'delegate→' + alt.choomName : alt.toolName}`,
                );
                step.pivotedFrom = {
                  toolName: step.toolName,
                  args: step.args,
                  reason: pivotErrMessage.slice(0, 200),
                };
                step.type = alt.type;
                step.toolName = alt.toolName;
                step.args = alt.args;
                step.choomName = alt.choomName;
                step.task = alt.task;
                step.description = alt.description;
                step.pivoted = true;
                step.retries = 0;       // fresh retry budget for the new shape
                step.status = 'pending';
                send({
                  type: 'plan_step_update',
                  stepId: step.id,
                  status: 'pending',
                  description: `Pivoted to: ${alt.type === 'delegate' ? `delegate→${alt.choomName}` : alt.toolName}`,
                });
                pivoted = true;
              }
            } catch (pivotErr) {
              console.warn(`[Planner] Pivot attempt for ${step.id} threw:`, pivotErr instanceof Error ? pivotErr.message : pivotErr);
            }
          }
          if (!pivoted) {
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
          for (const rollbackId of decision.stepIds) {
            const rbStep = plan.steps.find(s => s.id === rollbackId);
            if (rbStep?.rollbackAction) {
              const rbToolCall: ToolCall = {
                id: `plan_rb_${++toolCallCounter.value}`,
                name: rbStep.rollbackAction.toolName,
                arguments: rbStep.rollbackAction.args,
              };
              try {
                await executeToolFn(rbToolCall, toolCallCounter.value);
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
          aborted = true;
          break;
        }
      }
    }

    // If abort was triggered, mark all remaining pending steps as skipped
    if (aborted) {
      for (const remaining of plan.steps) {
        if (remaining.status === 'pending') {
          remaining.status = 'skipped';
          failed++;
          send({ type: 'plan_step_update', stepId: remaining.id, status: 'skipped', description: 'Aborted by watcher' });
        }
      }
      const summary = `Plan aborted. ${succeeded} succeeded, ${failed} failed/skipped out of ${plan.steps.length} steps.`;
      send({ type: 'plan_completed', summary, succeeded, failed, total: plan.steps.length });
      return { succeeded, failed, results: completedSteps };
    }
  }

  // Check for deadlocked steps (pending with unmet deps that will never resolve)
  const deadlocked = plan.steps.filter(s => s.status === 'pending');
  for (const step of deadlocked) {
    step.status = 'skipped';
    failed++;
    const unmetDeps = step.dependsOn.filter(d => !completedIds.has(d));
    console.log(`[Planner] Skipping step ${step.id}: unresolvable dependencies [${unmetDeps.join(', ')}]`);
    send({ type: 'plan_step_update', stepId: step.id, status: 'skipped', description: `Skipped: depends on failed/skipped steps [${unmetDeps.join(', ')}]` });
  }

  // Stream completion
  const summary = `Plan completed: ${succeeded}/${plan.steps.length} steps succeeded${failed > 0 ? `, ${failed} failed/skipped` : ''}.`;
  send({ type: 'plan_completed', summary, succeeded, failed, total: plan.steps.length });
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
