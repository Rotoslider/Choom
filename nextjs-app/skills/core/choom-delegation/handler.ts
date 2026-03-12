import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';

const TOOL_NAMES = new Set(['delegate_to_choom', 'list_team', 'get_delegation_result']);

// Cache delegation results for retrieval within the session
const delegationResults = new Map<string, DelegationResult>();
let delegationCounter = 0;

interface DelegationResult {
  id: string;
  choomName: string;
  task: string;
  response: string;
  toolCalls: Array<{ name: string; result?: unknown }>;
  timestamp: number;
  durationMs: number;
  chatId: string;
  choomId: string;
  incomplete: boolean;
  iterationsUsed: number;
  maxIterations: number;
}

export default class ChoomDelegationHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'delegate_to_choom':
        return this.delegateToChoom(toolCall, ctx);
      case 'list_team':
        return this.listTeam(toolCall, ctx);
      case 'get_delegation_result':
        return this.getDelegationResult(toolCall);
      default:
        return this.error(toolCall, `Unknown delegation tool: ${toolCall.name}`);
    }
  }

  // ===========================================================================
  // list_team — Show all available Chooms
  // ===========================================================================

  private async listTeam(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const chooms = await prisma.choom.findMany({
        select: {
          id: true,
          name: true,
          description: true,
          systemPrompt: true,
          llmModel: true,
          llmEndpoint: true,
        },
        orderBy: { name: 'asc' },
      });

      const team = chooms
        .filter(c => c.id !== ctx.choomId) // Exclude self
        .map(c => ({
          name: c.name,
          description: c.description || '(no description)',
          model: c.llmModel || '(uses global default)',
          specialization: extractSpecialization(c.systemPrompt || ''),
        }));

      return this.success(toolCall, {
        success: true,
        team,
        count: team.length,
        message: `${team.length} Chooms available for delegation.`,
      });
    } catch (err) {
      return this.error(toolCall, `Failed to list team: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }

  // ===========================================================================
  // delegate_to_choom — Send task to another Choom via internal API call
  // ===========================================================================

  private async delegateToChoom(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const choomName = toolCall.arguments.choom_name as string;
    const task = toolCall.arguments.task as string;
    const extraContext = toolCall.arguments.context as string | undefined;
    const timeoutSeconds = Math.min(900, Math.max(30, (toolCall.arguments.timeout_seconds as number) || 600));
    const continueDelegationId = toolCall.arguments.continue_delegation_id as string | undefined;

    if (!choomName) return this.error(toolCall, 'choom_name is required');
    if (!task) return this.error(toolCall, 'task is required');

    const startTime = Date.now();

    try {
      // 1. If continuing a previous delegation, reuse the same Choom and chat
      let targetChoom: { id: string; name: string } | undefined;
      let delegationChatId: string;
      let delegationId: string;
      let isContinuation = false;

      if (continueDelegationId) {
        const prev = delegationResults.get(continueDelegationId);
        if (!prev) {
          return this.error(toolCall, `Previous delegation "${continueDelegationId}" not found. Cannot continue.`);
        }
        // Reuse the same chat so the Choom has full conversation history
        const allChooms = await prisma.choom.findMany();
        targetChoom = allChooms.find(c => c.name.toLowerCase() === prev.choomName.toLowerCase());
        if (!targetChoom) {
          return this.error(toolCall, `Choom "${prev.choomName}" no longer available.`);
        }
        delegationChatId = prev.chatId;
        delegationId = `${continueDelegationId}_cont_${Date.now()}`;
        isContinuation = true;
        console.log(`   🔄 Continuing delegation ${continueDelegationId} to "${targetChoom.name}" (chat: ${delegationChatId})`);
      } else {
        // Find target Choom fresh
        // SQLite: case-insensitive lookup via fetching all and comparing
        const allChooms = await prisma.choom.findMany();
        targetChoom = allChooms.find(
          c => c.name.toLowerCase() === choomName.toLowerCase()
        );

        if (!targetChoom) {
          const names = allChooms.map(c => c.name).join(', ');
          return this.error(toolCall, `Choom "${choomName}" not found. Available: ${names}`);
        }

        if (targetChoom.id === ctx.choomId) {
          return this.error(toolCall, 'Cannot delegate to yourself. Use tools directly instead.');
        }

        // Create a dedicated delegation chat
        delegationId = `deleg_${++delegationCounter}_${Date.now()}`;
        const delegationChat = await prisma.chat.create({
          data: {
            choomId: targetChoom.id,
            title: `[Delegation] ${task.slice(0, 50)}...`,
          },
        });
        delegationChatId = delegationChat.id;
      }

      // 3. Build the delegation message with context
      let fullTask = task;
      if (extraContext) {
        fullTask = `## Context from orchestrator\n${extraContext}\n\n## Your Task\n${task}`;
      }

      // Include active project context if the orchestrator has one
      const activeProject = ctx.activeProjectFolder;
      const projectContext = activeProject
        ? `\n- IMPORTANT: Work inside the existing project folder "${activeProject}". Do NOT create a new project — use workspace_write_file with project_folder="${activeProject}" for all file operations.`
        : '';

      // Build delegation message — different phrasing for continuation vs fresh
      let delegationMessage: string;
      if (isContinuation) {
        delegationMessage = `[CONTINUATION — from ${(ctx.choom as Record<string, unknown>).name || 'Orchestrator'}]\n\nYour previous work was cut short. Continue where you left off.\n\n## Updated Instructions\n${fullTask}\n\nRULES:\n- You have the full conversation history above — do NOT re-read files you already read.\n- Pick up from where you stopped and complete the remaining work.\n- Use as many tool calls as needed.${projectContext}\n- Provide a complete summary of ALL work done (previous + this continuation).`;
      } else {
        delegationMessage = `[DELEGATED TASK from ${(ctx.choom as Record<string, unknown>).name || 'Orchestrator'}]\n\n${fullTask}\n\nRULES FOR THIS TASK:\n- Complete this task DIRECTLY using your own tools. Do NOT delegate to other Chooms.\n- Use the most specific tool available (e.g., get_weather for weather, not web_search).\n- Use as many tool calls as needed to fully complete the task. Read all necessary files before making changes.${projectContext}\n- IMPORTANT: Your full response text will be returned to the orchestrator. Provide a complete summary of what you did, what you changed, and any issues found.`;
      }

      console.log(`   🤝 ${isContinuation ? 'Continuing' : 'Delegating to'} "${targetChoom.name}" (${delegationId}): ${task.slice(0, 80)}...`);

      // Stream SSE update to the client
      ctx.send({
        type: 'delegation_started',
        delegationId,
        targetChoom: targetChoom.name,
        task: task.slice(0, 100),
      });

      // 4. Make internal API call to /api/chat
      const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            choomId: targetChoom.id,
            chatId: delegationChatId,
            message: delegationMessage,
            settings: ctx.settings, // Forward shared settings (weather, search, etc.)
            isDelegation: true, // Tells chat route: strip delegation tools, disable plan detection
          }),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timeout);
        if ((fetchErr as Error).name === 'AbortError') {
          return this.error(toolCall, `Delegation to "${targetChoom.name}" timed out after ${timeoutSeconds}s`);
        }
        throw fetchErr;
      }

      if (!response.ok) {
        clearTimeout(timeout);
        const errText = await response.text();
        return this.error(toolCall, `Delegation API error (${response.status}): ${errText.slice(0, 200)}`);
      }

      // 5. Parse SSE stream from the target Choom's response
      const reader = response.body?.getReader();
      if (!reader) {
        clearTimeout(timeout);
        return this.error(toolCall, 'No response stream from target Choom');
      }

      const decoder = new TextDecoder();
      let content = '';
      let doneContent = ''; // Content from the 'done' event (final authoritative text)
      const toolCallsUsed: Array<{ name: string; result?: unknown }> = [];
      const toolResultTexts: string[] = []; // Capture tool result text for fallback
      let buffer = '';
      let eventCount = 0;
      let sseError = '';
      let doneIterations = 0;
      let doneMaxIterations = 0;
      let doneStatus = 'complete';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              eventCount++;
              switch (data.type) {
                case 'content':
                  content += data.content || '';
                  break;
                case 'tool_call':
                  console.log(`   🤝 [${targetChoom.name}] tool_call: ${data.toolCall?.name}`);
                  toolCallsUsed.push({ name: data.toolCall?.name || 'unknown' });
                  break;
                case 'tool_result': {
                  // Capture tool result text as fallback content
                  const resultData = data.toolResult?.result;
                  if (resultData) {
                    const resultStr = typeof resultData === 'string'
                      ? resultData.slice(0, 1000)
                      : JSON.stringify(resultData).slice(0, 1000);
                    toolResultTexts.push(resultStr);
                  }
                  // Update the last tool call with its result
                  if (toolCallsUsed.length > 0) {
                    const last = toolCallsUsed[toolCallsUsed.length - 1];
                    if (resultData) {
                      last.result = typeof resultData === 'string'
                        ? resultData.slice(0, 500)
                        : JSON.stringify(resultData).slice(0, 500);
                    }
                  }
                  break;
                }
                case 'done':
                  if (data.content) doneContent = data.content;
                  if (data.iteration) doneIterations = data.iteration;
                  if (data.maxIterations) doneMaxIterations = data.maxIterations;
                  if (data.status) doneStatus = data.status;
                  break;
                case 'error':
                  sseError = data.error || 'Unknown SSE error';
                  console.error(`   🤝 [${targetChoom.name}] SSE error: ${sseError}`);
                  break;
                case 'agent_iteration':
                  console.log(`   🤝 [${targetChoom.name}] iteration ${data.iteration}/${data.maxIterations}`);
                  break;
              }
            } catch {
              // Skip unparseable SSE lines
            }
          }
        }
      } catch (streamErr) {
        // AbortController fired during stream read = timeout
        clearTimeout(timeout);
        reader.releaseLock();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if ((streamErr as Error).name === 'AbortError') {
          // If we got partial content, return it as a partial result instead of failing
          if (content.trim().length > 20 || toolCallsUsed.length > 0) {
            console.warn(`   ⚠️  [${targetChoom.name}] Delegation timed out after ${elapsed}s but has partial results (${content.length} chars, ${toolCallsUsed.length} tool calls) — returning partial`);
            const partialResponse = content.trim() || `[${targetChoom.name} timed out after ${elapsed}s with ${toolCallsUsed.length} tool calls but no text response]`;
            const result: DelegationResult = {
              id: delegationId,
              choomName: targetChoom.name,
              task,
              response: partialResponse,
              toolCalls: toolCallsUsed,
              timestamp: Date.now(),
              durationMs: Date.now() - startTime,
              chatId: delegationChatId,
              choomId: targetChoom.id,
              incomplete: true,
              iterationsUsed: doneIterations,
              maxIterations: doneMaxIterations,
            };
            delegationResults.set(delegationId, result);
            return this.success(toolCall, {
              success: true,
              delegation_id: delegationId,
              choom_name: targetChoom.name,
              response: partialResponse,
              tools_used: toolCallsUsed.map(tc => tc.name),
              duration_seconds: elapsed,
              incomplete: true,
              message: `${targetChoom.name} timed out after ${elapsed}s but partial work was captured. You can continue with continue_delegation_id="${delegationId}".`,
            });
          }
          return this.error(toolCall, `Delegation to "${targetChoom.name}" timed out after ${elapsed}s (${timeoutSeconds}s limit). ${toolCallsUsed.length > 0 ? `${toolCallsUsed.length} tools were called before timeout.` : 'No tools were called.'}`);
        }
        throw streamErr;
      } finally {
        clearTimeout(timeout);
        reader.releaseLock();
      }

      // If we got an SSE error, return it
      if (sseError) {
        return this.error(toolCall, `${targetChoom.name} error: ${sseError}`);
      }

      // Use 'done' content as authoritative if available, otherwise accumulated content
      const finalContent = doneContent || content;

      const durationMs = Date.now() - startTime;

      // Detect empty/near-empty responses and provide useful fallback
      const trimmedContent = finalContent.trim();
      let effectiveResponse = trimmedContent;

      if (trimmedContent.length < 10) {
        console.warn(`   ⚠️  [${targetChoom.name}] Nearly empty response (${trimmedContent.length} chars, ${eventCount} SSE events, ${toolCallsUsed.length} tool calls)`);

        if (toolResultTexts.length > 0) {
          // Use tool results as the response — the model used tools but didn't summarize
          effectiveResponse = `[${targetChoom.name} used ${toolCallsUsed.length} tool(s) but returned no summary. Tool results below]\n\n${toolResultTexts.join('\n\n')}`;
          console.log(`   🤝 [${targetChoom.name}] Falling back to tool result text (${effectiveResponse.length} chars)`);
        } else {
          effectiveResponse = `[${targetChoom.name} returned an empty response after ${Math.round(durationMs / 1000)}s. The model may not have generated text. Try with a different model or simpler task.]`;
        }
      }

      // 6. Determine if the work was incomplete
      const hitMaxIterations = doneStatus === 'max_iterations';
      const incomplete = hitMaxIterations || effectiveResponse.includes('[Reached maximum tool iterations]');

      // 7. Cache the result
      const result: DelegationResult = {
        id: delegationId,
        choomName: targetChoom.name,
        task,
        response: effectiveResponse,
        toolCalls: toolCallsUsed,
        timestamp: Date.now(),
        durationMs,
        chatId: delegationChatId,
        choomId: targetChoom.id,
        incomplete,
        iterationsUsed: doneIterations,
        maxIterations: doneMaxIterations,
      };
      delegationResults.set(delegationId, result);

      const completionLabel = incomplete
        ? `INCOMPLETE (${doneIterations}/${doneMaxIterations} iterations)`
        : 'complete';
      console.log(`   🤝 Delegation ${completionLabel}: "${targetChoom.name}" responded in ${(durationMs / 1000).toFixed(1)}s (${effectiveResponse.length} chars, ${toolCallsUsed.length} tool calls, ${eventCount} SSE events)`);

      // Stream completion event
      ctx.send({
        type: 'delegation_completed',
        delegationId,
        targetChoom: targetChoom.name,
        durationMs,
        responseLength: effectiveResponse.length,
        toolCallCount: toolCallsUsed.length,
      });

      const resultPayload: Record<string, unknown> = {
        success: true,
        delegation_id: delegationId,
        choom_name: targetChoom.name,
        response: effectiveResponse,
        tools_used: toolCallsUsed.map(tc => tc.name),
        duration_seconds: Math.round(durationMs / 1000),
        chat_id: delegationChatId,
        iterations_used: doneIterations,
        max_iterations: doneMaxIterations,
        incomplete,
        message: incomplete
          ? `${targetChoom.name} ran out of iterations (${doneIterations}/${doneMaxIterations}) and did not finish. You can continue this delegation by calling delegate_to_choom again with continue_delegation_id="${delegationId}" and a task describing what remains.`
          : `${targetChoom.name} completed the task in ${Math.round(durationMs / 1000)}s.`,
      };

      return this.success(toolCall, resultPayload);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`   ❌ Delegation error:`, errMsg);
      return this.error(toolCall, `Delegation failed: ${errMsg}`);
    }
  }

  // ===========================================================================
  // get_delegation_result — Retrieve cached result
  // ===========================================================================

  private getDelegationResult(toolCall: ToolCall): ToolResult {
    const delegationId = toolCall.arguments.delegation_id as string;
    if (!delegationId) return this.error(toolCall, 'delegation_id is required');

    // Exact match first
    let result = delegationResults.get(delegationId);

    // Fuzzy match: try by choom name (most recent), or partial ID match
    if (!result) {
      const idLower = delegationId.toLowerCase();
      const allResults = Array.from(delegationResults.values());

      // Try matching by choom name (e.g., "Genesis", "Anya")
      const byName = allResults
        .filter(r => r.choomName.toLowerCase() === idLower)
        .sort((a, b) => b.timestamp - a.timestamp);
      if (byName.length > 0) {
        result = byName[0];
      }

      // Try partial ID match (e.g., "d1" matches "deleg_1_xxx")
      if (!result) {
        const numMatch = idLower.match(/^d(\d+)$/);
        if (numMatch) {
          const targetNum = numMatch[1];
          const byNum = allResults.find(r => r.id.match(new RegExp(`deleg_${targetNum}_`)));
          if (byNum) result = byNum;
        }
      }

      // Try substring match as last resort
      if (!result) {
        const bySubstring = allResults.find(r => r.id.includes(idLower) || idLower.includes(r.id));
        if (bySubstring) result = bySubstring;
      }
    }

    if (!result) {
      const available = Array.from(delegationResults.values()).map(r => `${r.id} (${r.choomName})`).join(', ');
      return this.error(toolCall, `Delegation "${delegationId}" not found. Available: ${available || 'none'}`);
    }

    return this.success(toolCall, {
      success: true,
      delegation_id: result.id,
      choom_name: result.choomName,
      task: result.task,
      response: result.response,
      tools_used: result.toolCalls.map(tc => tc.name),
      duration_seconds: Math.round(result.durationMs / 1000),
      age_seconds: Math.round((Date.now() - result.timestamp) / 1000),
    });
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Extract a brief specialization summary from a Choom's system prompt.
 * Takes the first ~100 chars that describe the Choom's role.
 */
function extractSpecialization(systemPrompt: string): string {
  if (!systemPrompt) return '(general purpose)';

  // Look for "You are X, ..." or "Your role is ..." patterns
  const roleMatch = systemPrompt.match(/(?:you are|your role is|you're|i am)\s+(.{10,120}?)(?:\.|$)/i);
  if (roleMatch) {
    return roleMatch[1].trim();
  }

  // Fallback: first sentence
  const firstSentence = systemPrompt.split(/[.!?\n]/)[0]?.trim();
  if (firstSentence && firstSentence.length > 5) {
    return firstSentence.slice(0, 120);
  }

  return '(general purpose)';
}
