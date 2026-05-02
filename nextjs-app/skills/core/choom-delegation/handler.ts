import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import prisma from '@/lib/db';
import { Agent, fetch as undiciFetch } from 'undici';
import { WORKSPACE_ROOT } from '@/lib/config';
import { verifyDelegationClaims, formatVerificationBlock } from '@/lib/claim-verifier';

const DELEG_WORKSPACE_MAX_FILE_KB = 1024;
const DELEG_WORKSPACE_EXTS = ['.md', '.txt', '.json', '.jsonl', '.py', '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.csv', '.tsv', '.sh', '.bash', '.yaml', '.yml', '.xml', '.sql', '.toml', '.ini', '.cfg', '.log'];

const TOOL_NAMES = new Set(['delegate_to_choom', 'list_team', 'get_delegation_result']);

// Dedicated dispatcher for delegation fetches. undici's default bodyTimeout
// (300s between chunks) kills long SSE streams when a slow local-model worker
// has a gap between iterations. Our explicit AbortController (timeout_seconds)
// is the single source of truth for delegation deadlines.
const delegationDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

// Cache delegation results for retrieval within the session
const delegationResults = new Map<string, DelegationResult>();
// Track timed-out delegations per-choom to prevent retry loops
// Key: choomName (lowercase), Value: { delegationId, timestamp }
const recentTimeouts = new Map<string, { delegationId: string; timestamp: number }>();
// Track delegations that were detached (orchestrator timed out but worker continues)
// Key: delegationId, Value: promise that resolves when the background reader finishes
const detachedDelegations = new Map<string, Promise<void>>();
let delegationCounter = 0;
const RESULT_TTL_MS = 3600000; // 1 hour

function pruneStaleResults() {
  const now = Date.now();
  for (const [id, result] of delegationResults) {
    if (now - result.timestamp > RESULT_TTL_MS && !detachedDelegations.has(id)) {
      delegationResults.delete(id);
    }
  }
  for (const [key, entry] of recentTimeouts) {
    if (now - entry.timestamp > RESULT_TTL_MS) {
      recentTimeouts.delete(key);
    }
  }
}

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
    pruneStaleResults();
    const choomName = toolCall.arguments.choom_name as string;
    const task = toolCall.arguments.task as string;
    const extraContext = toolCall.arguments.context as string | undefined;
    // Min 120s (was 30s — models often pass low values that cause premature timeouts)
    const timeoutSeconds = Math.min(900, Math.max(120, (toolCall.arguments.timeout_seconds as number) || 600));
    const continueDelegationId = toolCall.arguments.continue_delegation_id as string | undefined;

    if (!choomName) return this.error(toolCall, 'choom_name is required');
    if (!task) return this.error(toolCall, 'task is required');

    const startTime = Date.now();

    try {
      // 1. If continuing a previous delegation, reuse the same Choom and chat
      let targetChoom: { id: string; name: string } | undefined;
      // Definite-assignment asserted (!): every code path below either assigns
      // these directly or falls through to the `if (!isContinuation)` block,
      // but TypeScript can't correlate the isContinuation cross-branch flow.
      let delegationChatId!: string;
      let delegationId!: string;
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

        // If a detached delegation to this Choom is still running in the
        // background, return the live result instead of starting a second
        // concurrent session. The orchestrator should use get_delegation_result.
        const choomKey = targetChoom.name.toLowerCase();
        const runningEntry = Array.from(delegationResults.entries()).find(
          ([id, r]) => r.choomName.toLowerCase() === choomKey && detachedDelegations.has(id)
        );
        if (runningEntry) {
          const [runningId, runningResult] = runningEntry;
          console.log(`   ⏳ ${targetChoom.name} already has a detached delegation in progress (${runningId}) — returning live status`);
          return this.success(toolCall, {
            success: true,
            delegation_id: runningId,
            choom_name: targetChoom.name,
            response: runningResult.response,
            tools_used: runningResult.toolCalls.map(tc => tc.name),
            tool_call_count: runningResult.toolCalls.length,
            duration_seconds: Math.round(runningResult.durationMs / 1000),
            incomplete: true,
            in_progress: true,
            message: `${targetChoom.name} is already working on a delegated task (${runningId}, ${runningResult.toolCalls.length} tool calls so far). Use get_delegation_result("${runningId}") to check progress instead of starting a new delegation.`,
          });
        }

        // Prevent delegation retry loops: if this choom just timed out on a
        // delegation (within last 10 min), force continuation instead of fresh start.
        // This prevents Aloy → Anya timeout → Aloy re-delegates → Anya timeout → loop.
        const recentTimeout = recentTimeouts.get(choomKey);
        if (recentTimeout && (Date.now() - recentTimeout.timestamp) < 600000) {
          console.log(`   🔄 ${targetChoom.name} timed out recently (${recentTimeout.delegationId}) — auto-converting to continuation`);
          const prev = delegationResults.get(recentTimeout.delegationId);
          if (prev) {
            // Reuse the existing chat so the choom has its full context
            delegationChatId = prev.chatId;
            delegationId = `${recentTimeout.delegationId}_cont_${Date.now()}`;
            isContinuation = true;
            recentTimeouts.delete(choomKey); // clear so third attempt is fresh
          } else {
            // Previous result was cleaned up — proceed with fresh delegation
            delegationId = `deleg_${++delegationCounter}_${Date.now()}`;
          }
        }

        if (!isContinuation) {
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
      // Determine the project folder the worker should use for checkpoints
      const workerProjectFolder = activeProject || null;

      // Build delegation message — different phrasing for continuation vs fresh
      // Checkpoint instruction: tell the worker to save progress incrementally.
      // If the worker times out, the orchestrator can read the progress file.
      const checkpointFile = workerProjectFolder ? `DELEGATION_PROGRESS.md` : null;
      const checkpointInstruction = checkpointFile && workerProjectFolder
        ? `\n- CHECKPOINT YOUR WORK: After every 2-3 tool calls, save your findings so far to "${checkpointFile}" using workspace_write_file (project_folder="${workerProjectFolder}"). Include what you've found, what's left to do, and any key data. This protects your work if you time out.`
        : '';

      // Instruct worker to write findings to files and keep the response text brief.
      // The orchestrator can read the files for details — this keeps delegation responses
      // small (~200 tokens) instead of dumping 8000+ chars into the orchestrator's context.
      const fileHandoffInstruction = workerProjectFolder
        ? `\n- WRITE YOUR FINDINGS TO FILES: Save all detailed results, data, and analysis to files in "${workerProjectFolder}" using workspace_write_file. Your response text should be a BRIEF SUMMARY (under 300 words) listing what files you created and key takeaways. The orchestrator will read the files for full details.`
        : '';

      let delegationMessage: string;
      if (isContinuation) {
        delegationMessage = `[CONTINUATION — from ${(ctx.choom as Record<string, unknown>).name || 'Orchestrator'}]\n\nYour previous work was cut short. Continue where you left off.\n\n## Updated Instructions\n${fullTask}\n\nRULES:\n- You have the full conversation history above — do NOT re-read files you already read.\n- Pick up from where you stopped and complete the remaining work.\n- Use as many tool calls as needed.${projectContext}${checkpointInstruction}${fileHandoffInstruction}\n- End with a brief summary of ALL work done (previous + this continuation) and which files contain the full details.`;
      } else {
        delegationMessage = `[DELEGATED TASK from ${(ctx.choom as Record<string, unknown>).name || 'Orchestrator'}]\n\n${fullTask}\n\nRULES FOR THIS TASK:\n- Complete this task DIRECTLY using your own tools. Do NOT delegate to other Chooms.\n- Use the most specific tool available (e.g., get_weather for weather, not web_search).\n- Use as many tool calls as needed to fully complete the task. Read all necessary files before making changes.${projectContext}${checkpointInstruction}${fileHandoffInstruction}\n- End with a brief summary of what you did, which files you created/updated, and key findings. Keep this summary under 300 words — the orchestrator will read the files for full details.`;
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

      // Orchestrator timeout: controls how long the orchestrator WAITS, not how
      // long the worker lives. When this fires we detach the reader to a
      // background task and return partial results — the worker keeps running.
      // We intentionally do NOT pass an AbortController signal to the fetch,
      // because aborting undici kills the TCP connection and the background
      // reader would have nothing to read.
      let resolveTimeout: () => void;
      const timeoutPromise = new Promise<void>(resolve => { resolveTimeout = resolve; });
      const timeoutSentinel = timeoutPromise.then(() => 'ORCHESTRATOR_TIMEOUT' as const);
      const timeout = setTimeout(() => resolveTimeout(), timeoutSeconds * 1000);

      // Separate controller for the initial connection — if the fetch itself
      // hangs (server down, DNS failure), we still need to bail out.
      // 120s is generous because the chat route does significant pre-work
      // before sending the first SSE byte (settings resolution, weather/HA
      // injection, workspace listing, model profile lookup, etc.).
      const connectController = new AbortController();
      const connectTimeout = setTimeout(() => connectController.abort(), 120000);

      // Use undici fetch directly (not the Next.js-patched global fetch), so
      // our dispatcher with bodyTimeout=0 is actually honored and Next.js
      // doesn't instrument/cache this long-running internal SSE call.
      let response: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        response = await undiciFetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            choomId: targetChoom.id,
            chatId: delegationChatId,
            message: delegationMessage,
            settings: ctx.settings, // Forward shared settings (weather, search, etc.)
            isDelegation: true, // Tells chat route: strip delegation tools, disable plan detection
          }),
          signal: connectController.signal,
          dispatcher: delegationDispatcher,
        });
        clearTimeout(connectTimeout);
      } catch (fetchErr) {
        clearTimeout(timeout);
        clearTimeout(connectTimeout);
        if ((fetchErr as Error).name === 'AbortError') {
          return this.error(toolCall, `Delegation to "${targetChoom.name}" — could not connect to chat API within 120s`);
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

      // Track the in-flight reader.read() promise so the background reader can
      // pick up the chunk that was already requested when the timeout fired.
      let inflightRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

      try {
        while (true) {
          // Race the reader against the orchestrator timeout. When the timeout
          // fires, we break out of this loop but DON'T close the reader — the
          // catch block detaches it to a background task.
          const pendingRead = reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>;
          inflightRead = pendingRead;
          const readResult = await Promise.race([
            pendingRead,
            timeoutSentinel,
          ]);
          if (readResult === 'ORCHESTRATOR_TIMEOUT') {
            throw Object.assign(new Error(`Orchestrator wait limit (${timeoutSeconds}s)`), { name: 'AbortError' });
          }
          inflightRead = null; // read completed — nothing in-flight
          const { done, value } = readResult as ReadableStreamReadResult<Uint8Array>;
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
                  // Forward to orchestrator's client — keeps bridge read timeout alive
                  ctx.send({ type: 'status', content: `[${targetChoom.name}] tool: ${data.toolCall?.name}` });
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
                  // Forward to orchestrator's client — keeps bridge read timeout alive
                  ctx.send({ type: 'status', content: `[${targetChoom.name}] iteration ${data.iteration}/${data.maxIterations}` });
                  break;
                case 'retract_partial':
                  // Worker choom's primary model sent partial text before timing out
                  // and falling back to another model. Remove the partial text.
                  if (data.length && content.length >= data.length) {
                    content = content.slice(0, content.length - data.length);
                  }
                  break;
                case 'status':
                  // Informational (e.g. "Switching to fallback") — ignore
                  break;
              }
            } catch {
              // Skip unparseable SSE lines
            }
          }
        }
      } catch (streamErr) {
        // Any stream-read failure — AbortError (timeout), undici "terminated"
        // (socket died mid-stream), ECONNRESET, premature close. Worker may have
        // completed real work (files written) before the transport failed, so
        // treat all of these the same: preserve partial results + checkpoint.
        clearTimeout(timeout);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const errObj = streamErr as Error & { cause?: { message?: string; code?: string } };
        const errName = errObj.name || '';
        const errMsg = errObj.message || '';
        const causeMsg = errObj.cause?.message || '';
        const causeCode = errObj.cause?.code || '';
        const isAbort = errName === 'AbortError';
        const isTransport = /terminated|socket|ECONNRESET|ECONNREFUSED|UND_ERR|premature/i.test(
          `${errName} ${errMsg} ${causeMsg} ${causeCode}`
        );
        const reasonLabel = isAbort
          ? `timed out after ${elapsed}s`
          : `lost connection after ${elapsed}s (${errMsg || causeMsg || errName || 'unknown'})`;

        if (isAbort || isTransport) {
          // DETACH-AND-CONTINUE: For AbortError (timeout), don't kill the worker.
          // Move the reader to a background task that keeps consuming SSE events
          // so the worker's agentic loop continues uninterrupted. The orchestrator
          // gets partial results now and can check back via get_delegation_result.
          // For transport errors (connection lost), the worker is already dead —
          // just return partial results.
          if (isAbort) {
            // The underlying connection is still alive (we didn't abort the fetch).
            // Give the background reader up to 10 more minutes to finish, then
            // cancel the reader to avoid leaking connections/memory forever.
            const bgReader = reader;
            const bgInflightRead = inflightRead;
            const bgTimeout = setTimeout(() => {
              console.warn(`   ⚠️  [${targetChoom!.name}] (bg) Background reader safety timeout (600s) — cancelling reader`);
              bgReader.cancel().catch(() => {});
            }, 600000);
            // Shared mutable state: the background reader continues appending to
            // these same arrays/strings so get_delegation_result sees live updates.
            const bgContent = { value: content };
            const bgToolCalls = toolCallsUsed;
            const bgToolResultTexts = toolResultTexts;
            const bgDoneContent = { value: doneContent };
            const bgDoneIterations = { value: doneIterations };
            const bgDoneMaxIterations = { value: doneMaxIterations };
            const bgDoneStatus = { value: doneStatus };

            const bgPromise = (async () => {
              try {
                console.log(`   🔄 [${targetChoom.name}] Detached — background reader continuing (delegation ${delegationId})`);

                // Consume the in-flight read that was pending when the timeout
                // fired. Without this, that chunk is lost — reader.read() calls
                // queue, so the background's first read() would get the NEXT
                // chunk while this one resolves to nobody.
                if (bgInflightRead) {
                  try {
                    const pending = await bgInflightRead;
                    if (!pending.done && pending.value) {
                      buffer += decoder.decode(pending.value, { stream: true });
                    }
                    if (pending.done) {
                      // Worker finished during the handoff — skip the loop
                      console.log(`   ✅ [${targetChoom.name}] (bg) Worker already finished during handoff`);
                    }
                  } catch (pendingErr) {
                    console.warn(`   ⚠️  [${targetChoom.name}] (bg) In-flight read failed:`, pendingErr instanceof Error ? pendingErr.message : pendingErr);
                  }
                }

                while (true) {
                  const { done: bgDone, value: bgValue } = await bgReader.read();
                  if (bgDone) break;
                  buffer += decoder.decode(bgValue, { stream: true });
                  const bgLines = buffer.split('\n');
                  buffer = bgLines.pop() || '';
                  for (const line of bgLines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                      const data = JSON.parse(line.slice(6));
                      switch (data.type) {
                        case 'content':
                          bgContent.value += data.content || '';
                          break;
                        case 'tool_call':
                          console.log(`   🤝 [${targetChoom.name}] (bg) tool_call: ${data.toolCall?.name}`);
                          bgToolCalls.push({ name: data.toolCall?.name || 'unknown' });
                          break;
                        case 'tool_result': {
                          const resultData = data.toolResult?.result;
                          if (resultData) {
                            const resultStr = typeof resultData === 'string'
                              ? resultData.slice(0, 1000)
                              : JSON.stringify(resultData).slice(0, 1000);
                            bgToolResultTexts.push(resultStr);
                          }
                          if (bgToolCalls.length > 0) {
                            const last = bgToolCalls[bgToolCalls.length - 1];
                            if (resultData) {
                              last.result = typeof resultData === 'string'
                                ? resultData.slice(0, 500)
                                : JSON.stringify(resultData).slice(0, 500);
                            }
                          }
                          break;
                        }
                        case 'done':
                          if (data.content) bgDoneContent.value = data.content;
                          if (data.iteration) bgDoneIterations.value = data.iteration;
                          if (data.maxIterations) bgDoneMaxIterations.value = data.maxIterations;
                          if (data.status) bgDoneStatus.value = data.status;
                          break;
                        case 'agent_iteration':
                          console.log(`   🤝 [${targetChoom.name}] (bg) iteration ${data.iteration}/${data.maxIterations}`);
                          // Live-update the cached result so get_delegation_result
                          // returns current progress, not stale partial data.
                          {
                            const cached = delegationResults.get(delegationId);
                            if (cached) {
                              cached.response = bgContent.value.trim() || cached.response;
                              cached.iterationsUsed = data.iteration;
                              cached.maxIterations = data.maxIterations;
                              cached.durationMs = Date.now() - startTime;
                            }
                          }
                          break;
                        case 'retract_partial':
                          if (data.length && bgContent.value.length >= data.length) {
                            bgContent.value = bgContent.value.slice(0, bgContent.value.length - data.length);
                          }
                          break;
                      }
                    } catch { /* skip unparseable */ }
                  }
                }
                // Worker finished — update the cached result to complete
                const finalContent = bgDoneContent.value || bgContent.value;
                const totalDuration = Date.now() - startTime;
                console.log(`   ✅ [${targetChoom.name}] (bg) Delegation completed in ${Math.round(totalDuration / 1000)}s total (${bgToolCalls.length} tool calls)`);
                const completeResult: DelegationResult = {
                  id: delegationId,
                  choomName: targetChoom!.name,
                  task,
                  response: finalContent.trim() || `[${targetChoom!.name} finished but produced no summary text. Used ${bgToolCalls.length} tool calls.]`,
                  toolCalls: bgToolCalls,
                  timestamp: Date.now(),
                  durationMs: totalDuration,
                  chatId: delegationChatId,
                  choomId: targetChoom!.id,
                  incomplete: bgDoneStatus.value === 'max_iterations',
                  iterationsUsed: bgDoneIterations.value,
                  maxIterations: bgDoneMaxIterations.value,
                };
                delegationResults.set(delegationId, completeResult);
                recentTimeouts.delete(targetChoom!.name.toLowerCase());
              } catch (bgErr) {
                const bgErrMsg = bgErr instanceof Error ? bgErr.message : String(bgErr);
                console.warn(`   ⚠️  [${targetChoom!.name}] (bg) Background reader error:`, bgErrMsg);
                // Update cached result so get_delegation_result reflects the failure
                const cached = delegationResults.get(delegationId);
                if (cached) {
                  cached.incomplete = true;
                  cached.durationMs = Date.now() - startTime;
                  if (bgContent.value.trim()) {
                    cached.response = bgContent.value.trim();
                  }
                  cached.response += `\n\n[Background reader error: ${bgErrMsg}]`;
                }
              } finally {
                clearTimeout(bgTimeout);
                try { bgReader.releaseLock(); } catch { /* already released or errored stream */ }
                detachedDelegations.delete(delegationId);
              }
            })();
            detachedDelegations.set(delegationId, bgPromise);
          } else {
            // Transport error — worker is dead, release reader
            reader.releaseLock();
          }

          // Build partial response for the orchestrator
          if (content.trim().length > 20 || toolCallsUsed.length > 0) {
            const stillRunning = isAbort;
            const statusLabel = stillRunning ? 'still working' : 'connection lost';
            console.warn(`   ⚠️  [${targetChoom.name}] Delegation ${reasonLabel} — ${statusLabel} (${content.length} chars, ${toolCallsUsed.length} tool calls so far)`);
            let partialResponse = content.trim();
            if (!partialResponse || partialResponse.length < 20) {
              if (toolResultTexts.length > 0) {
                partialResponse = `[${targetChoom.name} ${reasonLabel}. Tool results from ${toolCallsUsed.length} calls below]\n\n${toolResultTexts.join('\n\n')}`;
                console.log(`   🤝 [${targetChoom.name}] Fallback: using ${toolResultTexts.length} tool result texts (${partialResponse.length} chars)`);
              } else {
                partialResponse = `[${targetChoom.name} ${reasonLabel} with ${toolCallsUsed.length} tool calls but no text response]`;
              }
            }

            // Auto-checkpoint: write captured work to a progress file
            let checkpointPath: string | null = null;
            if (workerProjectFolder && (toolResultTexts.length > 0 || content.trim().length > 50)) {
              try {
                const { WorkspaceService } = await import('@/lib/workspace-service');
                const ws = new WorkspaceService(WORKSPACE_ROOT, DELEG_WORKSPACE_MAX_FILE_KB, DELEG_WORKSPACE_EXTS);
                const progressContent = [
                  `# Delegation Progress — ${targetChoom.name}`,
                  `**Task:** ${task.slice(0, 200)}`,
                  `**Status:** ${stillRunning ? 'Still running (detached)' : 'Connection lost'} after ${elapsed}s (${toolCallsUsed.length} tool calls, ${doneIterations || '?'} iterations)`,
                  `**Time:** ${new Date().toISOString()}`,
                  '',
                  '## Tool Calls Made',
                  ...toolCallsUsed.map((tc, i) => `${i + 1}. ${tc.name}${tc.result ? `: ${String(tc.result).slice(0, 200)}` : ''}`),
                  '',
                  '## Findings So Far',
                  content.trim() || '(No summary text generated yet)',
                  '',
                  ...(toolResultTexts.length > 0 ? [
                    '## Raw Tool Results',
                    ...toolResultTexts.map((t, i) => `### Result ${i + 1}\n${t}`),
                  ] : []),
                ].join('\n');
                checkpointPath = `${workerProjectFolder}/DELEGATION_PROGRESS.md`;
                await ws.writeFile(checkpointPath, progressContent);
                console.log(`   📝 [${targetChoom.name}] Auto-checkpoint saved: ${checkpointPath} (${progressContent.length} chars)`);
              } catch (writeErr) {
                console.warn(`   ⚠️  [${targetChoom.name}] Failed to write auto-checkpoint:`, writeErr instanceof Error ? writeErr.message : writeErr);
              }
            }

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
            if (!isAbort) {
              // Only track for auto-continuation if the worker is dead
              recentTimeouts.set(targetChoom.name.toLowerCase(), { delegationId, timestamp: Date.now() });
            }
            return this.success(toolCall, {
              success: true,
              delegation_id: delegationId,
              choom_name: targetChoom.name,
              response: partialResponse,
              tools_used: toolCallsUsed.map(tc => tc.name),
              duration_seconds: elapsed,
              incomplete: true,
              in_progress: stillRunning,
              project_folder: workerProjectFolder,
              progress_file: checkpointPath,
              message: stillRunning
                ? `${targetChoom.name} is still working (${toolCallsUsed.length} tool calls so far, ${elapsed}s elapsed). The result will update automatically — check back with get_delegation_result("${delegationId}") for the latest status.${checkpointPath ? ` Interim progress saved to "${checkpointPath}".` : ''}`
                : `${targetChoom.name} ${reasonLabel} but partial work was captured.${checkpointPath ? ` Progress saved to "${checkpointPath}" — read it with workspace_read_file for full details.` : ''} To continue, re-delegate to ${targetChoom.name} with continue_delegation_id="${delegationId}".`,
            });
          }
          const limitNote = isAbort ? ` (${timeoutSeconds}s limit)` : '';
          return this.error(toolCall, `Delegation to "${targetChoom.name}" ${reasonLabel}${limitNote}. ${toolCallsUsed.length > 0 ? `${toolCallsUsed.length} tools were called before failure.` : 'No tools were called.'}`);
        }
        throw streamErr;
      } finally {
        clearTimeout(timeout);
        // Only release the reader if we didn't detach it to a background task
        if (!detachedDelegations.has(delegationId)) {
          try { reader.releaseLock(); } catch { /* already released or errored stream */ }
        }
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

      // Claim verification: cross-check the delegate's response against the
      // worker's project folder on disk. When the delegate's text claims to
      // have created files that DO NOT exist, surface the discrepancy to the
      // orchestrator so it can re-delegate or report honestly to the user
      // instead of trusting a fabricated success report.
      let claimVerification: Awaited<ReturnType<typeof verifyDelegationClaims>> = null;
      if (workerProjectFolder) {
        try {
          claimVerification = await verifyDelegationClaims({
            responseText: effectiveResponse,
            workspaceRoot: WORKSPACE_ROOT,
            projectFolder: workerProjectFolder,
          });
          if (claimVerification?.hadClaims) {
            console.log(
              `   🔎 [${targetChoom.name}] Claim verification: ${claimVerification.verified.length} verified, ${claimVerification.missing.length} missing` +
              (claimVerification.missing.length > 0 ? ` — MISSING: ${claimVerification.missing.join(', ')}` : ''),
            );
          }
        } catch (verifyErr) {
          console.warn(`   ⚠️  [${targetChoom.name}] Claim verification failed:`, verifyErr instanceof Error ? verifyErr.message : verifyErr);
        }
      }

      // If the worker wrote files, the response should be a brief summary.
      // Detect if the response is still very large (worker ignored the instruction)
      // and truncate it — the orchestrator should read the files for full details.
      let responseForOrchestrator = effectiveResponse;
      const fileWriteTools = toolCallsUsed.filter(tc => tc.name === 'workspace_write_file');
      if (workerProjectFolder && effectiveResponse.length > 2000) {
        // Worker wrote a long response instead of keeping it brief.
        // Truncate and point to files.
        const fileList = fileWriteTools.length > 0
          ? `\n\nFiles written: ${fileWriteTools.map(tc => tc.result ? String(tc.result).slice(0, 100) : 'file').join(', ')}`
          : '';
        responseForOrchestrator = effectiveResponse.slice(0, 1500)
          + `\n\n...[response truncated — ${effectiveResponse.length} chars total]${fileList}`
          + `\n\nFor full details, read the files in project folder "${workerProjectFolder}" using workspace_read_file.`;
        console.log(`   🤝 [${targetChoom.name}] Truncated response for orchestrator: ${effectiveResponse.length} → ${responseForOrchestrator.length} chars (files written: ${fileWriteTools.length})`);
      }

      // Append the verification block to the orchestrator-facing response so
      // it lands directly in the model's tool result, alongside the original
      // text the delegate produced. Discrepancies don't fail the call — the
      // orchestrator gets the truth and decides what to do (re-delegate,
      // ask the user, etc).
      const verificationBlock = formatVerificationBlock(claimVerification);
      if (verificationBlock) {
        responseForOrchestrator += verificationBlock;
      }

      const resultPayload: Record<string, unknown> = {
        success: !incomplete && !(claimVerification && claimVerification.missing.length > 0),
        delegation_id: delegationId,
        choom_name: targetChoom.name,
        response: responseForOrchestrator,
        tools_used: toolCallsUsed.map(tc => tc.name),
        duration_seconds: Math.round(durationMs / 1000),
        chat_id: delegationChatId,
        iterations_used: doneIterations,
        max_iterations: doneMaxIterations,
        incomplete,
        project_folder: workerProjectFolder,
        verified_files: claimVerification?.verified ?? [],
        missing_files: claimVerification?.missing ?? [],
        message: incomplete
          ? `${targetChoom.name} ran out of iterations (${doneIterations}/${doneMaxIterations}) and did not finish.${workerProjectFolder ? ` Check "${workerProjectFolder}" for partial work files.` : ''} You can continue by calling delegate_to_choom again with continue_delegation_id="${delegationId}".`
          : (claimVerification && claimVerification.missing.length > 0)
            ? `${targetChoom.name} reported completing the task in ${Math.round(durationMs / 1000)}s, BUT verification found ${claimVerification.missing.length} claimed file(s) that don't exist on disk: ${claimVerification.missing.join(', ')}. Treat the report as partial — re-delegate or tell the user what's actually present.`
            : `${targetChoom.name} completed the task in ${Math.round(durationMs / 1000)}s.${workerProjectFolder ? ` Read files in "${workerProjectFolder}" for full details.` : ''}`,
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

    const stillRunning = detachedDelegations.has(result.id);
    return this.success(toolCall, {
      success: true,
      delegation_id: result.id,
      choom_name: result.choomName,
      task: result.task,
      response: result.response,
      tools_used: result.toolCalls.map(tc => tc.name),
      tool_call_count: result.toolCalls.length,
      duration_seconds: Math.round(result.durationMs / 1000),
      age_seconds: Math.round((Date.now() - result.timestamp) / 1000),
      incomplete: result.incomplete,
      in_progress: stillRunning,
      message: stillRunning
        ? `${result.choomName} is still working (${result.toolCalls.length} tool calls so far). Check back again shortly.`
        : result.incomplete
          ? `${result.choomName} did not finish. Use continue_delegation_id="${result.id}" to resume.`
          : `${result.choomName} completed the task.`,
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
