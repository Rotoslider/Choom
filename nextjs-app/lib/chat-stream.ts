/**
 * One full chat turn over SSE (C-22 POST split).
 *
 * runChatTurn() is the body of the route's ReadableStream start() callback,
 * extracted verbatim from app/api/chat/route.ts: SSE plumbing, iteration-cap
 * resolution, ToolContext + execution-trace setup, the multi-step planner
 * phase, the agentic loop (lib/agentic-loop.ts), and finalize — assistant
 * message save, token-usage row, execution trace, done/error events, GUI
 * activity cleanup. route.ts keeps request prep (settings layering, context
 * blocks, prompt/history assembly, provider + fallback resolution) and hands
 * everything to this function.
 */
import prisma from '@/lib/db';
import { LLMClient, ChatMessage } from '@/lib/llm-client';
import { MemoryClient } from '@/lib/memory-client';
import { CompactionService } from '@/lib/compaction-service';
import { TraceBuilder, writeTrace } from '@/lib/execution-trace';
import { WatcherLoop } from '@/lib/watcher-loop';
import { isMultiStepRequest, createPlan, executePlan, summarizePlan } from '@/lib/planner-loop';
import { getSkillRegistry } from '@/lib/skill-registry';
import { type ToolContext, executeToolCall, executeToolCallViaSkills } from '@/lib/tool-execution';
import { defaultImageGenSettings } from '@/lib/chat-defaults';
import { WORKSPACE_MAX_FILES_PER_SESSION } from '@/lib/config';
import {
  serverLog, contextBreakdown, smartMerge, clearGuiActivity,
  resolveMaxIterations,
  type FallbackConfig, type DetectedProject,
} from '@/lib/chat-shared';
import { runAgenticLoop } from '@/lib/agentic-loop';
import type { LLMSettings, ToolCall, ToolResult, ToolDefinition, ImageGenSettings, WeatherSettings, LLMProviderConfig } from '@/lib/types';
import type { Choom, Chat, Message } from '@prisma/client';

export interface ChatTurnParams {
  controller: ReadableStreamDefaultController;
  choom: Choom;
  chat: Chat & { messages: Message[] };
  choomId: string;
  chatId: string;
  logChatId: string;
  message: string;
  settings: Record<string, unknown> | undefined;
  clientLLMSettings: Record<string, unknown>;
  providers: LLMProviderConfig[];
  isDelegation: boolean;
  suppressNotifications: boolean;
  noTools: boolean;
  maxIterationsOverride: unknown;
  isHeartbeat: boolean;
  isGroupTurn: boolean;
  freshContext: boolean;
  delegatorName: unknown;
  groupRoomId: string | undefined;
  taskModelOverride: unknown;
  taskOverrideActive: boolean;
  autoSetProjectInfo: { folder: string; name: string } | null;
  detectedProject: DetectedProject | null;
  choomMaxIterations: number;
  skillDispatch: boolean;
  memoryClient: MemoryClient;
  memoryCompanionId: string;
  weatherSettings: WeatherSettings;
  llmClient: { streamChat: LLMClient['streamChat'] };
  llmSettings: LLMSettings;
  activeTools: ToolDefinition[];
  usingCloudProvider: boolean;
  activeProviderId: string;
  fallbackConfigs: FallbackConfig[];
  createClientForFallback: (fb: FallbackConfig) => Promise<{ client: { streamChat: LLMClient['streamChat'] }; settings: LLMSettings }>;
  currentMessages: ChatMessage[];
  systemPromptWithSummary: string;
  compactionService: CompactionService;
  compactionWasPerformed: boolean;
  compactionStats: { messagesDropped: number; tokensBefore: number; tokensAfter: number };
}

export async function runChatTurn(params: ChatTurnParams): Promise<void> {
  const {
    controller, choom, chat, choomId, chatId, logChatId, message,
    settings, clientLLMSettings, providers,
    isDelegation, suppressNotifications, noTools, maxIterationsOverride,
    isHeartbeat, isGroupTurn, freshContext, delegatorName, groupRoomId,
    taskModelOverride, taskOverrideActive,
    autoSetProjectInfo, detectedProject, choomMaxIterations, skillDispatch,
    memoryClient, memoryCompanionId, weatherSettings,
    llmSettings, usingCloudProvider, activeProviderId,
    fallbackConfigs, createClientForFallback,
    currentMessages, activeTools, systemPromptWithSummary, compactionService,
    compactionWasPerformed, compactionStats,
  } = params;
  const llmClient = params.llmClient;
  const encoder = new TextEncoder();
  const choomTag = `[${choom.name}]`;
        // SSE state shared with the agentic loop (was a `streamClosed` local
        // closure variable before the C-22 split).
        const sse = { closed: false };
        const send = (data: Record<string, unknown>) => {
          if (sse.closed) return; // Silently skip if controller already closed (e.g., aborted delegation)
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            sse.closed = true; // Mark closed so subsequent sends skip silently
          }
        };
        // If this turn pinned a new project (named in the message), tell the web
        // header so its "Working in" dropdown updates live. (Signal ignores it; the
        // project is already persisted on the chat for the next message.)
        if (autoSetProjectInfo) {
          send({ type: 'project_set', chatId, folder: autoSetProjectInfo.folder, name: autoSetProjectInfo.name });
        }

        let fullContent = '';
        let allToolCalls: ToolCall[] = [];
        const allToolResults: ToolResult[] = [];
        const sessionFileCount = { created: 0, maxAllowed: WORKSPACE_MAX_FILES_PER_SESSION };
        // Iteration-cap resolution — single source of truth in resolveMaxIterations
        // (chat-shared). Precedence: request override > <!-- max_iterations: N -->
        // directive > project .choom-project.json metadata > defaults (heartbeat
        // 15, global 50). An explicit setting LOCKS the cap: neither the post-plan
        // reduction nor mid-turn project re-detection inside the agentic loop may
        // move it. The old inline ladder let a project silently LOOSEN a Choom's
        // directive and never let one TIGHTEN the default below 50.
        const iterationCap = resolveMaxIterations({
          maxIterationsOverride,
          choomMaxIterations,
          projectMaxIterations: detectedProject?.metadata?.maxIterations,
          isHeartbeat,
        });
        let maxIterations = iterationCap.maxIterations;
        // iterationCapLocked doubles as "don't re-derive the cap mid-turn".
        // Delegation keeps it true unconditionally: the worker's own directive (or
        // the global default) is the whole budget for that task.
        let iterationCapLocked = iterationCap.locked || isDelegation;

        for (const shadowedSource of iterationCap.shadowed) {
          console.log(`   🔒 [${choom.name}] ${shadowedSource} maxIterations ignored — ${iterationCap.source} takes precedence`);
        }
        console.log(`   🔒 [${choom.name}] maxIterations → ${maxIterations} (${iterationCap.source})`);

        // Build tool context
        const ctx: ToolContext = {
          memoryClient,
          memoryCompanionId,
          weatherSettings,
          settings: settings || {},
          imageGenSettings: smartMerge(
            defaultImageGenSettings,
            settings?.imageGen as Partial<ImageGenSettings> | undefined,
          ),
          choom: choom as unknown as Record<string, unknown>,
          choomId,
          chatId,
          message,
          send,
          sessionFileCount,
          suppressNotifications: !!suppressNotifications,
          isHeartbeat: !!isHeartbeat,
          activeProjectFolder: detectedProject?.folder,
          isDelegation: !!isDelegation,
          groupRoomId,
          delegatorSlug: typeof delegatorName === 'string' && delegatorName
            ? delegatorName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
            : undefined,
        };

        try {
          const requestStartTime = Date.now();
          let resolvedProvider = activeProviderId;
          const traceBuilder = new TraceBuilder({
            chatId,
            choomId,
            choomName: choom.name as string,
            model: llmSettings.model,
            provider: resolvedProvider,
            endpoint: llmSettings.endpoint || '',
            isDelegation: !!isDelegation,
            isHeartbeat: !!isHeartbeat,
            maxIterations,
          });
          const approxInitialTokens = contextBreakdown(`[${choom.name}] initial`, currentMessages, activeTools, llmSettings.contextLength || 0);
          console.log(`\n💬 Chat Request [${choom.name}] | ${currentMessages.length} msgs | ~${approxInitialTokens.toLocaleString()} tokens (msgs+tools)`);
          serverLog(choomId, logChatId, 'info', 'llm', 'LLM Request', `${llmSettings.model}: ${message.slice(0, 100)}`,
            { model: llmSettings.model, endpoint: llmSettings.endpoint, userMessage: message, messageCount: currentMessages.length, approxTokens: approxInitialTokens });

          // Send compaction event to UI if compaction was performed
          if (compactionWasPerformed) {
            send({ type: 'compaction', messagesDropped: compactionStats.messagesDropped,
                   tokensBefore: compactionStats.tokensBefore, tokensAfter: compactionStats.tokensAfter });
          }

          // ================================================================
          // PLANNER — for multi-step requests, create and execute a plan
          // ================================================================

          // Resolve optional planner model — a fast local model for plan creation (JSON generation).
          // Falls back to primary LLM if not configured or on error.
          let plannerClient: { streamChat: LLMClient['streamChat'] } | null = null;
          const plannerModel = llmSettings.plannerModel;
          if (plannerModel) {
            try {
              const plannerFb: FallbackConfig = {
                model: plannerModel,
                providerId: llmSettings.plannerProviderId || null,
                label: 'planner',
              };
              const { client: pClient } = await createClientForFallback(plannerFb);
              // Override endpoint if explicitly set (e.g. different LM Studio instance)
              if (llmSettings.plannerEndpoint) {
                const plannerSettings: LLMSettings = { ...llmSettings, model: plannerModel, endpoint: llmSettings.plannerEndpoint };
                plannerClient = new LLMClient(plannerSettings);
              } else {
                plannerClient = pClient;
              }
              console.log(`   📋 Planner model: ${plannerModel}${llmSettings.plannerProviderId ? ` (provider: ${llmSettings.plannerProviderId})` : ' (local)'}`);
            } catch (err) {
              console.warn(`   ⚠️  Failed to create planner client, using primary model:`, err instanceof Error ? err.message : err);
            }
          }

          let imageGenCount = 0; // Per-batch image gen counter (cap at 5 per batch; resets each agentic loop iteration)
          let planExecuted = false;
          let planFullySucceeded = false;
          let planHadDelegations = false;
          // Skip formal plan mode in group rooms. A room turn is conversational —
          // the planner narrates "Here's my plan: 1. … 2. …", which gets spoken
          // aloud and read by everyone (the user: "don't need to hear the plan").
          // Multi-step work still happens fine via the normal agentic loop (the
          // Choom just calls tools across iterations), and plan tools are already
          // stripped for group turns anyway.
          if (skillDispatch && !isDelegation && !isGroupTurn && !noTools && isMultiStepRequest(message)) {
            traceBuilder.setPlanMode();
            try {
              console.log(`   📋 Multi-step request detected — creating plan...`);
              const registry = getSkillRegistry();
              const plan = await createPlan(currentMessages, registry, plannerClient || llmClient, activeTools, choom.name);

              if (plan) {
                console.log(`   📋 Plan created: "${plan.goal}" (${plan.steps.length} steps)`);
                const watcher = new WatcherLoop();

                // Execute plan with progress streaming
                const planToolExecutor = async (toolCall: ToolCall, _iter: number): Promise<ToolResult> => {
                  // Enforce per-batch image gen cap in plan mode (max 5 per plan batch)
                  if (toolCall.name === 'generate_image' && imageGenCount >= 5) {
                    const capped: ToolResult = {
                      toolCallId: toolCall.id, name: toolCall.name, result: null,
                      error: `Image generation limit reached (${imageGenCount}/5 this batch). Skip this step.`,
                    };
                    send({ type: 'tool_call', toolCall });
                    send({ type: 'tool_result', toolResult: capped });
                    return capped;
                  }

                  // Send tool call event
                  send({ type: 'tool_call', toolCall });
                  serverLog(choomId, logChatId, 'info', 'system', `Plan Tool: ${toolCall.name}`,
                    `Arguments: ${JSON.stringify(toolCall.arguments).slice(0, 200)}`,
                    { toolName: toolCall.name, arguments: toolCall.arguments });

                  const result = skillDispatch
                    ? await executeToolCallViaSkills(toolCall, ctx)
                    : await executeToolCall(toolCall, ctx);

                  // Track image gen count
                  if (toolCall.name === 'generate_image' && !result.error) {
                    imageGenCount++;
                  }

                  // Track in allToolCalls/allToolResults for DB save
                  allToolCalls.push(toolCall);
                  allToolResults.push(result);

                  send({ type: 'tool_result', toolResult: result });
                  return result;
                };

                const planResult = await executePlan(plan, planToolExecutor, watcher, send, {
                  registry,
                  llmClient: plannerClient || llmClient,
                  callerChoomName: choom.name,
                });
                // Only mark plan as "executed" if it actually succeeded at something.
                // A completely failed plan should let the model recover via the agentic loop.
                planExecuted = planResult.succeeded > 0;
                planFullySucceeded = planResult.failed === 0 && planResult.succeeded > 0;
                planHadDelegations = plan.steps.some((s: { type?: string }) => s.type === 'delegate');

                // Inject plan summary into conversation context so the LLM can reference it
                const planSummaryText = summarizePlan(plan);
                const stepSummaries = plan.steps.map(s => {
                  let line = `- ${s.description}: ${s.status}`;
                  if (s.result?.error) line += ` (error: ${s.result.error})`;
                  // For delegation steps, include the actual response so the LLM
                  // doesn't need to call get_delegation_result separately
                  if (s.type === 'delegate' && s.result?.result && typeof s.result.result === 'object') {
                    const delegResult = s.result.result as Record<string, unknown>;
                    const response = delegResult.response as string | undefined;
                    if (response && response.length > 0) {
                      const truncated = response.length > 1500 ? response.slice(0, 1500) + '...[truncated]' : response;
                      line += `\n  Response from ${delegResult.choom_name || s.choomName || 'delegate'}:\n  ${truncated}`;
                    }
                  }
                  return line;
                }).join('\n');

                currentMessages.push({
                  role: 'assistant',
                  content: `I executed a ${plan.steps.length}-step plan: "${plan.goal}"\n\n${stepSummaries}\n\n${planSummaryText}`,
                });

                // When the plan partially failed, add guidance so the LLM retries
                // failed steps manually instead of giving up.
                if (planResult.failed > 0 && planResult.succeeded > 0) {
                  currentMessages.push({
                    role: 'user',
                    content: `Some plan steps failed due to template resolution issues. Use the successful results and call the tools directly to complete the remaining work. Do NOT give up — try the failed steps yourself by calling the tools with the correct arguments.`,
                  });
                } else if (planResult.failed > 0 && planResult.succeeded === 0) {
                  currentMessages.push({
                    role: 'user',
                    content: `The automated plan failed, but you can still accomplish the goal. Call the tools directly yourself — do NOT give up.`,
                  });
                }

                fullContent += `\n\n${planSummaryText}`;
                send({ type: 'content', content: `\n\n${planSummaryText}` });

                console.log(`   📋 Plan complete: ${planResult.succeeded} succeeded, ${planResult.failed} failed`);
              } else {
                // createPlan returns null in two distinct cases:
                //   (a) LLM intentionally returned {"goal": null} — request is simple
                //   (b) JSON parse failed (the planner already logged the cause + raw response)
                // The planner's own warnings above will show in (b), so this line
                // only describes the benign (a) case to avoid contradicting them.
                console.log(`   📋 No plan executed — falling through to simple loop (see [Planner] warnings above if a parse failure occurred)`);
              }
            } catch (planError) {
              console.warn(`   ⚠️  Planner error, falling back to simple loop:`, planError instanceof Error ? planError.message : planError);
            }
          }
          // ================================================================
          // AGENTIC LOOP — extracted to lib/agentic-loop.ts (C-22)
          // ================================================================
          const loop = await runAgenticLoop({
            send, sse, ctx, traceBuilder,
            currentMessages, activeTools, llmClient, llmSettings, clientLLMSettings,
            settings, providers, usingCloudProvider, resolvedProvider,
            fallbackConfigs, createClientForFallback, taskOverrideActive, taskModelOverride,
            choom, chat, choomId, chatId, logChatId, message,
            isGroupTurn, isHeartbeat, isDelegation, noTools, suppressNotifications, freshContext,
            maxIterationsOverride, detectedProject, skillDispatch,
            compactionService, systemPromptWithSummary, planFullySucceeded,
            maxIterations, iterationCapLocked,
            fullContent, allToolCalls, allToolResults,
          });
          const {
            iteration, totalPromptTokens, totalCompletionTokens, maxPromptTokens,
            llmMsTotal, llmPrefillMsTotal, llmCallCount, maxLlmCallMs, firstLlmCallAt,
            compressionSavedChars, brokenTools,
          } = loop;
          maxIterations = loop.maxIterations;
          fullContent = loop.fullContent;
          allToolCalls = loop.allToolCalls;
          resolvedProvider = loop.resolvedProvider;

          // Post-process: strip absolute file paths from response
          const cleanedContent = fullContent.replace(
            /\/home\/[^\s"')}\]]+/g,
            (match) => {
              // Extract just the filename
              const parts = match.split('/');
              return parts[parts.length - 1];
            }
          ).replace(
            /\/tmp\/[^\s"')}\]]+/g,
            (match) => {
              const parts = match.split('/');
              return parts[parts.length - 1];
            }
          );

          // Save assistant message with all tool calls/results
          // Cap serialized sizes to prevent multi-MB rows that crash Prisma Studio / bloat DB
          const MAX_DB_FIELD_CHARS = 100_000;
          let toolCallsJson = allToolCalls.length > 0 ? JSON.stringify(allToolCalls) : null;
          let toolResultsJson = allToolResults.length > 0 ? JSON.stringify(allToolResults) : null;
          // Truncate by dropping trailing array entries to keep valid JSON (not slicing mid-string)
          const truncateJsonArray = (json: string, label: string): string => {
            if (json.length <= MAX_DB_FIELD_CHARS) return json;
            try {
              const arr = JSON.parse(json) as unknown[];
              while (arr.length > 1) {
                arr.pop();
                const attempt = JSON.stringify(arr);
                if (attempt.length <= MAX_DB_FIELD_CHARS) {
                  console.warn(`   ⚠️ ${label} trimmed for DB save: ${arr.length} entries kept (${json.length.toLocaleString()} → ${attempt.length.toLocaleString()} chars)`);
                  return attempt;
                }
              }
              // Even single entry too large — store null
              console.warn(`   ⚠️ ${label} too large even with 1 entry (${json.length.toLocaleString()} chars) — dropping`);
              return '[]';
            } catch {
              return json.slice(0, MAX_DB_FIELD_CHARS); // fallback
            }
          };
          if (toolCallsJson && toolCallsJson.length > MAX_DB_FIELD_CHARS) {
            toolCallsJson = truncateJsonArray(toolCallsJson, 'toolCalls');
          }
          if (toolResultsJson && toolResultsJson.length > MAX_DB_FIELD_CHARS) {
            toolResultsJson = truncateJsonArray(toolResultsJson, 'toolResults');
          }
          // Group turns: don't persist to the scratch chat — the group
          // orchestrator writes the canonical GroupMessage row from the streamed
          // content. Avoids duplicate/scratch bloat.
          if (!isGroupTurn) {
            await prisma.message.create({
              data: {
                chatId,
                role: 'assistant',
                content: cleanedContent,
                toolCalls: toolCallsJson,
                toolResults: toolResultsJson,
              },
            });

            // Update chat timestamp
            await prisma.chat.update({
              where: { id: chatId },
              data: { updatedAt: new Date() },
            });
          }

          const elapsed = Date.now() - requestStartTime;
          serverLog(choomId, logChatId, 'success', 'llm', 'LLM Response',
            `${llmSettings.model} (${fullContent.length} chars, ${iteration} iteration${iteration > 1 ? 's' : ''})`,
            { model: llmSettings.model, charCount: fullContent.length, iterations: iteration, fullResponse: fullContent.slice(0, 2000),
              toolCallCount: allToolCalls.length, toolNames: allToolCalls.map(t => t.name),
              ...(compressionSavedChars > 0 ? { compressionSavedTokens: Math.round(compressionSavedChars / 4) } : {}) },
            elapsed);

          // Record token usage (fire-and-forget — don't block the response)
          // If the provider didn't return usage data, estimate from character counts.
          // Rough approximation: 1 token ≈ 4 characters for English text.
          let finalPromptTokens = totalPromptTokens;
          let finalCompletionTokens = totalCompletionTokens;
          if (totalPromptTokens === 0 && totalCompletionTokens === 0) {
            // Estimate prompt tokens from all messages sent to the LLM
            const promptChars = currentMessages.reduce((sum: number, m: { content?: string }) => sum + (m.content?.length || 0), 0);
            finalPromptTokens = Math.round(promptChars / 4);
            // Estimate completion tokens from generated content + tool call arguments
            const toolArgChars = allToolCalls.reduce((sum: number, tc: { arguments?: Record<string, unknown> }) => {
              try { return sum + JSON.stringify(tc.arguments || {}).length; } catch { return sum; }
            }, 0);
            finalCompletionTokens = Math.round((fullContent.length + toolArgChars) / 4);
          }
          const totalTok = finalPromptTokens + finalCompletionTokens;
          if (totalTok > 0 || iteration > 0) {
            const isEstimated = totalPromptTokens === 0 && totalCompletionTokens === 0;
            prisma.tokenUsage.create({
              data: {
                choomId,
                choomName: (choom.name as string) || 'Unknown',
                chatId,
                model: llmSettings.model,
                provider: resolvedProvider,
                endpoint: llmSettings.endpoint || null,
                promptTokens: finalPromptTokens,
                completionTokens: finalCompletionTokens,
                totalTokens: totalTok,
                savedTokens: Math.round(compressionSavedChars / 4),
                iterations: iteration,
                toolCalls: allToolCalls.length,
                toolNames: allToolCalls.length > 0 ? JSON.stringify(allToolCalls.map(t => t.name)) : null,
                durationMs: elapsed,
                source: isGroupTurn ? 'group' : isDelegation ? 'delegation' : isHeartbeat ? 'heartbeat' : 'chat',
              },
            }).catch(err => console.warn('[TokenUsage] Write failed:', err instanceof Error ? err.message : err));
            if (totalTok > 0) {
              console.log(`   📊 ${choomTag} Tokens: ${finalPromptTokens.toLocaleString()} prompt + ${finalCompletionTokens.toLocaleString()} completion = ${totalTok.toLocaleString()} total${isEstimated ? ' (estimated)' : ''}`);
            }
            if (compressionSavedChars > 0) {
              console.log(`   🗜️  ${choomTag} Tool-output compression saved ~${Math.round(compressionSavedChars / 4).toLocaleString()} tokens (${compressionSavedChars.toLocaleString()} chars trimmed from stale re-sends)`);
            }
          }

          // Write execution trace
          const isEstimatedTokens = totalPromptTokens === 0 && totalCompletionTokens === 0;
          traceBuilder.finalize({
            iterations: iteration,
            status: iteration >= maxIterations ? 'max_iterations' : sse.closed ? 'stream_closed' : 'complete',
            durationMs: elapsed,
            promptTokens: finalPromptTokens,
            completionTokens: finalCompletionTokens,
            maxPromptTokens,
            tokensEstimated: isEstimatedTokens,
            responseLength: fullContent.length,
            brokenTools: [...brokenTools],
            llmMs: llmMsTotal,
            llmPrefillMs: llmPrefillMsTotal,
            llmCalls: llmCallCount,
            maxLlmCallMs,
            prepMs: firstLlmCallAt ? firstLlmCallAt - requestStartTime : 0,
          });
          writeTrace(traceBuilder.getTrace());

          send({
            type: 'done',
            content: fullContent,
            resolvedModel: llmSettings.model,
            iteration,
            maxIterations,
            status: iteration >= maxIterations ? 'max_iterations' : 'complete',
            savedTokens: Math.round(compressionSavedChars / 4),
          });
        } catch (error) {
          console.error('   ❌ Chat error:', error instanceof Error ? error.message : error);
          send({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } finally {
          // Clear GUI activity marker so heartbeats can resume
          if (!isDelegation) {
            clearGuiActivity(choom.name);
          }
          if (!sse.closed) {
            try { controller.close(); } catch { /* already closed */ }
          }
        }
}
