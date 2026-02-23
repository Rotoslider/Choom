import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { getSkillRegistry } from '@/lib/skill-registry';
import { executePlan } from '@/lib/planner-loop';
import type { PlanStep, ExecutionPlan } from '@/lib/planner-loop';
import { WatcherLoop } from '@/lib/watcher-loop';

const PLAN_TOOLS = new Set(['create_plan', 'execute_plan', 'adjust_plan']);

// Module-level store for active plans (per-request lifecycle)
const activePlans = new Map<string, ExecutionPlan>();
let planCounter = 0;

export default class PlanModeHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return PLAN_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'create_plan':
        return this.createPlan(toolCall);
      case 'execute_plan':
        return this.executePlan(toolCall, ctx);
      case 'adjust_plan':
        return this.adjustPlan(toolCall);
      default:
        return this.error(toolCall, `Unknown plan tool: ${toolCall.name}`);
    }
  }

  private createPlan(toolCall: ToolCall): ToolResult {
    try {
      const goal = toolCall.arguments.goal as string;
      let steps = toolCall.arguments.steps as Array<Record<string, unknown>>;

      if (!goal) return this.error(toolCall, 'goal is required');
      if (!Array.isArray(steps) || steps.length === 0) {
        return this.error(toolCall, 'steps must be a non-empty array');
      }

      // Parse steps if passed as string (LLMs sometimes stringify)
      if (typeof steps === 'string') {
        try { steps = JSON.parse(steps); } catch { return this.error(toolCall, 'steps must be a valid array'); }
      }

      // Cap at 10 steps
      steps = steps.slice(0, 10);

      const registry = getSkillRegistry();
      const warnings: string[] = [];

      const planSteps: PlanStep[] = steps.map((s, i) => {
        const id = (s.id as string) || `step_${i + 1}`;
        const toolName = (s.toolName as string) || '';

        // Validate: tool steps need valid tool, delegate steps need choomName
        const stepType = (s.type as string) || 'tool';
        if (stepType === 'delegate') {
          if (!s.choomName) {
            warnings.push(`Step ${id}: delegate step requires choomName`);
          }
        } else if (toolName && !registry.getSkillForTool(toolName)) {
          warnings.push(`Step ${id}: tool "${toolName}" not found in registry`);
        }

        return {
          id,
          description: (s.description as string) || `Step ${i + 1}`,
          skillName: '', // Resolved at execution time
          toolName,
          args: (s.args as Record<string, unknown>) || {},
          dependsOn: (s.dependsOn as string[]) || [],
          expectedOutcome: (s.expectedOutcome as string) || '',
          status: 'pending' as const,
          retries: 0,
          // Delegation support
          type: (s.type as 'tool' | 'delegate') || 'tool',
          choomName: (s.choomName as string) || undefined,
          task: (s.task as string) || undefined,
        };
      });

      const planId = `plan_${++planCounter}_${Date.now()}`;
      const plan: ExecutionPlan = {
        goal,
        steps: planSteps,
        maxRetries: 2,
      };

      activePlans.set(planId, plan);

      console.log(`   📋 Plan created: "${goal}" with ${planSteps.length} steps (${planId})`);

      return this.success(toolCall, {
        success: true,
        plan_id: planId,
        goal,
        steps: planSteps.map(s => ({
          id: s.id,
          description: s.description,
          type: s.type || 'tool',
          toolName: s.type === 'delegate' ? `delegate → ${s.choomName}` : s.toolName,
          dependsOn: s.dependsOn,
        })),
        warnings: warnings.length > 0 ? warnings : undefined,
        message: `Plan created with ${planSteps.length} steps. Use execute_plan with plan_id "${planId}" to run it.`,
      });
    } catch (err) {
      console.error('   ❌ Plan create error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to create plan: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async executePlan(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const planId = toolCall.arguments.plan_id as string;
      if (!planId) return this.error(toolCall, 'plan_id is required');

      const plan = activePlans.get(planId);
      if (!plan) return this.error(toolCall, `Plan not found: ${planId}. It may have expired.`);

      const registry = getSkillRegistry();
      const watcher = new WatcherLoop();

      // Tool executor: dispatch through skill registry
      const executeToolFn = async (tc: ToolCall, _iteration: number): Promise<ToolResult> => {
        const skill = registry.getSkillForTool(tc.name);
        if (!skill) {
          return {
            toolCallId: tc.id,
            name: tc.name,
            result: null,
            error: `Tool "${tc.name}" not found in skill registry`,
          };
        }

        try {
          return await skill.handler.execute(tc, ctx);
        } catch (err) {
          return {
            toolCallId: tc.id,
            name: tc.name,
            result: null,
            error: `Handler error: ${err instanceof Error ? err.message : 'Unknown'}`,
          };
        }
      };

      console.log(`   📋 Executing plan: "${plan.goal}" (${planId})`);

      const result = await executePlan(plan, executeToolFn, watcher, ctx.send);

      const summary = `Plan "${plan.goal}": ${result.succeeded}/${plan.steps.length} steps succeeded${result.failed > 0 ? `, ${result.failed} failed/skipped` : ''}`;
      console.log(`   📋 ${summary}`);

      // Collect step results for the response
      const stepResults = plan.steps.map(s => ({
        id: s.id,
        description: s.description,
        toolName: s.toolName,
        status: s.status,
        result: s.result?.result ? JSON.stringify(s.result.result).slice(0, 200) : s.result?.error || null,
      }));

      return this.success(toolCall, {
        success: result.failed === 0,
        summary,
        succeeded: result.succeeded,
        failed: result.failed,
        total: plan.steps.length,
        steps: stepResults,
      });
    } catch (err) {
      console.error('   ❌ Plan execute error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to execute plan: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private adjustPlan(toolCall: ToolCall): ToolResult {
    try {
      const planId = toolCall.arguments.plan_id as string;
      let modifications = toolCall.arguments.modifications as Array<Record<string, unknown>>;

      if (!planId) return this.error(toolCall, 'plan_id is required');
      if (!Array.isArray(modifications) || modifications.length === 0) {
        return this.error(toolCall, 'modifications must be a non-empty array');
      }

      // Parse if stringified
      if (typeof modifications === 'string') {
        try { modifications = JSON.parse(modifications); } catch { return this.error(toolCall, 'modifications must be a valid array'); }
      }

      const plan = activePlans.get(planId);
      if (!plan) return this.error(toolCall, `Plan not found: ${planId}`);

      let modified = 0;
      let skipped = 0;
      let added = 0;

      for (const mod of modifications) {
        const stepId = mod.stepId as string;
        const action = mod.action as string;

        switch (action) {
          case 'modify': {
            const step = plan.steps.find(s => s.id === stepId);
            if (step && step.status === 'pending') {
              const newArgs = mod.newArgs as Record<string, unknown>;
              if (newArgs) step.args = { ...step.args, ...newArgs };
              modified++;
            }
            break;
          }
          case 'skip': {
            const step = plan.steps.find(s => s.id === stepId);
            if (step && step.status === 'pending') {
              step.status = 'skipped';
              skipped++;
            }
            break;
          }
          case 'add': {
            const newStep = mod.newStep as Record<string, unknown>;
            if (newStep) {
              const newId = `step_added_${plan.steps.length + 1}`;
              plan.steps.push({
                id: newId,
                description: (newStep.description as string) || 'Added step',
                skillName: '',
                toolName: (newStep.toolName as string) || '',
                args: (newStep.args as Record<string, unknown>) || {},
                dependsOn: (newStep.dependsOn as string[]) || [],
                expectedOutcome: '',
                status: 'pending',
                retries: 0,
              });
              added++;
            }
            break;
          }
        }
      }

      console.log(`   📋 Plan adjusted: ${modified} modified, ${skipped} skipped, ${added} added`);

      return this.success(toolCall, {
        success: true,
        plan_id: planId,
        modified,
        skipped,
        added,
        remainingSteps: plan.steps.filter(s => s.status === 'pending').map(s => ({
          id: s.id,
          description: s.description,
          toolName: s.toolName,
        })),
        message: `Plan adjusted: ${modified} modified, ${skipped} skipped, ${added} added.`,
      });
    } catch (err) {
      console.error('   ❌ Plan adjust error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to adjust plan: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
