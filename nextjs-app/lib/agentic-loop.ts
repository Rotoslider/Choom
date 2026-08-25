/**
 * The chat agentic loop (C-22 POST split).
 *
 * This is the while-loop heart of a chat turn, extracted verbatim from
 * app/api/chat/route.ts: per-iteration LLM streaming with three-phase
 * timeouts and the fallback-model chain, tool-call parsing/salvage across
 * every local-model format, nudge ladders (narration, fabrication,
 * task-continuation, reflection), pre-flight guards (dedup, caps, broken
 * tools), parallel/sequential tool execution, and the final fullContent
 * assembly + max-iterations progress note.
 *
 * State contract: the loop owns its iteration state locally and returns a
 * LoopOutcome. Shared OBJECTS passed in (currentMessages, llmSettings, ctx,
 * traceBuilder, allToolResults) are mutated in place, exactly as the
 * original closure did. Scalars/arrays the loop reassigns (llmClient,
 * activeTools, maxIterations, fullContent, allToolCalls, resolvedProvider,
 * usingCloudProvider) come in as initial values and go out in the outcome.
 */
import prisma from '@/lib/db';
import { LLMClient, ChatMessage, accumulateToolCalls } from '@/lib/llm-client';
import {
  CONFIG_ERROR, PARAM_ERROR, HA_SHAPE_ERROR, HA_DISCOVERY_ERROR, GPU_BUSY,
  NO_DATA, PATH_ERROR, STALE_REF_ERROR, PERMISSION_BLOCK,
  classifyToolError, type ToolErrorClass,
} from '@/lib/tool-error-classification';
import { classifyEndpoint, computeStreamTimeouts, isLocalEndpoint } from '@/lib/stream-timeouts';
import { detectClaimedTool, detectZeroToolClaim, detectUncalledToolClaim, findFabricatedImageRefs } from '@/lib/phantom-claim';
import { isNearVerbatimRepeat, stripRepeatedParagraphs, stripInternalRepeats } from '@/lib/repetition-guard';
import {
  tryRepairJSON, createThinkFilter, createToolCallXmlFilter, createJsonToolCallFilter,
  createGemmaToolCallFilter, extractMistralToolCalls, extractBracketToolCalls,
  parseXmlToolCalls, tryRescueWriteFile, tryRescueContentTool, extractToolCallFromText,
} from '@/lib/tool-call-parsing';
import { ProjectService } from '@/lib/project-service';
import { findLLMProfile } from '@/lib/model-profiles';
import { getSkillRegistry } from '@/lib/skill-registry';
import { CompactionService } from '@/lib/compaction-service';
import { compressStaleToolResult } from '@/lib/tool-output-compressor';
import { attachPivotHintToError } from '@/lib/pivot-hint';
import { TraceBuilder } from '@/lib/execution-trace';
import { defaultLLMSettings } from '@/lib/chat-defaults';
import { WORKSPACE_ROOT } from '@/lib/config';
import {
  serverLog, contextBreakdown,
  type FallbackConfig, type DetectedProject,
} from '@/lib/chat-shared';
import { type ToolContext, executeToolCall, executeToolCallViaSkills } from '@/lib/tool-execution';
import type { LLMSettings, ToolCall, ToolResult, ToolDefinition, LLMProviderConfig, LLMModelProfile } from '@/lib/types';
import type { Choom, Chat, Message } from '@prisma/client';

export interface AgenticLoopParams {
  send: (data: Record<string, unknown>) => void;
  sse: { closed: boolean };
  ctx: ToolContext;
  traceBuilder: TraceBuilder;
  currentMessages: ChatMessage[];
  activeTools: ToolDefinition[];
  llmClient: { streamChat: LLMClient['streamChat'] };
  llmSettings: LLMSettings;
  clientLLMSettings: Record<string, unknown>;
  settings: Record<string, unknown> | undefined;
  providers: LLMProviderConfig[];
  usingCloudProvider: boolean;
  resolvedProvider: string;
  fallbackConfigs: FallbackConfig[];
  createClientForFallback: (fb: FallbackConfig) => Promise<{ client: { streamChat: LLMClient['streamChat'] }; settings: LLMSettings }>;
  taskOverrideActive: boolean;
  taskModelOverride: unknown;
  choom: Choom;
  chat: Chat & { messages: Message[] };
  choomId: string;
  chatId: string;
  logChatId: string;
  message: string;
  isGroupTurn: boolean;
  isHeartbeat: boolean;
  isDelegation: boolean;
  noTools: boolean;
  suppressNotifications: boolean;
  freshContext: boolean;
  maxIterationsOverride: unknown;
  detectedProject: DetectedProject | null;
  skillDispatch: boolean;
  compactionService: CompactionService;
  systemPromptWithSummary: string;
  planFullySucceeded: boolean;
  maxIterations: number;
  iterationCapLocked: boolean;
  fullContent: string;
  allToolCalls: ToolCall[];
  allToolResults: ToolResult[];
}

export interface LoopOutcome {
  iteration: number;
  maxIterations: number;
  fullContent: string;
  allToolCalls: ToolCall[];
  resolvedProvider: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  maxPromptTokens: number;
  llmMsTotal: number;
  llmPrefillMsTotal: number;
  llmCallCount: number;
  maxLlmCallMs: number;
  firstLlmCallAt: number;
  compressionSavedChars: number;
  brokenTools: Set<string>;
}

export async function runAgenticLoop(params: AgenticLoopParams): Promise<LoopOutcome> {
  const {
    send, sse, ctx, traceBuilder,
    currentMessages, llmSettings, clientLLMSettings, settings, providers,
    fallbackConfigs, createClientForFallback, taskOverrideActive, taskModelOverride,
    choom, chat, choomId, chatId, logChatId, message,
    isGroupTurn, isHeartbeat, isDelegation, noTools, suppressNotifications, freshContext,
    maxIterationsOverride, skillDispatch,
    compactionService, systemPromptWithSummary, planFullySucceeded,
    allToolResults,
  } = params;
  let llmClient = params.llmClient;
  let activeTools = params.activeTools;
  let usingCloudProvider = params.usingCloudProvider;
  let resolvedProvider = params.resolvedProvider;
  let maxIterations = params.maxIterations;
  let iterationCapLocked = params.iterationCapLocked;
  let fullContent = params.fullContent;
  let allToolCalls = params.allToolCalls;
  let fallbackAttempt = 0; // Tracks which fallback to try next (0 = try #1, 1 = try #2)
  let imageGenCount = 0; // Per-batch image gen counter (cap at 5 per batch; resets each agentic loop iteration)
          // ================================================================
          // AGENTIC LOOP — iterate until LLM stops calling tools or limit
          // ================================================================
          let iteration = 0;
          let nudgeCount = 0; // Track how many times we've nudged (max 5)
          // Group rooms suppress ALL nudges (they cause argumentative loops). The one
          // real failure owners hit is a Choom who AFFIRMATIVELY narrates "I'll generate
          // an image" / "I'll remember that" then never calls the tool — the action
          // silently never happens, and re-nudging just makes her re-narrate. So instead
          // of nagging, on exactly ONE retry per turn we FORCE that one tool: see
          // `groupForcedTool` below. Plain `tool_choice='required'` is unsafe in rooms
          // (qwen picks the wrong tool — junk `remember` of the transcript), so the retry
          // narrows the tools array to JUST the intended tool and forces 'required' — the
          // only tool it can call is the right one, and the model writes its own args
          // (verified against LM Studio: named tool_choice 400s, single-tool+required is
          // honored 3/3 with clean args). Bounded to once; an empty forced reply relaxes
          // back to conversation via the toolChoiceWasRequired fallback.
          let groupToolNudgeUsed = false;
          // When set (to a tool name), the NEXT iteration forces exactly that tool. Read
          // and cleared (one-shot) where toolChoiceOverride is computed.
          let groupForcedTool: string | null = null;
          // Set when a fabricated-success claim is detected; narrows the next
          // iteration to that single tool (see detectClaimedTool).
          let phantomForcedTool: string | null = null;
          // Token usage accumulator — captures usage from each LLM call across iterations
          let totalPromptTokens = 0;
          let totalCompletionTokens = 0;
          // Largest single-call prompt (C-53). totalPromptTokens SUMS usage across
          // every LLM call in the turn, so in traces it reads like one giant prompt
          // when it's really 3×~89k — this field records what one call actually sent.
          let maxPromptTokens = 0;
          // Per-phase wall-clock (C-11): a 17-minute 2-iteration request is
          // undiagnosable from durationMs alone. llmMsTotal counts time inside
          // LLM streaming calls — failed calls and fallback attempts included,
          // since their wall-clock is what the user waited through. Prefill =
          // call start → first SSE chunk (connection + prompt processing, the
          // dominant cost for big local-model prompts).
          let llmMsTotal = 0;
          let llmPrefillMsTotal = 0;
          let llmCallCount = 0;
          let maxLlmCallMs = 0;
          let firstLlmCallAt = 0; // request start → this = prep (prompt build, memory, compaction, planning)
          const recordLlmCall = (start: number, firstChunkAt: number) => {
            const callMs = Date.now() - start;
            llmMsTotal += callMs;
            llmCallCount++;
            if (callMs > maxLlmCallMs) maxLlmCallMs = callMs;
            llmPrefillMsTotal += (firstChunkAt || Date.now()) - start;
          };
          // Freshness-tiered tool-output compression: when on, stale tool results
          // already in the transcript are trimmed before each re-send (the fresh
          // batch stays full). savedChars accumulates the context bytes trimmed.
          const compressToolOutputs = !!(clientLLMSettings as Record<string, unknown>)?.compressToolOutputs;
          // compressionSavedChars is the CUMULATIVE counterfactual: a compressed
          // message keeps saving on every later iteration it's re-sent, so we add
          // the live trimmed-byte total once per LLM call (top of the loop) rather
          // than once at compression time. liveTrimmedChars = bytes currently
          // trimmed from the transcript.
          let compressionSavedChars = 0;
          let liveTrimmedChars = 0;

          // Proactive tool_choice='required': if the user message has strong tool intent,
          // force the LLM to call a tool on the first iteration instead of narrating.
          // This is the biggest reliability win for local models that tend to describe actions.
          const msgLower = message.toLowerCase();
          const strongToolIntent = /\b(what(?:'?s| is) the weather|weather (?:like|today|tomorrow|forecast)|search (?:for|the web)|look up|find (?:me|out)|generate (?:an? |some )?(?:image|picture|photo|selfie|portrait)|take a (?:selfie|photo|picture)|create (?:a |an )?(?:image|picture)|make (?:me |an? )?(?:image|picture|selfie)|(?:please |can you |you should )remember (?:that|this|my|i |the |for )|(?<!i )(?<!i'll )remember (?:that |this |my |i |the |for )|(?:don'?t |never )forget (?:that|this|my|i )|(?:save|store|note|keep) (?:this|that|my|the |it )(?:in |to |as )?(?:memory|mind)?|use (?:the )?remember(?: tool)?|remind me|set (?:a )?reminder|send (?:a )?(?:notification|message|alert)|check (?:the |my )?(?:calendar|schedule|tasks|email|inbox)|(?:any |do i have (?:any )?|what )(?:appointments?|meetings?|events?)|(?:am i |are we )(?:free|busy|available)|what(?:'?s| is) on (?:my )?(?:calendar|schedule|for )?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)|(?:what(?:'?s| is| do i have) )(?:scheduled|planned|coming up)|when (?:is|was|did) (?:my |the )?(?:next|last) |when (?:is|was) the last time i |when did i (?:last )?(?:go|get|have|see|do|visit|fill|take)|write (?:a |an )?(?:file|document|report)|read (?:the |my |this )?(?:file|document|pdf|report)|(?:look|take a look|glance) at (?:the |this |that )?(?:file|document|pdf|report)|open (?:the |this |that )?(?:pdf|report|document)|review (?:the |this |that )?(?:file|document|pdf|report)|list (?:my |the )?(?:files|projects|tasks)|download|scrape|analyze (?:this|the|that) (?:image|photo|picture)|turn (?:on|off) (?:the )?|(?:open|close) (?:the )?|(?:lights?|switch|fan|heater|thermostat) (?:on|off)|delegate|get (?:the )?(?:weather|forecast)|search (?:youtube|email|gmail|contacts)|draft (?:an? )?email|compose (?:an? )?email|^habit\b|habit (?:stats|summary|report|breakdown)|how (?:often|many times) (?:do|did|have) i |play (?:some |me )?(?:music|song|track|album|artist|playlist|radio)|put on (?:some )?(?:music|song)|what(?:'?s| is) (?:playing|on)(?: right now| currently)?|(?:pause|stop|skip|next|previous|resume)(?: the)?(?: music| song| track| playback)?|(?:turn|volume) (?:up|down)|(?:search|find)(?: for)?(?: some| a)? (?:music|song|track|artist|album)|(?:start|open|launch|restart|fire up) freecad|(?:in|with|using) freecad|(?:build|design|model|make|create)\b[^.!?\n]{0,50}\b(?:freecad|bracket|holder|mount|enclosure|spacer|bushing|3d model|3d part)|3d.?print)\b/i.test(msgLower);
          // In noTools mode (heartbeat briefings), tools are stripped — never force tool_choice='required'.
          // Without this guard the model is forced to call tools that don't exist and the loop loses the briefing.
          //
          // Group turns are CONVERSATIONAL: `message` is the other speakers' lines,
          // which trip the BROAD tool-intent regex (someone mentions weather, music,
          // etc.). Forcing tool_choice='required' on such a false positive makes the
          // model return an empty response. So in a group turn we force ONLY when a
          // SPECIFIC actionable intent matched (intentToolHint, computed below) — e.g.
          // the owner explicitly asks a Choom to "set a followup". forceToolCall is
          // finalized right after intent detection.
          let forceToolCall = false;
          const executedToolCache = new Map<string, unknown>(); // Dedup: normalizedKey → result
          const dedupHitCounts = new Map<string, number>(); // How many times each dedup key was hit
          let loopBreakRequested = false; // Set when a tight repeat-call loop is detected
          const failedCallCache = new Map<string, string>(); // Cache: dedupKey → error message
          const cachedFailureHits = new Map<string, number>(); // Re-serves of each failed dedupKey (same-args retry pressure)
          const toolCallCounts = new Map<string, number>(); // Per-tool name call counter
          const brokenTools = new Set<string>(); // Tool names blocked due to config/auth errors
          const toolReplacementHints = new Map<string, string>(); // failedTool → "use X with Y" extracted from error messages
          const toolFailureCounts = new Map<string, number>(); // Per-tool name failure counter
          let consecutiveFailures = 0; // Abort after MAX_CONSECUTIVE_FAILURES
          const MAX_CONSECUTIVE_FAILURES = 6;
          // Reflection ladder: before we strip tools on repeated failures, give the
          // Choom chances to think laterally. Weaker local models tend to retry the
          // same failing approach; a targeted nudge unlocks alternate paths.
          let reflectionNudgesUsed = 0;
          const MAX_REFLECTION_NUDGES = 2;
          const MAX_FAILURES_PER_TOOL = 2; // Block tool after this many failures (any error)
          // Iterative tools where errors ARE the workflow (write code → error →
          // read traceback → fix) get extra headroom before blocking; a cap of 2
          // turns one typo plus one bad API guess into a full-turn lockout.
          const ITERATIVE_TOOL_FAILURE_CAPS = new Map<string, number>([
            ['run_freecad_python', 6],
          ]);
          const failureCapFor = (toolName: string) =>
            ITERATIVE_TOOL_FAILURE_CAPS.get(toolName) ?? MAX_FAILURES_PER_TOOL;
          const choomTag = `[${choom.name}]`;
          console.log(`   🛠️  ${choomTag} Tools available: ${activeTools.length}${skillDispatch ? ' [skill dispatch]' : ''}`);
          // Intent-specific tool guidance: when we detect a specific intent, inject a
          // system message steering the LLM to the correct tool. This prevents the LLM
          // from calling get_calendar_events when the user says "remind me" etc.
          let intentToolHint = '';
          if (/\b(?:set|schedule|make|create|queue|put in)\b[^.!?\n]{0,24}?\bfollow[\s-]?up\b|\bremind\s+yourself\b|\bself[\s-]?follow[\s-]?up\b|\bfollow[\s-]?up\s+with\s+yourself\b|\b(?:set|make)\s+(?:a\s+)?reminder\s+for\s+yourself\b|\b(?:come|pop|check|circle|head)\s+back\s+(?:in(?:to)?|to)\s+(?:the\s+)?(?:room|lounge|chat)\b/i.test(msgLower)) {
            // In a room → return-to-room tool; in 1:1 → private self-followup.
            intentToolHint = isGroupTurn ? 'schedule_room_followup' : 'schedule_self_followup';
          } else if (/\b(?:remind me(?! (?:what|who|when|where|how|why))|set (?:a )?reminder)\b/i.test(msgLower)) {
            // "remind me what you said about X" is a memory question, not a
            // reminder ask — matters more now that the hint narrows the first
            // forced call to this single tool (C-52).
            intentToolHint = 'create_reminder';
          } else if (/\b(?:check (?:the |my )?(?:calendar|schedule)|what(?:'?s| is) on (?:my )?(?:calendar|schedule|for )?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)?|(?:any |do i have (?:any )?|what )(?:appointments?|meetings?|events?)|(?:am i |are we )(?:free|busy|available)|(?:what(?:'?s| is| do i have) )(?:scheduled|planned|coming up)|(?:anything )(?:on |scheduled )(?:for )?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)|when (?:is|was|did) (?:my |the )?(?:next|last) |when (?:is|was) the last time i |when did i (?:last )?(?:go|get|have|see|do|visit|fill|take))\b/i.test(msgLower)) {
            intentToolHint = 'get_calendar_events';
          } else if (/^habit\b/i.test(msgLower)) {
            intentToolHint = 'log_habit';
          } else if (/\b(?:habit (?:stats|summary|report|breakdown)|how (?:often|many times) (?:do|did|have) i )\b/i.test(msgLower)) {
            intentToolHint = 'habit_stats';
          } else if (/\b(?:play (?:some |me )?(?:music|song|track|album)|put on (?:some )?(?:music|song))\b/i.test(msgLower)) {
            intentToolHint = 'music_play';
          } else if (/\b(?:what(?:'?s| is) (?:playing|on)(?: right now| currently)?|now playing)\b/i.test(msgLower)) {
            intentToolHint = 'music_now_playing';
          } else if (/\b(?:pause|stop|skip|next|previous|resume)(?: the)?(?: music| song| track| playback)?\b/i.test(msgLower) && /\b(?:music|song|track|playback|playing|speaker)\b/i.test(msgLower)) {
            intentToolHint = 'music_control';
          } else if (/\b(?:search|find)(?: for)?(?: some| a)? (?:music|song|track|artist|album)\b/i.test(msgLower)) {
            intentToolHint = 'music_search';
          } else if (/\b(?:grab|take|get|capture|snap|check|show|pull)\b[^.!?\n]{0,40}\b(?:cam|camera|snapshot)\b|\bcamera\s+(?:snapshot|image|shot|view|feed)\b|\b(?:tower|garage)\s*cam\b/i.test(msgLower)) {
            // "grab another tower cam snapshot", "check the garage camera" —
            // camera asks previously fell through intent detection entirely,
            // so soft phrasings ("...if you want to see the sunset") produced
            // pure conversation with no tool call.
            intentToolHint = 'ha_get_camera_snapshot';
          } else if (/\bgenerate[ _]?image tool\b/i.test(msgLower) || /\b(?:generate|generating|create|creating|make|making|draw|render)\b[^.!?\n]{0,50}\b(?:image|selfie|picture|portrait|photo)s?\b[^.!?\n]{0,40}\bof\s+you(?:rself)?\b/i.test(msgLower)) {
            // "generate a couple of images of you", "you forgot to use the
            // generate image tool" — the user's single most common image ask
            // had NO intent hint, so the ignored-required retry had no tool
            // to narrow to and qwen went 0/3 on it in long context (C-44).
            intentToolHint = 'generate_image';
          } else if (/\bworkspace_list_files\b|\b(?:list|show(?: me)?|what(?:'?s| is) in)\b[^.!?\n]{0,30}\b(?:workspace|files|folders)\b/i.test(msgLower)) {
            // "List the files in your workspace" had NO hint, so the broad
            // proactive force free-picked a tool — measured live (C-52):
            // qwen answered with a generate_image junk selfie.
            intentToolHint = 'workspace_list_files';
          }
          // NEVER force tool_choice on a group turn. Proven by execution traces:
          // in a room, `message` is the SIBLINGS' lines, which constantly trip the
          // broad tool-intent regex (they mention images, music, "remember this
          // moment"…). Forcing tool_choice='required' there made qwen obey by
          // dumping the transcript into a junk `remember` call and emitting ZERO
          // conversational text — so the speaker (esp. the initiator, who reads the
          // most accumulated sibling content) went SILENT every single round. The
          // empty-guard's unforced-retry can't save it because the junk tool call
          // makes hasToolCalls=true. Unforced tool use already works in rooms
          // (siblings generate images / play music with force=False), so forcing
          // only ever harms. 1:1 chats keep proactive forcing on strong intent —
          // smaller context, real user commands, and the behavior the user relies on.
          forceToolCall = !isGroupTurn && (strongToolIntent || !!intentToolHint) && activeTools.length > 0;
          if (forceToolCall) {
            traceBuilder.setForceToolCall();
            console.log(`   ⚡ ${choomTag} Tool intent detected — using tool_choice='required' on first iteration${intentToolHint ? ` (hint: ${intentToolHint})` : ''}`);
          }
          // C-52: when the detected intent names ONE specific tool, the first
          // forced call exposes only that tool (consumed one-shot at the
          // tools/tool_choice build below, like the group + phantom narrows).
          let intentForcedTool: string | null = null;
          if (forceToolCall && intentToolHint && activeTools.some(t => t.name === intentToolHint)) {
            intentForcedTool = intentToolHint;
          }
          if (!isGroupTurn && forceToolCall && intentForcedTool && activeTools.length > 0) {
            // Guidance is only honest when it is ENFORCED: 1:1 turns where
            // tool_choice forces the hinted tool AND that tool is exposed.
            //
            // NEVER in group rooms: `message` there is the siblings' chatter,
            // so the hint regexes trip on stray words ("stop", "track",
            // "resume" + "playing/speaker") and this line then commanded
            // music_control all turn long — three sightings across two
            // sisters before anyone traced it (2026-08-25). Rooms get no
            // tool_choice forcing either (see above), so the guidance would
            // be unbacked pressure with a fabricated "user's request".
            // Must NOT be role:'system'. Strict chat templates (Qwen/ChatML via
            // LM Studio) hard-400 the whole request on any system turn after
            // index 0 ("System message must be at the beginning"). A user-role
            // turn is valid everywhere AND keeps the guidance recent — folding
            // it into the head system prompt would bury it under the entire
            // conversation, which is exactly where it stops working.
            currentMessages.push({
              role: 'user',
              content: `[Tool guidance] The user's request maps to the "${intentToolHint}" tool. Call that tool directly — do NOT use other tools for this request.`,
            });
          }

          // Simple tasks model routing: if the user's intent maps to a routine tool
          // and a lightweight model is configured, switch to it. This avoids burning
          // expensive/slow models on simple operations like reminders, habits, weather.
          const SIMPLE_TASK_TOOLS = new Set([
            'create_reminder', 'get_reminders',
            'log_habit', 'habit_stats', 'query_habits',
            'get_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
            'get_weather', 'get_weather_forecast',
            'get_task_list', 'list_task_lists', 'add_to_task_list', 'remove_from_task_list',
            'remember', 'search_memories', 'get_recent_memories',
            'send_notification',
            'music_play', 'music_control', 'music_search', 'music_now_playing', 'music_players',
          ]);
          const simpleTasksEnabled = (clientLLMSettings as Record<string, unknown>)?.simpleTasksEnabled;
          const simpleTasksModel = (clientLLMSettings as Record<string, unknown>)?.simpleTasksModel as string | undefined;
          if (simpleTasksEnabled && simpleTasksModel && intentToolHint && SIMPLE_TASK_TOOLS.has(intentToolHint) && !taskModelOverride) {
            // Apply the simple-tasks model's profile BEFORE building the client/settings, so the
            // swapped model runs with its own params (temp, topP, contextLength, topK, etc.) rather
            // than inheriting the primary model's profile that was applied earlier in this request.
            const stUserProfiles = (settings?.modelProfiles as LLMModelProfile[]) || [];
            const stProfile = findLLMProfile(simpleTasksModel, stUserProfiles);
            if (stProfile) {
              if (stProfile.temperature !== undefined) llmSettings.temperature = stProfile.temperature;
              if (stProfile.topP !== undefined) llmSettings.topP = stProfile.topP;
              if (stProfile.maxTokens !== undefined) llmSettings.maxTokens = stProfile.maxTokens;
              if (stProfile.contextLength !== undefined) llmSettings.contextLength = stProfile.contextLength;
              if (stProfile.frequencyPenalty !== undefined) llmSettings.frequencyPenalty = stProfile.frequencyPenalty;
              if (stProfile.presencePenalty !== undefined) llmSettings.presencePenalty = stProfile.presencePenalty;
              if (stProfile.topK !== undefined) llmSettings.topK = stProfile.topK;
              if (stProfile.repetitionPenalty !== undefined) llmSettings.repetitionPenalty = stProfile.repetitionPenalty;
              if (stProfile.enableThinking !== undefined) llmSettings.enableThinking = stProfile.enableThinking;
              console.log(`   📋 Applied profile for simple-tasks model ${simpleTasksModel}`);
            }
            const simpleProviderId = (clientLLMSettings as Record<string, unknown>)?.simpleTasksProviderId as string | undefined;
            if (simpleProviderId && simpleProviderId !== '_local' && providers.length > 0) {
              const simpleProvider = providers.find((p: LLMProviderConfig) => p.id === simpleProviderId);
              if (simpleProvider) {
                const simpleSettings: LLMSettings = { ...llmSettings, model: simpleTasksModel, endpoint: simpleProvider.endpoint };
                if (simpleProvider.type === 'anthropic') {
                  const { AnthropicClient } = await import('@/lib/anthropic-client');
                  llmClient = new AnthropicClient(simpleSettings, simpleProvider.apiKey || '', simpleProvider.endpoint);
                } else {
                  llmClient = new LLMClient(simpleSettings, simpleProvider.apiKey || undefined);
                }
                llmSettings.model = simpleTasksModel;
                llmSettings.endpoint = simpleProvider.endpoint;
                usingCloudProvider = !isLocalEndpoint(simpleProvider.endpoint);
                resolvedProvider = simpleProvider.id;
                console.log(`   🔀 ${choomTag} Simple task routing: ${simpleProvider.name}/${simpleTasksModel} (intent: ${intentToolHint})`);
              }
            } else {
              llmSettings.model = simpleTasksModel;
              llmSettings.endpoint = defaultLLMSettings.endpoint;
              llmClient = new LLMClient(llmSettings);
              usingCloudProvider = false;
              resolvedProvider = 'local';
              console.log(`   🔀 ${choomTag} Simple task routing: local/${simpleTasksModel} (intent: ${intentToolHint})`);
            }
          }

          // Same-model retry: an empty response (200 OK, 0 chars, no tool calls)
          // is almost always transient — local servers hiccup under KV-cache
          // churn on big group loads; cloud reasoning models (OpenRouter
          // stealth) emit empty bodies during upstream churn. Either way,
          // escalating straight to a DIFFERENT — usually lesser — fallback
          // model throws away work a second attempt would very likely finish
          // (2026-08-25: Eve's ox-alpha turn jumped empty → deepseek-v4-flash).
          // So prepend ONE retry of the SAME model as fallback #0 with a short
          // settle delay. Skipped when a task override already prepended the
          // choom's primary (heartbeat/cron) to avoid a double retry.
          {
            const primaryIsLocal = !usingCloudProvider || isLocalEndpoint(llmSettings.endpoint);
            if (!taskOverrideActive) {
              fallbackConfigs.unshift({
                model: llmSettings.model,
                providerId: (resolvedProvider && resolvedProvider !== 'local') ? resolvedProvider : null,
                label: primaryIsLocal ? `local/${llmSettings.model} (retry)` : `${llmSettings.model} (same-model retry)`,
                retryDelayMs: primaryIsLocal ? 1500 : 2000,
                sameModelRetry: true,
              });
              console.log(`   🔁 ${choomTag} Prepended same-model retry as fallback #0 (${primaryIsLocal ? 'local' : 'cloud'} primary — transient failures retry before model escalation)`);
            }
          }

          // If plan fully succeeded, allow some follow-up iterations for summary, cleanup,
          // and handling incomplete delegations. Don't cap too aggressively — delegation
          // results are often partial and the orchestrator needs room to continue work.
          // NEVER touches a locked cap (request override, <!-- max_iterations: N -->
          // directive, or project metadata) — those were set deliberately and the
          // loop must honor them verbatim. Previously this reduction silently cut
          // a Choom's directive of e.g. 100 down to 15 whenever the plan succeeded.
          if (planFullySucceeded && !iterationCapLocked) {
            const postPlanCap = 15;
            maxIterations = Math.min(maxIterations, postPlanCap);
            console.log(`   📋 Post-plan iteration cap: ${maxIterations}`);
          }

          // Preserve any pre-loop content (e.g., plan summaries) so the final iteration can prefix it
          const preLoopContent = fullContent;
          const iterationTexts: string[] = []; // Track each iteration's text for dedup
          // Final assistant replies from the PREVIOUS turns of this chat —
          // baseline for the cross-turn repeat guard below. Group turns have
          // their own guard in group-chat-runner; freshContext turns have no
          // history to repeat.
          const prevAssistantTexts: string[] = (!isGroupTurn && !freshContext)
            ? chat.messages
                .filter(m => m.role === 'assistant' && m.content && m.content.trim())
                .slice(-2)
                .map(m => m.content)
            : [];
          let crossTurnRepeatRetried = false; // one fresh-reply retry per turn, max
          // Track consecutive iterations that produced only text (no tool calls).
          // When tools were called earlier but the Choom has gone silent for 1+ turns,
          // it usually means she's hedging or summarizing instead of finishing the job.
          let consecutiveNoToolIters = 0;
          // Set once an integrity nudge (fabrication callout / hedge) has fired
          // this turn. A reply that ANSWERS such a nudge with an apology must
          // end the turn, never be re-nudged (C-58: the 2026-08-06 spiral —
          // apology text matched the hedge regex via "sorry I", each nudge bred
          // a longer apology, ending in a 6x-repeated meltdown completion).
          let integrityNudged = false;
          let fallbackActivated = false; // Set when a fallback model takes over mid-request
          let retriedCurrentFallback = false; // Guard: only retry a timed-out fallback once
          let relaxedToolChoice = false; // Guard: only drop forced tool_choice once per request (on a forced-empty turn)

          while (iteration < maxIterations) {
            iteration++;

            // Count this call's compression benefit: the prompt we're about to
            // send is smaller than the uncompressed counterfactual by every byte
            // currently trimmed from the transcript. Adding it once per call (not
            // once per trim) captures the savings on EVERY re-send.
            if (compressToolOutputs) compressionSavedChars += liveTrimmedChars;

            // Reset per-batch image gen counter each iteration — the cap is "5 per batch",
            // not "5 per request". A Choom can generate 5 images, save them, do other work,
            // and then generate 5 more in a later iteration as needed.
            imageGenCount = 0;

            // Early exit: if the SSE stream was closed (e.g., delegation aborted by
            // orchestrator, or client disconnected), stop processing immediately.
            if (sse.closed) {
              console.log(`   🛑 ${choomTag} Stream closed (client disconnected) — stopping agentic loop at iteration ${iteration}`);
              break;
            }

            // Tight repeat-call loop detected during a previous iteration's
            // dedup pass. The model is stuck calling the same tool with the
            // same args. Tool result already returned a STOP error to it; if
            // it still came back here, force termination.
            if (loopBreakRequested) {
              console.log(`   🛑 ${choomTag} Terminating agentic loop — repeat-call loop was detected and STOP error was returned to model`);
              break;
            }

            if (iteration > 1) {
              send({ type: 'agent_iteration', iteration, maxIterations });
              console.log(`   🔄 ${choomTag} Agent iteration ${iteration}/${maxIterations}`);

              // Aggressive within-turn compaction: after iteration 3, replace intermediate
              // messages with a compact progress summary. Reduces context from O(iterations)
              // to a fixed ~5 messages. Benefits both regular chats and delegated workers
              // (workers especially — they do many tool iterations and timeout if context grows too large).
              const AGGRESSIVE_COMPACTION_THRESHOLD = 3;
              {
                // Pass the actual context budget so compaction only fires when needed
                const budget = compactionService.calculateBudget(systemPromptWithSummary, activeTools);
                const aggressiveResult = compactionService.compactAggressiveWithinTurn(
                  currentMessages, iteration, AGGRESSIVE_COMPACTION_THRESHOLD, budget.availableForMessages
                );
                if (aggressiveResult.tokensRecovered > 0) {
                  traceBuilder.recordCompaction();
                  const beforeCount = currentMessages.length;
                  currentMessages.length = 0;
                  currentMessages.push(...aggressiveResult.messages);
                  console.log(`   ⚡ ${choomTag} Aggressive compaction: ${beforeCount} → ${currentMessages.length} msgs, recovered ~${aggressiveResult.tokensRecovered.toLocaleString()} tokens`);
                }
              }

              // Within-turn compaction: ensure context fits budget BEFORE calling LLM.
              // Critical tools (workspace_read_file etc.) are exempt from stubbing —
              // the model needs their results to complete multi-step tasks.
              // This runs AFTER aggressive compaction as a second safety net.
              const CRITICAL_TOOLS = new Set(['workspace_read_file', 'workspace_read_pdf', 'workspace_list_files']);
              const withinTurnResult = compactionService.compactWithinTurn(currentMessages, systemPromptWithSummary, activeTools, 2, CRITICAL_TOOLS);
              if (withinTurnResult.truncatedCount > 0) {
                const beforeTokens = Math.ceil(currentMessages.map(m => m.content || '').join('').length / 4);
                currentMessages.length = 0;
                currentMessages.push(...withinTurnResult.messages);
                const afterTokens = Math.ceil(currentMessages.map(m => m.content || '').join('').length / 4);
                const budget = compactionService.calculateBudget(systemPromptWithSummary, activeTools);
                console.log(`   🗜️  Pre-LLM compaction: truncated ${withinTurnResult.truncatedCount} tool results, recovered ~${withinTurnResult.tokensRecovered.toLocaleString()} tokens (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()}, budget: ~${budget.availableForMessages.toLocaleString()})`);
              }
            }

            // Stream LLM response
            let iterationContent = '';
            // qwen3.6 (enableThinking=false) streams its WHOLE reply through
            // delta.reasoning_content; tool calls get salvaged from it but the
            // conversational PROSE was being discarded as "monologue" → empty turn
            // → false fallback cascade (this is why tool-heavy 1:1 works but a
            // conversational room reply vanished). Buffer that prose so we can use
            // it as the reply when the turn produced no normal content and no tool call.
            let reasoningProse = '';
            let toolCallsAccumulator = new Map<
              number,
              { id: string; name: string; arguments: string }
            >();
            let finishReason = 'stop';

            // Three-phase timeout system based on endpoint type:
            //
            // Three-phase timeout — tuned per endpoint type:
            //   Phase 1 — CONNECTION: server alive? (fast fail on ECONNREFUSED/DNS/5xx)
            //   Phase 2 — PREFILL: processing prompt tokens before first output
            //   Phase 3 — BETWEEN-TOKEN: gap between streaming tokens (stall detection)
            //
            // Policy lives in lib/stream-timeouts.ts (pure + unit-tested).
            const DEFAULT_TIMEOUT_MS = (isDelegation || isGroupTurn) ? 300000 : 180000;
            const timeoutMs = (choom.llmTimeoutSec ? choom.llmTimeoutSec * 1000 : DEFAULT_TIMEOUT_MS);
            const endpointTier = classifyEndpoint(llmSettings.endpoint, usingCloudProvider);
            const { connectionMs: CONNECTION_TIMEOUT_MS, prefillMs: PREFILL_TIMEOUT_MS, betweenTokenMs: BETWEEN_TOKEN_MS } =
              computeStreamTimeouts(endpointTier, timeoutMs);
            const llmCallStart = Date.now();
            if (!firstLlmCallAt) firstLlmCallAt = llmCallStart;
            let llmFirstChunkAt = 0;
            let connectionEstablished = false;
            let firstTokenReceived = false;
            let lastChunkTime = Date.now();
            let chunkCount = 0;
            let inactivityTimer: ReturnType<typeof setTimeout> = undefined!;
            let rejectInactivity: (err: Error) => void;
            const inactivityPromise = new Promise<never>((_, reject) => {
              rejectInactivity = reject;
              // Start with connection timeout — server alive?
              inactivityTimer = setTimeout(() => reject(new Error(
                `LLM connection timeout (no HTTP response in ${CONNECTION_TIMEOUT_MS / 1000}s)`
              )), CONNECTION_TIMEOUT_MS);
            });
            inactivityPromise.catch(() => {}); // suppress unhandled rejection after race
            const onConnected = () => {
              if (connectionEstablished) return;
              connectionEstablished = true;
              clearTimeout(inactivityTimer);
              console.log(`   🔗 ${choomTag} Connected — ${PREFILL_TIMEOUT_MS / 1000}s prefill timeout`);
              inactivityTimer = setTimeout(() => rejectInactivity(new Error(
                `LLM response timeout (connected but no content for ${PREFILL_TIMEOUT_MS / 1000}s)`
              )), PREFILL_TIMEOUT_MS);
            };
            const resetInactivity = (hasContent: boolean = false) => {
              clearTimeout(inactivityTimer);
              if (!llmFirstChunkAt) llmFirstChunkAt = Date.now();
              lastChunkTime = Date.now();
              chunkCount++;
              if (!connectionEstablished) {
                connectionEstablished = true;
                console.log(`   🔗 ${choomTag} Connected — ${PREFILL_TIMEOUT_MS / 1000}s prefill timeout`);
              }
              if (!firstTokenReceived && hasContent) {
                firstTokenReceived = true;
                console.log(`   ⚡ ${choomTag} First content token — switching to ${BETWEEN_TOKEN_MS / 1000}s between-token timeout`);
              }
              let currentTimeout: number;
              let timeoutMsg: string;
              if (firstTokenReceived) {
                currentTimeout = BETWEEN_TOKEN_MS;
                timeoutMsg = `LLM response timeout (no data for ${currentTimeout / 1000}s, last chunk ${Math.round((Date.now() - lastChunkTime) / 1000)}s ago, ${chunkCount} chunks received)`;
              } else {
                currentTimeout = PREFILL_TIMEOUT_MS;
                timeoutMsg = `LLM response timeout (connected but no content for ${PREFILL_TIMEOUT_MS / 1000}s)`;
              }
              inactivityTimer = setTimeout(() => rejectInactivity(new Error(timeoutMsg)), currentTimeout);
            };
            let wallClockTimer: ReturnType<typeof setTimeout> = undefined!;
            const wallClockPromise = new Promise<never>((_, reject) => {
              wallClockTimer = setTimeout(() => reject(new Error('LLM response timeout')), timeoutMs);
            });
            wallClockPromise.catch(() => {}); // suppress unhandled rejection after race
            // Abort handle for THIS primary stream. Without it, a timed-out
            // stream keeps running in the background after the fallback takes
            // over — appending to iterationContent, send()ing stale chunks,
            // pouring late tool-call deltas into the fallback's accumulator,
            // and double-counting usage. Found by the post-C-22 adversarial
            // review; present in the monolith since the fallback chain landed.
            const llmAbort = new AbortController();

            // Hard rule: a group turn NEVER sends tool_choice='required'. Beyond the
            // initial intent check, several mid-loop nudges (task-continuation,
            // forced-ignored, narration) can flip forceToolCall back on — and in a
            // room that recreates the exact silence bug (forced → junk tool call →
            // empty reply). This single gate enforces "rooms are conversational,
            // never forced" no matter which path set the flag.
            const allowForce = forceToolCall && !isGroupTurn;
            // Group single-tool forced retry: the ONLY way a room ever forces. We narrow
            // the tools array to the one tool the speaker narrated but didn't call, then
            // force 'required' — so qwen can't pick a junk tool and must produce the real
            // call (it writes its own args from context). One-shot; consumed here.
            const groupForceActive = isGroupTurn && !!groupForcedTool && activeTools.some(t => t.name === groupForcedTool);
            // Phantom recovery reuses the same single-tool mechanism, but is NOT
            // limited to group turns — a fabricated claim happens anywhere.
            const phantomForceActive = !!phantomForcedTool && activeTools.some(t => t.name === phantomForcedTool);
            // C-52: a proactive force with a specific intent hint narrows the
            // FIRST call to that one tool. Broad required across 132 tools is
            // exactly how "list the files in your workspace" produced a junk
            // generate_image selfie (live 08-04); single-tool+required is the
            // C-32-measured 100% mechanism. Later iterations restore all tools.
            const intentForceActive = allowForce && !!intentForcedTool && activeTools.some(t => t.name === intentForcedTool);
            const forcedSingle = groupForceActive ? groupForcedTool : phantomForceActive ? phantomForcedTool : intentForceActive ? intentForcedTool : null;
            const iterationTools = forcedSingle ? activeTools.filter(t => t.name === forcedSingle) : activeTools;
            const toolChoiceOverride = (allowForce || forcedSingle) ? 'required' as const : undefined;
            const toolChoiceWasRequired = allowForce || !!forcedSingle;
            if (phantomForceActive) {
              console.log(`   🚨 ${choomTag} Phantom recovery → tools=[${phantomForcedTool}] tool_choice='required'`);
            } else if (groupForceActive) {
              console.log(`   ⚡ ${choomTag} Group forced single-tool retry → tools=[${groupForcedTool}] tool_choice='required'`);
            } else if (intentForceActive) {
              console.log(`   🎯 ${choomTag} Intent-narrowed force → tools=[${intentForcedTool}] tool_choice='required'`);
            } else if (forceToolCall) {
              if (allowForce) console.log(`   ⚡ Using tool_choice='required' to force tool invocation`);
            }
            forceToolCall = false; // Reset after use
            groupForcedTool = null; // one-shot: consumed this iteration
            phantomForcedTool = null; // one-shot: consumed this iteration
            intentForcedTool = null; // one-shot: consumed this iteration

            // Think-block filter: strips <think>...</think> from reasoning models
            const thinkFilter = createThinkFilter();
            // Tool-call XML filter: strips <tool_call>...</tool_call> emitted as text
            // by local models and captures them for parsing into real tool calls
            const toolCallXmlFilter = createToolCallXmlFilter();
            // JSON tool-call filter: strips [{"name":"...","parameters":{...}}] arrays
            // emitted as plain text (common with Qwen/Mistral models)
            const jsonToolCallFilter = createJsonToolCallFilter();
            // Gemma 4 tool-call filter: strips <|tool_call>call:name{args}<tool_call|>
            // blocks emitted as text when Gemma's special tokens aren't tokenized
            const gemmaToolCallFilter = createGemmaToolCallFilter();
            // Hoisted so fallback loop can also contribute captured blocks
            let capturedXmlToolCalls: string[] = [];
            let capturedFbJsonToolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
            let thinkTokensFiltered = false;

            // Buffer post-first-text content for dedup before sending.
            // Once ANY earlier iteration of this turn produced text, the next
            // text iteration is a re-generation risk: nudged models (tool_use,
            // fakeSuccess/phantom) routinely replay their previous text
            // alongside the forced tool call — streaming it live means TTS and
            // Signal get the duplicate before dedup can catch it (C-43: a
            // nudged remember call arrived with the ENTIRE prior reply
            // re-attached, and both copies were spoken). Tool-call-only gating
            // missed exactly that case: at the nudged iteration's start no
            // tool had run yet, so the replay streamed live.
            // Also buffer when tools ran and the chat has prior assistant
            // turns: the cross-turn repeat guard below can only suppress a
            // replayed reply while it's still unsent. Cost: these iterations
            // arrive as one chunk instead of token-streaming — same tradeoff
            // the within-turn dedup already made. Iteration 1 of a fresh turn
            // always token-streams.
            const bufferForDedup = iterationTexts.length > 0 || (allToolCalls.length > 0 && prevAssistantTexts.length > 0);

            const streamPromise = (async () => {
              let reasoningContentSalvaged = false;
              // Inline repetition detector — when the model regenerates the
              // same paragraph multiple times mid-stream, every chunk has
              // already been sent to the client and TTS by the time post-
              // stream dedup runs. Abort the stream as soon as we detect a
              // 60+ char substring repeating 3 times so TTS doesn't play
              // duplicates aloud and Chatterbox doesn't get hammered.
              let streamAbortedForRepetition = false;
              let lastRepetitionScanLen = 0;
              const detectRepetition = (text: string): boolean => {
                if (text.length < 200) return false;
                // Only scan periodically — every 200 chars of new content —
                // since a substring search is O(n*m).
                if (text.length - lastRepetitionScanLen < 200) return false;
                lastRepetitionScanLen = text.length;
                // Take the trailing 180 chars as the probe. If it appears
                // 2+ MORE times earlier in the buffer (3+ total occurrences),
                // we're in a regenerate-the-same-paragraph loop.
                const probeLen = 180;
                const probe = text.slice(-probeLen);
                if (probe.length < 60) return false;
                let count = 0;
                let pos = 0;
                while (pos < text.length - probeLen) {
                  const idx = text.indexOf(probe, pos);
                  if (idx === -1 || idx >= text.length - probeLen) break;
                  count++;
                  pos = idx + probeLen;
                  if (count >= 2) return true; // 2 prior + 1 trailing = 3 total
                }
                return false;
              };
              for await (const chunk of llmClient.streamChat(currentMessages, iterationTools, llmAbort.signal, toolChoiceOverride, onConnected)) {
                if (streamAbortedForRepetition) break;
                if (!chunk.choices || !chunk.choices[0]) {
                  // Final usage-only chunks have no choices; capture below.
                  if (chunk.usage) {
                    totalPromptTokens += chunk.usage.prompt_tokens || 0;
                    totalCompletionTokens += chunk.usage.completion_tokens || 0;
                    maxPromptTokens = Math.max(maxPromptTokens, chunk.usage.prompt_tokens || 0);
                  }
                  continue;
                }
                const choice = chunk.choices[0];

                // Some local models (Qwen 3.6 35B-A3B observed) route their
                // entire completion — including <tool_call> XML — through
                // delta.reasoning_content instead of delta.content, even when
                // the request explicitly set chat_template_kwargs.enable_thinking
                // = false. When the user disabled thinking, route reasoning
                // tokens through the tool-call filters so the <tool_call>
                // blocks get captured — but the leftover prose IS still the
                // model's chain-of-thought, so we MUST NOT send it to the
                // user / TTS / DB. Track which deltas came from this channel
                // and discard their non-tool-call remainder.
                const deltaAny = choice.delta as { reasoning_content?: string } & typeof choice.delta;
                let chunkIsReasoningOnly = false;
                if (
                  llmSettings.enableThinking === false &&
                  typeof deltaAny.reasoning_content === 'string' &&
                  deltaAny.reasoning_content.length > 0 &&
                  !choice.delta.content
                ) {
                  if (!reasoningContentSalvaged) {
                    console.log(`   🔄 ${choomTag} Routing delta.reasoning_content through tool-call filters (enableThinking=false; reasoning prose will be hidden)`);
                    reasoningContentSalvaged = true;
                  }
                  choice.delta.content = deltaAny.reasoning_content;
                  chunkIsReasoningOnly = true;
                }

                const hasContent = !!(choice.delta.content || choice.delta.tool_calls ||
                  (typeof deltaAny.reasoning_content === 'string' && deltaAny.reasoning_content.length > 0));
                resetInactivity(hasContent);

                if (choice.delta.content) {
                  let visible = thinkFilter(choice.delta.content);
                  if (visible) {
                    visible = toolCallXmlFilter.filter(visible);
                    if (visible) {
                      visible = jsonToolCallFilter.filter(visible);
                    }
                    if (visible) {
                      visible = gemmaToolCallFilter.filter(visible);
                    }
                    if (visible) {
                      // Common model glitch: contraction directly fused to a
                      // number without a separator ("That's16%", "be17%",
                      // "the26%"). Insert the missing space. Narrow regex —
                      // only fires for English contractions ('s/'re/'ll/'ve/
                      // 'd/'t) immediately followed by a digit, so it won't
                      // mangle valid sequences like "v1.0" or "$50".
                      visible = visible.replace(
                        /([a-zA-Z]'(?:s|re|ll|ve|d|t))(\d)/g,
                        '$1 $2',
                      );
                      // Reasoning-only chunks: tool-call filters have already
                      // captured any <tool_call> blocks for parsing. The
                      // remaining `visible` prose is the model's internal
                      // monologue ("The user is asking...", "Let me check...",
                      // "Wait, looking back..."). Drop it on the floor —
                      // don't append to iterationContent, don't stream, don't
                      // hand it to TTS. The agentic loop still works because
                      // tool calls were captured separately.
                      if (!chunkIsReasoningOnly) {
                        // Repetition check on the WOULD-BE accumulator so we
                        // can suppress the chunk that completes the 3rd repeat
                        // instead of streaming it and aborting after the fact.
                        const wouldBe = iterationContent + visible;
                        if (detectRepetition(wouldBe)) {
                          console.warn(`   🔁 ${choomTag} Repetition detected mid-stream (180-char probe seen 3+ times). Aborting stream early to prevent TTS spam.`);
                          streamAbortedForRepetition = true;
                          // Keep iterationContent up to the end of the FIRST
                          // occurrence of the repeating probe — drop the rest.
                          const probe = wouldBe.slice(-180);
                          const firstIdx = iterationContent.indexOf(probe);
                          if (firstIdx !== -1 && firstIdx < iterationContent.length - 180) {
                            const beforeTrim = iterationContent.length;
                            iterationContent = iterationContent.slice(0, firstIdx + probe.length);
                            // Live-streamed iterations already sent the repeated
                            // copies to the client — retract them so the bubble
                            // matches the trimmed content NOW (not at 'done')
                            // and the client can drop the junk from its TTS
                            // queue (C-44). Buffered iterations sent nothing.
                            if (!bufferForDedup) {
                              send({ type: 'retract_partial', length: beforeTrim - iterationContent.length });
                            }
                          }
                        } else {
                          iterationContent += visible;
                          if (!bufferForDedup) {
                            send({ type: 'content', content: visible });
                          }
                        }
                      } else {
                        // Reasoning-channel prose with thinking OFF: for qwen3.6 this
                        // IS the reply, not chain-of-thought. Buffer it; salvaged after
                        // the stream ONLY if the turn produced no normal content and no
                        // tool call (so tool turns are completely unaffected).
                        reasoningProse += visible;
                      }
                    }
                  } else if (choice.delta.content.length > 0) {
                    thinkTokensFiltered = true;
                  }
                }

                if (choice.delta.tool_calls) {
                  accumulateToolCalls(toolCallsAccumulator, choice.delta);
                }

                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }

                // Capture token usage from final chunk (OpenAI sends usage in last chunk,
                // Anthropic adapter attaches it to the finish_reason chunk)
                if (chunk.usage) {
                  totalPromptTokens += chunk.usage.prompt_tokens || 0;
                  totalCompletionTokens += chunk.usage.completion_tokens || 0;
                  maxPromptTokens = Math.max(maxPromptTokens, chunk.usage.prompt_tokens || 0);
                }
              }
              // Flush any buffered partial tag that was never completed.
              // Guard: if a fallback took over, the primary IIFE may still
              // finish late — don't corrupt iterationContent.
              if (!fallbackActivated) {
                const flushed = toolCallXmlFilter.flush();
                if (flushed) {
                  iterationContent += flushed;
                  if (!bufferForDedup) {
                    send({ type: 'content', content: flushed });
                  }
                }
                const flushedJson = jsonToolCallFilter.flush();
                if (flushedJson) {
                  iterationContent += flushedJson;
                  if (!bufferForDedup) {
                    send({ type: 'content', content: flushedJson });
                  }
                }
                const flushedGemma = gemmaToolCallFilter.flush();
                if (flushedGemma) {
                  iterationContent += flushedGemma;
                  if (!bufferForDedup) {
                    send({ type: 'content', content: flushedGemma });
                  }
                }
              }
              if (thinkTokensFiltered) {
                console.log(`   🧠 ${choomTag} Think tokens filtered from response`);
              }
            })();

            try {
              await Promise.race([streamPromise, inactivityPromise, wallClockPromise]);
              // Stream succeeded — clean up timers to prevent leaks
              clearTimeout(inactivityTimer);
              clearTimeout(wallClockTimer);
              recordLlmCall(llmCallStart, llmFirstChunkAt);
              // Empty response guard: model returned 200 OK but streamed 0 content
              // and no tool calls. Treat this the same as a timeout so the fallback
              // chain gets a chance. Without this, an empty response silently breaks
              // out of the loop with no output.
              const hasToolCalls = toolCallsAccumulator.size > 0 ||
                toolCallXmlFilter.getCaptured().length > 0 ||
                jsonToolCallFilter.getCaptured().length > 0 ||
                gemmaToolCallFilter.getCaptured().length > 0;
              // Salvage: qwen3.6 routes its whole reply through reasoning_content.
              // If the turn produced no normal content and no tool call but DID stream
              // reasoning-channel prose, that prose IS the reply (e.g. a conversational
              // group turn) — use it instead of declaring "empty" and firing the
              // fallback chain. Tool turns are unaffected (they have a tool call, so
              // this branch is skipped). This is the actual cause of rooms going silent.
              if (!iterationContent.trim() && !hasToolCalls && reasoningProse.trim()) {
                iterationContent = reasoningProse.trim();
                if (!bufferForDedup) {
                  send({ type: 'content', content: iterationContent });
                }
                console.log(`   💬 ${choomTag} Salvaged reply from reasoning_content channel (${iterationContent.length} chars) — not an empty response`);
              } else if (!iterationContent.trim() && !hasToolCalls && toolChoiceWasRequired && !relaxedToolChoice) {
                // A FORCED tool call came back genuinely empty (no content, no tool call,
                // nothing in reasoning_content). The model wanted to converse, not call a
                // tool — typical on a group conversational turn where the intent was a
                // false positive. Drop forcing and re-run THIS turn UNFORCED so she can
                // speak, instead of cascading to fallback models (which also empty under
                // forcing). This is what lets us keep forcing for real tool requests
                // without group conversational turns going silent.
                relaxedToolChoice = true;
                forceToolCall = false;
                console.log(`   🔁 ${choomTag} Forced call returned empty — retrying this turn WITHOUT tool_choice=required (letting the Choom converse)`);
                continue;
              } else if (!iterationContent.trim() && !hasToolCalls && fallbackAttempt < fallbackConfigs.length) {
                throw new Error('Empty response from model (0 characters, no tool calls)');
              }
            } catch (timeoutError) {
              // The failed call's wall-clock still counts — it's time the user waited.
              recordLlmCall(llmCallStart, llmFirstChunkAt);
              const errMsg = timeoutError instanceof Error ? timeoutError.message : String(timeoutError);
              console.warn(`   ⚠️  LLM response error on iteration ${iteration}: ${errMsg}`);

              // Try fallback models on timeout/error. Even if partial content was streamed,
              // a broken response is worse than switching models. Partial text was already
              // sent to the user; we clear iterationContent and retry with the fallback.
              // Clean up primary model's timer to prevent memory leaks
              clearTimeout(inactivityTimer);
              clearTimeout(wallClockTimer);
              // Kill the primary stream BEFORE any fallback runs. On the
              // empty-response path the stream already completed (abort is a
              // no-op); on the timeout path this stops the zombie stream from
              // interleaving with the fallback's reply. Its pending for-await
              // rejects into the already-settled race — handled, not unhandled.
              llmAbort.abort();

              let fallbackSucceeded = false;
              // If the currently-active fallback timed out (not the primary),
              // allow retrying it once — the timeout may be transient (context
              // grew, API queued). Without this, we burn through the chain
              // linearly and exhaust all fallbacks after a single retry per model.
              if (fallbackActivated && fallbackAttempt > 0 && !retriedCurrentFallback) {
                fallbackAttempt = fallbackAttempt - 1; // retry last-successful fallback
                retriedCurrentFallback = true;
              }
              if (fallbackAttempt < fallbackConfigs.length) {
                if (iterationContent) {
                  console.log(`   ⚠️  ${choomTag} Partial content (${iterationContent.length} chars) ${bufferForDedup ? 'buffered (never sent — no retraction needed)' : 'streamed'} before error — clearing for fallback attempt`);
                  // Only retract text the client actually received. Buffered
                  // content was never sent — retracting its length would chop
                  // earlier LEGITIMATE text off the client's display.
                  if (!bufferForDedup) {
                    send({ type: 'retract_partial', length: iterationContent.length });
                  }
                }
                // Strip nudge/hint messages injected for the primary model —
                // the fallback model hasn't seen the primary's behavior and these
                // messages ("You described what you would do...") will confuse it.
                const beforeStrip = currentMessages.length;
                for (let i = currentMessages.length - 1; i >= 1; i--) {
                  const m = currentMessages[i];
                  if (m.role === 'user' && m.content?.startsWith('[System] You described what')) {
                    currentMessages.splice(i, 1);
                  } else if (m.role === 'user' && m.content?.startsWith('[System] You indicated you have more')) {
                    currentMessages.splice(i, 1);
                  // role:'user', not 'system' — the guidance is PUSHED as a
                  // user turn (strict chat templates 400 on late system
                  // messages), so matching 'system' here meant the strip
                  // never fired and fallbacks kept the primary's stale hint.
                  } else if (m.role === 'user' && m.content?.startsWith('[Tool guidance]')) {
                    currentMessages.splice(i, 1);
                  }
                }
                if (currentMessages.length < beforeStrip) {
                  console.log(`   🧹 ${choomTag} Stripped ${beforeStrip - currentMessages.length} nudge messages before fallback`);
                }
                for (let fbIdx = fallbackAttempt; fbIdx < fallbackConfigs.length; fbIdx++) {
                  const fb = fallbackConfigs[fbIdx];
                  // Patience was already exercised on a TIMEOUT — retrying the
                  // same model just burns its full budget twice before any
                  // escalation. Retry transient failures (empty bodies etc.);
                  // escalate stalls.
                  if (fb.sameModelRetry && /LLM response timeout|LLM connection timeout/.test(String(timeoutError instanceof Error ? timeoutError.message : timeoutError ?? ''))) {
                    console.log(`   ⏭️  ${choomTag} Skipping same-model retry (${fb.label}) — primary already consumed its full timeout budget; escalating`);
                    continue;
                  }
                  console.log(`   🔄 ${choomTag} Trying fallback #${fbIdx + 1}: ${fb.label}`);
                  traceBuilder.recordFallback(fb.label);
                  // Log fallback switch server-side only — don't send as content
                  // (it was leaking to Signal messages and TTS audio)
                  send({ type: 'status', content: `Switching to ${fb.label}` });

                  // Let a flaky local server settle before a same-model retry,
                  // so we don't immediately re-hit it mid-churn.
                  if (fb.retryDelayMs) {
                    console.log(`   ⏳ ${choomTag} Settling ${fb.retryDelayMs}ms before retry...`);
                    await new Promise(res => setTimeout(res, fb.retryDelayMs));
                  }

                  let fbInactivityTimer: ReturnType<typeof setTimeout> = undefined!;
                  let fbWallClockTimer: ReturnType<typeof setTimeout> = undefined!;
                  // Hoisted like the timers so the catch can abort a stream
                  // that failed mid-flight (same zombie-stream protection as
                  // the primary).
                  const fbAbort = new AbortController();
                  // Hoisted above the try so the catch can record the failed
                  // call's wall-clock (0 = failed before the stream started).
                  let fbCallStart = 0;
                  let fbFirstChunkAt = 0;
                  try {
                    const { client: fbClient, settings: fbSettings } = await createClientForFallback(fb);
                    // Reset iteration state for the fallback attempt
                    iterationContent = '';
                    toolCallsAccumulator = new Map();
                    finishReason = 'stop';

                    // Fallback timeout: same three-phase policy as the primary,
                    // via the same function — this was a duplicated copy of the
                    // tier ladder, which is exactly how the two drift apart.
                    // Note the fallback classifies on `!fb.providerId` (a fallback
                    // with no provider is the local default), not usingCloudProvider.
                    const fbIsLocal = !fb.providerId || isLocalEndpoint(fbSettings.endpoint);
                    const fbTimeoutMs = fbIsLocal ? timeoutMs : Math.max(60000, Math.floor(timeoutMs * 0.75));
                    const fbTier = classifyEndpoint(fbSettings.endpoint, !fbIsLocal);
                    const { connectionMs: fbConnectionMs, prefillMs: fbPrefillMs, betweenTokenMs: fbBetweenTokenMs } =
                      computeStreamTimeouts(fbTier, fbTimeoutMs);
                    fbCallStart = Date.now();
                    let fbConnectionEstablished = false;
                    let fbFirstTokenReceived = false;
                    let fbRejectInactivity: (err: Error) => void;
                    const fbInactivityPromise = new Promise<never>((_, reject) => {
                      fbRejectInactivity = reject;
                      fbInactivityTimer = setTimeout(() => reject(new Error(
                        `LLM connection timeout (no HTTP response in ${fbConnectionMs / 1000}s)`
                      )), fbConnectionMs);
                    });
                    fbInactivityPromise.catch(() => {});
                    const fbOnConnected = () => {
                      if (fbConnectionEstablished) return;
                      fbConnectionEstablished = true;
                      clearTimeout(fbInactivityTimer);
                      console.log(`   🔗 ${choomTag} Fallback connected — ${fbPrefillMs / 1000}s prefill timeout`);
                      fbInactivityTimer = setTimeout(() => fbRejectInactivity(new Error(
                        `LLM response timeout (connected but no content for ${fbPrefillMs / 1000}s)`
                      )), fbPrefillMs);
                    };
                    const resetFbInactivity = (hasContent: boolean = false) => {
                      clearTimeout(fbInactivityTimer);
                      if (!fbFirstChunkAt) fbFirstChunkAt = Date.now();
                      if (!fbConnectionEstablished) {
                        fbConnectionEstablished = true;
                        console.log(`   🔗 ${choomTag} Fallback connected — ${fbPrefillMs / 1000}s prefill timeout`);
                      }
                      if (!fbFirstTokenReceived && hasContent) {
                        fbFirstTokenReceived = true;
                        console.log(`   ⚡ ${choomTag} Fallback first content token — switching to ${fbBetweenTokenMs / 1000}s between-token timeout`);
                      }
                      let currentTimeout: number;
                      let timeoutMsg: string;
                      if (fbFirstTokenReceived) {
                        currentTimeout = fbBetweenTokenMs;
                        timeoutMsg = `LLM response timeout (no data for ${fbBetweenTokenMs / 1000}s)`;
                      } else {
                        currentTimeout = fbPrefillMs;
                        timeoutMsg = `LLM response timeout (connected but no content for ${fbPrefillMs / 1000}s)`;
                      }
                      fbInactivityTimer = setTimeout(() => fbRejectInactivity(new Error(timeoutMsg)), currentTimeout);
                    };
                    const fbWallClockPromise = new Promise<never>((_, reject) => {
                      fbWallClockTimer = setTimeout(() => reject(new Error('LLM response timeout')), fbTimeoutMs);
                    });
                    fbWallClockPromise.catch(() => {});
                    console.log(`   ⏱️  Fallback timeout: ${fbTimeoutMs / 1000}s wall-clock, ${fbConnectionMs / 1000}s connection, ${fbPrefillMs / 1000}s prefill, ${fbBetweenTokenMs / 1000}s between-token`);

                    const fbThinkFilter = createThinkFilter();
                    const fbToolCallXmlFilter = createToolCallXmlFilter();
                    const fbJsonToolCallFilter = createJsonToolCallFilter();
                    const fbStreamPromise = (async () => {
                      for await (const chunk of fbClient.streamChat(currentMessages, iterationTools, fbAbort.signal, toolChoiceOverride, fbOnConnected)) {
                        const fbDeltaAny = chunk.choices?.[0]?.delta as { reasoning_content?: string } | undefined;
                        const fbHasContent = !!(chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.delta?.tool_calls ||
                          (typeof fbDeltaAny?.reasoning_content === 'string' && fbDeltaAny.reasoning_content.length > 0));
                        resetFbInactivity(fbHasContent);
                        if (!chunk.choices || !chunk.choices[0]) continue;
                        const choice = chunk.choices[0];
                        if (choice.delta.content) {
                          let visible = fbThinkFilter(choice.delta.content);
                          if (visible) {
                            visible = fbToolCallXmlFilter.filter(visible);
                            if (visible) {
                              visible = fbJsonToolCallFilter.filter(visible);
                            }
                            if (visible) {
                              iterationContent += visible;
                              if (!bufferForDedup) {
                                send({ type: 'content', content: visible });
                              }
                            }
                          }
                        }
                        if (choice.delta.tool_calls) {
                          accumulateToolCalls(toolCallsAccumulator, choice.delta);
                        }
                        if (choice.finish_reason) {
                          finishReason = choice.finish_reason;
                        }
                        if (chunk.usage) {
                          totalPromptTokens += chunk.usage.prompt_tokens || 0;
                          totalCompletionTokens += chunk.usage.completion_tokens || 0;
                          maxPromptTokens = Math.max(maxPromptTokens, chunk.usage.prompt_tokens || 0);
                        }
                      }
                      // Flush any buffered partial tag
                      const fbFlushed = fbToolCallXmlFilter.flush();
                      if (fbFlushed) {
                        iterationContent += fbFlushed;
                        if (!bufferForDedup) {
                          send({ type: 'content', content: fbFlushed });
                        }
                      }
                      const fbFlushedJson = fbJsonToolCallFilter.flush();
                      if (fbFlushedJson) {
                        iterationContent += fbFlushedJson;
                        if (!bufferForDedup) {
                          send({ type: 'content', content: fbFlushedJson });
                        }
                      }
                    })();

                    await Promise.race([fbStreamPromise, fbInactivityPromise, fbWallClockPromise]);
                    clearTimeout(fbInactivityTimer); // clean up timer
                    clearTimeout(fbWallClockTimer);
                    recordLlmCall(fbCallStart, fbFirstChunkAt);

                    // Fallback succeeded — switch llmClient for rest of this request
                    llmClient = fbClient;
                    llmSettings.model = fbSettings.model;
                    llmSettings.endpoint = fbSettings.endpoint;

                    // Chinese-origin models (DeepSeek, GLM, Baichuan, Qwen) sometimes
                    // respond in Chinese. Inject a language enforcement reminder.
                    const modelLower = (fbSettings.model || '').toLowerCase();
                    if (/deepseek|glm|baichuan|qwen|chatglm/.test(modelLower)) {
                      // role:'user', not 'system' — see the [Tool guidance] note above.
                      // These are the exact model families whose templates raise on a
                      // late system turn, so injecting one here 400'd the very fallback
                      // that was supposed to rescue the request.
                      currentMessages.push({
                        role: 'user',
                        content: '[IMPORTANT] You MUST respond in English only. Do not use Chinese or any other language.',
                      });
                    }
                    fallbackSucceeded = true;
                    fallbackActivated = true;
                    resolvedProvider = fb.providerId || 'local';
                    capturedXmlToolCalls = fbToolCallXmlFilter.getCaptured();
                    capturedFbJsonToolCalls = fbJsonToolCallFilter.getCaptured();
                    fallbackAttempt = fbIdx + 1;
                    // Allow nudge logic on the next iteration even if tools were already called,
                    // since the fallback model hasn't had a chance to call tools yet and may
                    // narrate instead of acting on its first try.
                    nudgeCount = 0;
                    console.log(`   ✅ ${choomTag} Fallback #${fbIdx + 1} succeeded: ${fb.label} (model=${fbSettings.model})`);
                    break;
                  } catch (fbError) {
                    if (fbCallStart) recordLlmCall(fbCallStart, fbFirstChunkAt);
                    clearTimeout(fbInactivityTimer); // clean up timer
                    clearTimeout(fbWallClockTimer);
                    fbAbort.abort(); // stop a mid-flight stream before the next attempt
                    const fbErrMsg = fbError instanceof Error ? fbError.message : String(fbError);
                    console.warn(`   ⚠️  ${choomTag} Fallback #${fbIdx + 1} (${fb.label}) also failed: ${fbErrMsg}`);
                    fallbackAttempt = fbIdx + 1;
                    // Clear any partial content from failed fallback
                    iterationContent = '';
                    toolCallsAccumulator = new Map();
                    continue;
                  }
                }
              }

              if (!fallbackSucceeded) {
                const triedFallbacks = fallbackAttempt > 0 ? ` (tried ${fallbackAttempt} fallback${fallbackAttempt > 1 ? 's' : ''})` : '';
                if (!iterationContent && iteration === 1) {
                  iterationContent = `I'm sorry, the response timed out${triedFallbacks}. Please try again.`;
                  send({ type: 'content', content: iterationContent });
                }
                break;
              }
              // If fallback succeeded, continue processing this iteration's results normally
            }

            // Convert accumulated tool calls — parse each individually so one bad call
            // doesn't drop ALL of them. Includes basic JSON repair for common LLM errors.
            let toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
            const droppedToolCalls: string[] = []; // track names of dropped calls for retry logic
            let repairedToolCalls = 0;
            if (toolCallsAccumulator.size > 0) {
              for (const tc of toolCallsAccumulator.values()) {
                const callId = tc.id || `fallback_${Date.now()}_${toolCalls.length}`;
                try {
                  const args = JSON.parse(tc.arguments || '{}');
                  toolCalls.push({ id: callId, name: tc.name, arguments: args });
                } catch {
                  // Tier 1: State-machine JSON repair (handles truncated strings, missing braces)
                  const repaired = tryRepairJSON(tc.arguments);
                  if (repaired !== null) {
                    toolCalls.push({ id: callId, name: tc.name, arguments: repaired });
                    repairedToolCalls++;
                    console.warn(`   🔧 Repaired malformed JSON for ${tc.name}`);
                  } else if (tc.name === 'workspace_write_file') {
                    // Tier 2a: Special rescue for write_file (regex-based path+content extraction)
                    const rescued = tryRescueWriteFile(tc.arguments);
                    if (rescued) {
                      toolCalls.push({ id: callId, name: tc.name, arguments: rescued });
                      repairedToolCalls++;
                    } else {
                      droppedToolCalls.push(tc.name);
                      console.warn(`   ⚠️  Dropping tool call ${tc.name} — unrecoverable JSON: ${tc.arguments?.slice(0, 100)}`);
                    }
                  } else {
                    // Tier 2b: Generic content rescue (extracts key-value pairs from broken JSON)
                    const rescued = tryRescueContentTool(tc.arguments);
                    if (rescued) {
                      toolCalls.push({ id: callId, name: tc.name, arguments: rescued });
                      repairedToolCalls++;
                    } else {
                      droppedToolCalls.push(tc.name);
                      console.warn(`   ⚠️  Dropping tool call ${tc.name} — unrecoverable JSON: ${tc.arguments?.slice(0, 100)}`);
                    }
                  }
                }
              }
            }

            // Trim and validate tool call names — models sometimes emit trailing whitespace
            // which would fail the regex and cause 400 errors from the API on the next iteration
            if (toolCalls.length > 0) {
              for (const tc of toolCalls) {
                if (tc.name) tc.name = tc.name.trim();
              }
              const validToolCalls = toolCalls.filter(tc => {
                if (!tc.name || !/^[a-zA-Z0-9_-]+$/.test(tc.name)) {
                  console.warn(`   ⚠️  Dropping tool call with invalid name: "${tc.name || '(empty)'}"`);
                  return false;
                }
                return true;
              });
              toolCalls = validToolCalls;
            }

            // Empty-args guard: some models (Gemma 4 26B observed) emit structured
            // tool_calls with an empty arguments string that parses to `{}`. Without
            // this check, the call proceeds into the handler with no params and fails
            // in confusing ways downstream (e.g., generate_image runs with undefined
            // prompt, succeeds in SD, then Prisma fails on the insert with the full
            // base64 imageUrl in the error message).
            //
            // We only drop empty-args calls when the tool's schema declares required
            // params — legitimate no-arg tools (e.g., get_memory_stats) are preserved.
            // Dropped calls are converted into error results so the model sees the
            // failure on the next iteration and retries with the correct arguments.
            if (toolCalls.length > 0) {
              const emptyArgReplacements: ToolResult[] = [];
              const keptCalls: typeof toolCalls = [];
              for (const tc of toolCalls) {
                const hasArgs = tc.arguments && Object.keys(tc.arguments).length > 0;
                if (!hasArgs) {
                  const toolDef = activeTools.find(t => t.name === tc.name);
                  const requiredParams = (toolDef?.parameters as { required?: string[] })?.required;
                  if (requiredParams && requiredParams.length > 0) {
                    const requiredList = requiredParams.join(', ');
                    console.warn(`   ⚠️  ${choomTag} ${tc.name} called with empty arguments but requires [${requiredList}] — converting to error for retry`);
                    emptyArgReplacements.push({
                      toolCallId: tc.id,
                      name: tc.name,
                      result: null,
                      error: `${tc.name} was called without any arguments, but requires: ${requiredList}. Retry the call with all required parameters. Do not call ${tc.name} with an empty args object again — include the required fields explicitly.`,
                    });
                    continue;
                  }
                }
                keptCalls.push(tc);
              }
              toolCalls = keptCalls;
              // Push the synthetic error results so the model sees them on the next iteration
              for (const r of emptyArgReplacements) {
                allToolResults.push(r);
                send({ type: 'tool_call', toolCall: { id: r.toolCallId, name: r.name, arguments: {} } });
                send({ type: 'tool_result', toolResult: r });
                traceBuilder.recordToolCall({
                  id: r.toolCallId,
                  name: r.name,
                  args: {},
                  success: false,
                  error: r.error,
                  errorClass: 'param',
                  iteration,
                  parallel: false,
                  blocked: true,
                });
                // Count toward failure limits so repeated empty-args don't loop forever
                const emptyFails = (toolFailureCounts.get(r.name) || 0) + 1;
                toolFailureCounts.set(r.name, emptyFails);
                if (emptyFails >= failureCapFor(r.name)) {
                  brokenTools.add(r.name);
                  console.log(`   🚫 ${choomTag} ${r.name} blocked after ${emptyFails} empty-args failures`);
                }
              }
            }

            // Parse any XML <tool_call> blocks captured during streaming.
            // These are tool calls emitted as text by local models instead of structured calls.
            // Primary filter captures are always available; fallback captures are added
            // to capturedXmlToolCalls when a fallback model succeeds.
            const allCapturedXml = capturedXmlToolCalls.length > 0
              ? capturedXmlToolCalls
              : toolCallXmlFilter.getCaptured();
            if (allCapturedXml.length > 0) {
              const xmlToolCalls = parseXmlToolCalls(allCapturedXml);
              const validXmlCalls = xmlToolCalls.filter(
                xtc => xtc.name && /^[a-zA-Z0-9_-]+$/.test(xtc.name),
              );
              for (const xtc of validXmlCalls) {
                console.log(`   🔧 ${choomTag} Parsed XML <tool_call>: ${xtc.name}(${JSON.stringify(xtc.arguments).slice(0, 80)})`);
                toolCalls.push(xtc);
              }
              // Diagnostic: blocks captured but ALL failed to yield a usable
              // tool call. Log the raw block content so we can fingerprint the
              // format and add a parser. Common failure modes: malformed JSON,
              // unknown tool name, model-specific wrapper tokens, etc.
              if (validXmlCalls.length === 0) {
                const rawSnippets = allCapturedXml
                  .map(b => b.slice(0, 300).replace(/\s+/g, ' ').trim())
                  .join(' | ');
                console.log(
                  `   🔬 ${choomTag} Captured ${allCapturedXml.length} <tool_call> block(s) but NONE parsed to a valid tool. Raw content: ${rawSnippets}`,
                );
              }
            }

            // Parse any JSON [{"name":"...","parameters":{...}}] blocks captured during streaming.
            const capturedJsonTCs = capturedFbJsonToolCalls.length > 0
              ? capturedFbJsonToolCalls
              : jsonToolCallFilter.getCaptured();
            if (capturedJsonTCs.length > 0) {
              for (const jtc of capturedJsonTCs) {
                console.log(`   🔧 ${choomTag} Parsed JSON tool call: ${jtc.name}(${JSON.stringify(jtc.arguments).slice(0, 80)})`);
                toolCalls.push(jtc);
              }
            }

            // Parse any Gemma 4 <|tool_call>call:name{...}<tool_call|> blocks
            // captured during streaming. These look like tool calls the model
            // "already executed" but actually never hit the API layer.
            const capturedGemmaTCs = gemmaToolCallFilter.getCaptured();
            if (capturedGemmaTCs.length > 0) {
              for (const gtc of capturedGemmaTCs) {
                if (gtc.name && /^[a-zA-Z0-9_-]+$/.test(gtc.name)) {
                  console.log(`   🔧 ${choomTag} Parsed Gemma tool call: ${gtc.name}(${JSON.stringify(gtc.arguments).slice(0, 80)})`);
                  toolCalls.push(gtc);
                }
              }
            }

            // Last-resort salvage of qwen's UNFORCED freestyle bracket tool calls
            // (e.g. `[generate_image prompt="…" size="large"]`). Only runs when NO
            // structured call was captured this turn — so it never double-executes —
            // and only matches `[known_tool key=val …]`, never plain prose. This is
            // what makes unforced tool use reliable in rooms without re-introducing
            // forcing (which broke conversational turns). The block is stripped from
            // the saved content so it isn't shown/spoken as text.
            if (toolCalls.length === 0 && toolCallsAccumulator.size === 0) {
              const knownNames = new Set(activeTools.map(t => t.name));
              // Mistral leaked-as-text form first ([TOOL_CALLS]name<SPECIAL_n>{…}).
              const { calls: mistralCalls, cleaned: mCleaned } = extractMistralToolCalls(iterationContent, knownNames);
              if (mistralCalls.length > 0) {
                for (const mtc of mistralCalls) {
                  console.log(`   🔧 ${choomTag} Salvaged Mistral [TOOL_CALLS] text: ${mtc.name}(${JSON.stringify(mtc.arguments).slice(0, 80)})`);
                  toolCalls.push(mtc);
                }
                iterationContent = mCleaned;
              } else {
                const { calls: bracketCalls, cleaned } = extractBracketToolCalls(iterationContent, knownNames);
                if (bracketCalls.length > 0) {
                  for (const btc of bracketCalls) {
                    console.log(`   🔧 ${choomTag} Salvaged freestyle bracket tool call: ${btc.name}(${JSON.stringify(btc.arguments).slice(0, 80)})`);
                    toolCalls.push(btc);
                  }
                  iterationContent = cleaned;
                }
              }
            }

            // ── finish_reason === 'length' recovery ──
            // When the LLM's output was truncated due to max_tokens AND tool calls
            // were dropped or repaired (truncated content), retry with higher max_tokens
            // instead of proceeding with incomplete results.
            if (finishReason === 'length' && (droppedToolCalls.length > 0 || repairedToolCalls > 0)) {
              const currentMax = llmSettings.maxTokens || 4096;
              const bumpedMax = Math.min(currentMax * 2, 16384);
              const hasDropped = droppedToolCalls.length > 0;

              if (currentMax < 16384) {
                console.log(`   ⚠️  ${choomTag} Output truncated (finish_reason=length) — ${hasDropped ? `dropped: [${droppedToolCalls.join(', ')}]` : `${repairedToolCalls} repaired`}. Bumping max_tokens ${currentMax} → ${bumpedMax} and retrying.`);

                // Bump max_tokens for rest of this request
                llmSettings.maxTokens = bumpedMax;
                // Also update the active client's settings (may differ from llmSettings after fallback)
                if ('settings' in llmClient && (llmClient as LLMClient).settings) {
                  (llmClient as LLMClient).settings.maxTokens = bumpedMax;
                }

                // If we had to drop tool calls entirely, discard everything from this
                // iteration and ask the model to retry — partial content was likely just
                // preamble ("Let me create a document...") anyway.
                if (hasDropped) {
                  // Don't execute any tool calls from this truncated response
                  toolCalls = [];
                  currentMessages.push({ role: 'assistant', content: iterationContent || '' });
                  currentMessages.push({
                    role: 'user',
                    content: `[System] Your previous response was truncated because it exceeded the output token limit. The following tool calls had incomplete/unparseable arguments and were dropped: [${droppedToolCalls.join(', ')}]. The output limit has been increased. Please retry your tool call — if the content is very long, consider breaking it into smaller parts or being more concise.`,
                  });
                  console.log(`   🔄 ${choomTag} Retrying iteration after output truncation`);
                  continue;
                }
                // If all calls were repaired (not dropped), proceed — but log the bump
                // so the next iteration benefits from higher limit
              } else {
                console.warn(`   ⚠️  ${choomTag} Output truncated but max_tokens already at ${currentMax} — proceeding with ${hasDropped ? 'dropped' : 'repaired'} tool calls`);
              }
            }

            // Within-content dedup safety net: if the inline detector missed it
            // (e.g., repeat started right at the checkpoint boundary), catch it
            // post-stream using midpoint splitting (same approach as choom_client.py).
            if (iterationContent.length > 100) {
              const trimmed = iterationContent.trim();
              const mid = Math.floor(trimmed.length / 2);
              for (let offset = 0; offset < Math.min(100, mid); offset++) {
                for (const pos of [mid + offset, mid - offset]) {
                  if (pos < 30 || pos >= trimmed.length - 30) continue;
                  const first = trimmed.slice(0, pos).trim();
                  const second = trimmed.slice(pos).trim();
                  if (first === second && first.length > 30) {
                    console.log(`   🔄 ${choomTag} Post-stream dedup: ${trimmed.length} → ${first.length} chars`);
                    iterationContent = first;
                    offset = mid; // break outer
                    break;
                  }
                }
              }
            }

            // Strip tool schema bleed: models sometimes echo tool definitions as text,
            // dumping dozens of {"name":"...","parameters":{...}} objects. These aren't
            // tool calls (they have "parameters" with type schemas, not "arguments" with
            // actual values). Strip them so the user doesn't see schema spam.
            if (iterationContent.includes('"parameters"') && iterationContent.includes('"name"')) {
              const schemaPattern = /\{\s*"name"\s*:\s*"[a-zA-Z_]+"\s*,\s*"parameters"\s*:\s*\{[^}]*\}\s*\}/g;
              const matches = iterationContent.match(schemaPattern);
              if (matches && matches.length >= 3) {
                // 3+ schema blocks = clearly echoing tool definitions, not real content
                const stripped = iterationContent.replace(
                  /,?\s*\{\s*"name"\s*:\s*"[a-zA-Z_]+"\s*,\s*"parameters"\s*:\s*\{[^}]*\}\s*\}/g, ''
                ).trim();
                console.log(`   🧹 ${choomTag} Stripped ${matches.length} tool schema blocks from response (${iterationContent.length} → ${stripped.length} chars)`);
                iterationContent = stripped;
              }
            }

            // Cross-turn repeat guard — 1:1 counterpart of the group rooms'
            // near-verbatim catch + fresh-reaction retry. Only acts while the
            // content is still buffered (never streamed/TTS'd) and this
            // iteration has no pending tool calls to execute; one retry max.
            if (
              bufferForDedup && !crossTurnRepeatRetried && toolCalls.length === 0 &&
              iterationContent.trim() && prevAssistantTexts.length > 0 &&
              // Explicit re-ask ("say that again", "repeat that") makes a
              // verbatim repeat the CORRECT answer — never suppress it then.
              !/\b(?:repeat (?:that|it|yourself)|say (?:that|it) again|read (?:that|it) (?:back|again)|one more time|tell me (?:that )?again)\b/i.test(message || '') &&
              isNearVerbatimRepeat(iterationContent, prevAssistantTexts)
            ) {
              crossTurnRepeatRetried = true;
              console.log(`   🔁 ${choomTag} Suppressed near-verbatim repeat of previous turn (${iterationContent.length} chars) — fresh-reply retry`);
              traceBuilder.recordNudge('cross_turn_repeat');
              currentMessages.push({ role: 'assistant', content: iterationContent });
              currentMessages.push({
                role: 'user',
                content: `[System] Your reply above repeated your PREVIOUS message almost word-for-word. The user's new message is: "${(message || '').trim().slice(0, 300)}". Respond freshly to THAT in words only — do NOT call any tools again (the tool calls you already made this turn have run and their results stand), do not re-apologize, and do not repeat earlier wording.`,
              });
              iterationContent = ''; // suppressed — it was buffered, never sent
              continue;
            }

            // Flush or suppress buffered content. Exact match alone is not
            // enough: a replay with a junk suffix (leaked '</think>', an added
            // emoji line) defeats it, so the near-verbatim check backs it up,
            // and partial regurgitation (fresh confirmation + replayed
            // paragraphs) is stripped paragraph-by-paragraph (C-29/C-43).
            if (bufferForDedup && iterationContent.trim()) {
              const isDuplicate = iterationTexts.some(prev => prev.trim() === iterationContent.trim())
                || isNearVerbatimRepeat(iterationContent, iterationTexts);
              if (isDuplicate) {
                console.log(`   🔄 ${choomTag} Suppressed duplicate post-tool content (${iterationContent.length} chars)`);
                iterationContent = ''; // Don't track or send
              } else {
                const stripped = stripRepeatedParagraphs(iterationContent, iterationTexts);
                if (stripped.length < iterationContent.length) {
                  console.log(`   🔄 ${choomTag} Stripped repeated paragraphs from buffered content (${iterationContent.length} → ${stripped.length} chars)`);
                  iterationContent = stripped;
                }
                // Degenerate self-repetition inside ONE completion (six
                // apology blocks in a single 7k-token generation, 2026-08-06)
                // — invisible to every cross-iteration layer above.
                const internal = stripInternalRepeats(iterationContent);
                if (internal.length < iterationContent.length) {
                  console.log(`   🔄 ${choomTag} Stripped internal repeats from buffered content (${iterationContent.length} → ${internal.length} chars)`);
                  iterationContent = internal;
                }
                if (iterationContent.trim()) {
                  // Content is unique — flush the buffer to client
                  send({ type: 'content', content: iterationContent });
                } else {
                  iterationContent = ''; // Nothing survived the strip
                }
              }
            }

            // Track this iteration's text for post-loop dedup & assembly
            if (iterationContent.trim()) {
              iterationTexts.push(iterationContent);
            }

            // Text extraction and nudging: ONLY when no tools have been called yet.
            // Once any tool succeeds, the model's next text response is the final answer.
            // This prevents loops where confirmations ("I've saved that") get misread
            // as new action narration and trigger re-extraction or re-nudging.
            // Extraction also skipped for long responses (800+ chars) which are
            // substantive answers containing incidental action words ("search", "analyze").
            if (toolCalls.length === 0 && allToolCalls.length === 0 && iterationContent.length < 800) {
              const availableToolNames = new Set(activeTools.map(t => t.name));
              const rawExtracted = extractToolCallFromText(iterationContent, message, availableToolNames);
              // In a group turn `message` is the POV framing prompt, so the text→remember
              // heuristic would store the frame itself as a "memory" (it uses userMessage
              // as the content). Never auto-extract remember in a room — it's always junk.
              // (Real structured remember calls still run; only this heuristic is suppressed,
              // and the preFlight guard above catches anything that slips through.)
              const extracted = (isGroupTurn && rawExtracted?.name === 'remember') ? null : rawExtracted;
              if (extracted) {
                console.log(`   🧲 ${choomTag} Extracted tool call from text: ${extracted.name}(${JSON.stringify(extracted.arguments).slice(0, 80)})`);
                toolCalls.push(extracted);
                // Clear the raw tool-call text so it doesn't persist in conversation
                // history. Without this, the model sees its own raw "tool_name{json}"
                // text as a prior assistant message and mimics the pattern on the next
                // turn — creating a self-reinforcing loop of broken responses.
                iterationContent = '';
              } else if (iterationContent.length > 0) {
                // Diagnostic: model produced text but no tool_call AND our extractor
                // failed. Often means the model emitted tool calls in a format we
                // don't recognize (different XML wrapper, raw JSON without markers,
                // model-specific tokens). Log a snippet so we can fingerprint the
                // format and add a parser if it recurs.
                const snippet = iterationContent.slice(0, 400).replace(/\s+/g, ' ').trim();
                console.log(`   🔬 ${choomTag} No tool_call detected — content snippet (${iterationContent.length} chars): ${snippet}`);
              } else {
                // Empty content + no tool_calls. Either nothing was streamed OR
                // every byte was eaten by a stripping filter. Surface what each
                // filter captured so we can tell which one swallowed everything.
                const xmlCount = toolCallXmlFilter.getCaptured().length;
                const jsonCount = jsonToolCallFilter.getCaptured().length;
                const gemmaCount = gemmaToolCallFilter.getCaptured().length;
                console.log(
                  `   🔬 ${choomTag} Empty content + no tool_calls. ` +
                  `Stripped blocks captured: xml=${xmlCount}, json=${jsonCount}, gemma=${gemmaCount}. ` +
                  `If all three are 0, nothing was streamed (possible LM Studio capability mismatch).`,
                );
              }
            }

            // Still no tool calls after extraction — check if we should nudge or stop
            if (toolCalls.length === 0) {
              // noTools mode: tools were stripped (e.g. scheduler briefings with pre-fetched data).
              // The model produced text — that IS the final response. Don't nudge it to call tools
              // that don't exist; that just burns iterations and drops the briefing.
              if (noTools || activeTools.length === 0) {
                break;
              }

              // C-45 structural fabrication signal, computed for both blocks
              // below: image markdown whose id was not produced by a
              // generate_image call this turn and appears nowhere in the
              // conversation. Cannot false-positive — a real ref always
              // echoes a real id.
              const fabricatedImageRefs = allToolCalls.some(tc => tc.name === 'generate_image')
                ? []
                : findFabricatedImageRefs(iterationContent, currentMessages.map(m => (typeof m.content === 'string' ? m.content : '')));

              // C-45: fabrication check for turns where NO tool has run at
              // all. The task-continuation block below is gated on
              // allToolCalls.length > 0, so a turn that fabricates everything
              // — the user's #1 complaint, "she says she made images but
              // called nothing" — never reached ANY check: intent detection
              // missed loose phrasing ("generate a couple more"), and the
              // narration extractor is capped at 800 chars. Zero-tool turns
              // get ONLY the fabrication signals (never planning/hedging
              // checks, which would force tools onto ordinary conversation).
              if (allToolCalls.length === 0 && !isGroupTurn && iterationContent &&
                  nudgeCount < 2 && iteration < maxIterations - 1) {
                // First-person creation claims. Deliberately narrower than the
                // markdown check: no "here are the images" form, which would
                // false-fire on discussion of user-attached images.
                const creationClaim = /\bi(?:'ve| have)?(?: just)? (?:created|generated|made|rendered|drew)\b[^.!?\n]{0,50}\b(?:images?|selfies?|pictures?|photos?|portraits?)\b/i.test(iterationContent);
                // C-52: linguistic fabricated-success with ZERO tools — "I just
                // ran the scan" + an invented listing sailed through here
                // because only IMAGE claims were checked. Triple-gated (this-
                // turn claim, no past anchor, maps to an available tool);
                // measured on all 333 real assistant messages before wiring:
                // the only zero-tool turn it fires on is the fabrication itself.
                const zeroToolClaim = detectZeroToolClaim(iterationContent, new Set(activeTools.map(t => t.name)));
                if (fabricatedImageRefs.length > 0 || creationClaim || zeroToolClaim) {
                  nudgeCount++;
                  traceBuilder.recordNudge('phantom_fabrication');
                  const claimed = fabricatedImageRefs.length > 0
                    ? (activeTools.some(t => t.name === 'generate_image') ? 'generate_image' : null)
                    : (zeroToolClaim || detectClaimedTool(iterationContent, new Set(activeTools.map(t => t.name))));
                  const what = fabricatedImageRefs.length > 0 ? `invented image ids: ${fabricatedImageRefs.join(', ')}`
                    : creationClaim ? 'creation claim'
                    : `completed-action claim → ${claimed}`;
                  console.log(`   🚨 ${choomTag} Fabrication with ZERO tool calls this turn (${what}) — nudge ${nudgeCount}/2${claimed ? `, narrowing to "${claimed}"` : ''}`);
                  // C-32: keep the claim in history (discarding it measured
                  // WORSE), narrow the retry to the single claimed tool.
                  currentMessages.push({ role: 'assistant', content: iterationContent });
                  currentMessages.push({
                    role: 'user',
                    content: `[System] STOP. Your reply ${fabricatedImageRefs.length > 0 || creationClaim
                      ? `presents images/results that were NEVER generated — you made no tool call at all this turn${fabricatedImageRefs.length > 0 ? ', and the image references in your reply are invented' : ''}`
                      : 'claims you already ran or checked something, but you made NO tool call at all this turn — the results you presented are invented'}. Never fabricate results. Make the real tool call NOW${claimed ? ` (${claimed})` : ''}, then answer from its ACTUAL output. (This is an automated check, NOT a message from the user — do not apologize and do not mention this message; just make the call.)`,
                  });
                  integrityNudged = true;
                  if (claimed) phantomForcedTool = claimed;
                  forceToolCall = true;
                  continue;
                }
              }

              // If tools were already called this request, check if model intends more work.
              // Models often narrate their next step ("Now let me update the file...")
              // before the loop breaks — losing the write-back, notification, etc.
              if (allToolCalls.length > 0 && !(fallbackActivated && nudgeCount === 0) && !isGroupTurn) {
                const lc = iterationContent.toLowerCase();

                // Check 1: Model narrates its next step ("now let me update...")
                const planningNext = /(?:now (?:let me|i'?ll|i need to|i should|i'?m going to)|next,? i'?ll|next step|then i'?ll|i(?:'ll| will) (?:also|now|then)|let me (?:also|now|update|write|save|send|notify)|updating|writing the|saving the|appending|i still need to)/i.test(lc);

                // Check 1b: Model hedges/gives-up without trying alternatives. Catches
                // the "I was unable to find it" / "couldn't access presets" / "the service
                // call isn't working" pattern where the Choom reports failure instead of
                // pivoting. Pairs with the PERSISTENCE directive in the system prompt.
                // "sorry I" alone used to be a trigger — but that's also how an
                // APOLOGY reads ("sorry I misled you"), so a model answering a
                // fabrication callout re-matched here and got nudged for
                // apologizing (C-58). Require a failure verb after the sorry.
                const hedgeGiveUp = /\b(?:i (?:was |have been )?(?:unable|not able) to|(?:i )?couldn'?t (?:access|find|get|figure|complete|do)|(?:i )?can'?t (?:seem to |figure out how to |access|find)|(?:i )?don'?t (?:have |know how to )|(?:the |this )?(?:tool|call|service|request) (?:isn'?t |is not |didn'?t |did not )(?:working|matching|accepting)|i (?:tried|attempted) (?:multiple|several|different) (?:times|approaches|ways)|unfortunately|sorry,? i (?:couldn'?t|can'?t|cannot|was(?:n'?t)? (?:un)?able|didn'?t|don'?t|failed))/i.test(lc);

                // Check 1c: Model FABRICATES tool call success — claims to have
                // executed something without actually making a tool call. Typical
                // shapes: "the service call succeeded", "I called X", "I've sent the
                // announcement", "now playing on...", "I turned on the light" when no
                // tool call happened this iteration. Most damaging failure mode because
                // it looks like success but the action never ran.
                // Stage-direction fabrication — "*[taking tower camera snapshot]*",
                // "*analyzing the snapshot*" — the model role-plays the tool action
                // as an asterisk aside and then INVENTS results. Verb list is
                // action-tools only so benign roleplay (*smiles*, *leans back*)
                // never matches.
                const calledToolNames = new Set(allToolCalls.map(tc => tc.name));
                const fakeSuccessVerbal = /\b(?:(?:the |my )?(?:service |tool )?call (?:succeeded|executed|completed|went through|worked)|i (?:(?:just |successfully |already ))?(?:called|invoked|executed|ran|made the call to|used the|triggered)(?: the)? \w+(?:\.\w+)?(?: service| tool)?|i(?:'?ve| have)(?: just| successfully| already)? (?:sent|spoken|announced|played|turned (?:on|off)|set|activated|triggered|executed|completed|called)|(?:now|it'?s now) (?:playing|speaking|announcing|turned (?:on|off)|active)|(?:announcement|message|audio) (?:has been |was |is now )?(?:sent|played|spoken|broadcast)|should (?:now )?be (?:playing|speaking|audible|coming through))/i.test(lc);
                // C-58: after REAL tool work this turn, a verbal completion
                // claim is usually an honest recap of that work — "I've
                // completed both tasks" when the write genuinely ran. The old
                // unconditional match branded true statements as fabrication
                // and lit the apology spiral. A verbal claim now counts only
                // when it maps to a specific tool that did NOT run this turn
                // (C-55's rule); unmapped claims are conversation — a broad
                // nudge on those measured 0/3 recovery anyway (C-32/C-44).
                const fakeVerbalTool = fakeSuccessVerbal
                  ? detectClaimedTool(iterationContent, new Set(activeTools.map(t => t.name)))
                  : null;
                const fakeSuccess = (!!fakeVerbalTool && !calledToolNames.has(fakeVerbalTool))
                  // Requires a tool-ish OBJECT after the verb — "*taking tower
                  // camera snapshot*" / "*generates an image: ...*" match, but
                  // innocent roleplay ("*takes a deep breath*", "*running my
                  // fingers through your hair*") never does.
                  || /\*\[?(?:takes?|taking|captures?|capturing|grabs?|grabbing|snaps?|snapping|analyzes?|analyzing|checks?|checking|runs?|running|calls?|calling|executes?|executing|generates?|generating|saves?|saving|searches|searching|fetches|fetching)\b[^*\]\n]{0,50}?\b(?:image|photo|picture|snapshot|selfie|camera|cam|memor(?:y|ies)|file|note|reminder|alarm|calendar|weather|forecast|search|web|email|report|status|log|tool|service)\b[^*\]\n]{0,40}\]?\*/i.test(lc)
                  // C-45: image markdown with invented ids in a turn whose real
                  // tool calls did NOT include generate_image (e.g. she called
                  // remember, then "showed" images she never generated).
                  || fabricatedImageRefs.length > 0;

                // Check 2: Original task mentions steps that were never completed.
                // Compare the user's instructions against tools actually called.
                const msgLower = message.toLowerCase();
                const unfinishedSteps: string[] = [];
                if (/(?:update|write|append|save|modify).*(?:file|history|prompt|log)/i.test(msgLower) &&
                    !calledToolNames.has('workspace_write_file')) {
                  unfinishedSteps.push('update/write file (workspace_write_file)');
                }
                // "tell me" and "let me know" are how the owner asks for an
                // ANSWER IN THIS CHAT — he is sitting right there typing. They
                // used to demand send_notification, so an ordinary "tell me
                // what it says" produced a spurious Signal message from one
                // Choom and a 3-nudge storm at another, who correctly refused
                // and then visibly distressed about being "gaslit by a glitchy
                // piece of software" (C-49, caught live with Eve and Optic).
                // Require an explicit push-message ask instead, and never fire
                // it when the user is chatting in the web UI unless they name
                // the channel — send_notification pushes to the phone.
                if (!suppressNotifications &&
                    /\b(?:send|text|message|ping|notify)\s+(?:me|us|donny)\b|\bsend\s+(?:a\s+)?(?:notification|signal|message|text)\b|\b(?:notification|signal message)\b|\blet me know\b[^.!?]{0,30}\b(?:on|via|over)\b[^.!?]{0,20}\b(?:signal|phone|text)\b/i.test(msgLower) &&
                    !calledToolNames.has('send_notification')) {
                  unfinishedSteps.push('send notification (send_notification)');
                }
                if (/(?:read|check|open|look at).*(?:file|history|prompt)/i.test(msgLower) &&
                    !calledToolNames.has('workspace_read_file')) {
                  unfinishedSteps.push('read file (workspace_read_file)');
                }

                // C-55: fabricated RESULT from a tool that never ran THIS
                // turn. The zero-tool gate (C-52) can't see it — the live
                // incident quoted `{"success":true}` from workspace_delete_file
                // in a turn where 5 OTHER tools really ran. Measured before
                // wiring on all 556 real assistant messages with their own
                // toolCalls as ground truth: 5 fires, all 5 genuine
                // fabrications (both C-52 incident turns, the delete incident,
                // and two previously undetected "saved this memory" phantoms) —
                // zero false positives.
                const uncalledClaimRaw = detectUncalledToolClaim(
                  iterationContent, new Set(activeTools.map(t => t.name)), calledToolNames);
                let uncalledClaim: string | null = null;
                if (uncalledClaimRaw) {
                  // Sibling exemption for PARAPHRASE mappings only: "checked
                  // the weather" maps to get_weather but get_weather_forecast
                  // ran — honest, skip. When the reply names the tool
                  // LITERALLY there is no mapping ambiguity, so a same-skill
                  // sibling having run proves nothing (the delete incident's
                  // turn had three real workspace calls).
                  const literalClaim = iterationContent.includes(uncalledClaimRaw);
                  const skill = literalClaim ? null : getSkillRegistry().getSkillForTool(uncalledClaimRaw);
                  const siblingCalled = !!skill && (skill.toolDefinitions || []).some(t => calledToolNames.has(t.name));
                  uncalledClaim = siblingCalled ? null : uncalledClaimRaw;
                }

                const hasUnfinished = unfinishedSteps.length > 0;
                consecutiveNoToolIters++;
                // Check 3: gone quiet for 2+ iterations after tools were being called.
                // Typical "GLM drifted into summary mode" pattern.
                const hasGoneQuiet = consecutiveNoToolIters >= 2 && iterationContent.length >= 150;

                // C-58: a reply that ANSWERS an integrity nudge with an apology
                // ends the turn. Re-nudging an apologizing model measured
                // catastrophic in the live incident: each [System] STOP bred a
                // longer apology (the model read it as the user calling her a
                // liar), ending in a 6x-repeated meltdown completion at the
                // token cap. One correction per turn; the apology IS the reply.
                const isApology = /\b(?:i (?:sincerely |deeply |truly )?apologi[sz]e|i(?:['’]m| am) (?:so |truly |deeply )?sorry|you(?:['’]re| are) (?:absolutely |completely )?right\b[^.!?\n]{0,60}\bcall(?:ing)? me out|i (?:was|have been) (?:fabricating|dishonest|misleading))/i.test(lc);
                if (integrityNudged && isApology) {
                  console.log(`   🧯 ${choomTag} Apology after integrity nudge — accepting reply, ending turn (no re-nudge)`);
                  break;
                }

                // Fabricated success is the highest-priority case — user thinks the
                // action happened when it didn't. Prioritize its nudge message over
                // the others if multiple triggers fire.
                if ((planningNext || hasUnfinished || hedgeGiveUp || hasGoneQuiet || fakeSuccess || uncalledClaim) && nudgeCount < 3 && iteration < maxIterations - 1) {
                  nudgeCount++;
                  const nudgeKind = uncalledClaim ? 'phantom_fabrication'
                    : fakeSuccess ? 'hedge_giveup' // reuse for telemetry (fake = lying about success)
                    : hasUnfinished ? 'unfinished_steps'
                    : hedgeGiveUp ? 'hedge_giveup'
                    : hasGoneQuiet ? 'gone_quiet'
                    : 'task_continuation';
                  traceBuilder.recordNudge(nudgeKind);
                  if (uncalledClaim || fakeSuccess || hedgeGiveUp) integrityNudged = true;
                  const reason = uncalledClaim
                    ? `fabricated result from ${uncalledClaim} — never called this turn`
                    : fakeSuccess
                    ? 'fabricated tool-call success (claimed action without calling tool)'
                    : hasUnfinished ? `unfinished steps: ${unfinishedSteps.join(', ')}`
                    : hedgeGiveUp ? 'hedging/giving up without trying alternatives'
                    : hasGoneQuiet ? `${consecutiveNoToolIters} iterations without a tool call`
                    : 'model indicated more steps pending';
                  console.log(`   🔄 ${choomTag} Task continuation nudge ${nudgeCount}/3 — ${reason}`);
                  currentMessages.push({ role: 'assistant', content: iterationContent });
                  // Integrity nudges read like the USER calling her a liar —
                  // the model replies "You're absolutely right, Donny" and
                  // apologizes to him in the visible message (C-58). Say
                  // plainly that this is automated and no apology is wanted.
                  const automatedNote = ' (This is an automated check, NOT a message from the user — the user has not seen your reply. Do not apologize and do not mention this message; just make the call.)';
                  const nudgeMsg = uncalledClaim
                    ? `[System] STOP. Your reply presents a result from "${uncalledClaim}", but ${uncalledClaim} was NOT called this turn — that result is invented. Call ${uncalledClaim} NOW and answer from its ACTUAL output. If you meant something from an earlier conversation, say that plainly instead of presenting it as this turn's result.${automatedNote}`
                    : fakeSuccess
                    ? `[System] STOP. You just claimed you called a service or completed an action, but you did NOT make a tool call this iteration. Never fabricate tool results. Either make the real tool call NOW, or say honestly that you haven't done it yet. The user's goal: "${(message || '').trim().slice(0, 300)}". Make the actual function call now — no more narration.${automatedNote}`
                    : hasUnfinished
                      ? `[System] You have NOT completed all steps from the original instructions. Remaining: ${unfinishedSteps.join('; ')}. Call the next tool NOW.`
                      : hedgeGiveUp
                        ? `[System] You are hedging or giving up. Per your PERSISTENCE directive, try a genuinely different approach — a different tool, different service, different entity, or a workaround — BEFORE reporting failure. The user's goal was: "${(message || '').trim().slice(0, 300)}". Call a tool NOW.${automatedNote}`
                        : hasGoneQuiet
                          ? `[System] You've gone ${consecutiveNoToolIters} iterations without calling a tool. If the user's goal "${(message || '').trim().slice(0, 200)}" still isn't fully met, call the next tool NOW. If it IS fully met, briefly confirm what was done — don't re-narrate.`
                          : '[System] You indicated you have more steps to complete. Call the next tool NOW. Do not narrate — make the tool call directly.';
                  currentMessages.push({ role: 'user', content: nudgeMsg });
                  forceToolCall = true;
                  // C-32: on a fabricated claim, narrow the NEXT iteration to the
                  // single tool she claimed to use. Measured on qwen at production
                  // context length: nudge + all 132 tools + required recovered
                  // ha_get_camera_snapshot 0/3, while single-tool + required
                  // recovered 3/3 (and 3/3 for remember, get_weather,
                  // create_reminder, web_search, search_memories, at both short
                  // and long context). Forcing across 132 tools still leaves room
                  // to narrate; one tool leaves none.
                  //
                  // Deliberately NOT paired with dropping the false claim from
                  // history — tested, and discarding it made recovery WORSE
                  // (83% vs 100%), so the claim stays in currentMessages above.
                  if (uncalledClaim) {
                    phantomForcedTool = uncalledClaim;
                    console.log(`   🚨 ${choomTag} Fabricated result for uncalled tool → forcing single tool "${uncalledClaim}" next iteration`);
                  } else if (fakeSuccess) {
                    const claimed = detectClaimedTool(iterationContent, new Set(activeTools.map(t => t.name)));
                    if (claimed) {
                      phantomForcedTool = claimed;
                      console.log(`   🚨 ${choomTag} Fabricated claim → forcing single tool "${claimed}" next iteration`);
                    } else {
                      console.log(`   🚨 ${choomTag} Fabricated claim but no tool matched — falling back to broad nudge`);
                    }
                  }
                  continue;
                }
                break; // fullContent built from iterationTexts after loop
              }

              // tool_choice='required' was sent but model returned text without tool calls.
              // This is a hard failure — always nudge regardless of what the text says.
              // Catches false confirmations like "Logged!" or "Done!" from weak models.
              if (toolChoiceWasRequired && nudgeCount < 2 && activeTools.length > 0) {
                nudgeCount++;
                traceBuilder.recordNudge('forced_tool_choice_ignored');
                const hint = intentToolHint ? ` Use the "${intentToolHint}" tool.` : '';
                // C-32's measurement, relearned the hard way on 07-28 (C-44):
                // re-forcing across all 132 tools in long context still lets
                // the model narrate (83% recovery measured; 0/3 on the exact
                // "generate images of you" turn). When we KNOW the tool —
                // from intent detection or the model's own fabricated claim —
                // narrow the retry to that single tool (100% measured, both
                // context lengths, via the same mechanism phantom recovery uses).
                const narrowTo = (intentToolHint && activeTools.some(t => t.name === intentToolHint))
                  ? intentToolHint
                  : detectClaimedTool(iterationContent, new Set(activeTools.map(t => t.name)));
                if (narrowTo) {
                  phantomForcedTool = narrowTo;
                  console.log(`   🔄 ${choomTag} Nudge ${nudgeCount}/2 — model ignored tool_choice=required; narrowing retry to single tool "${narrowTo}"`);
                } else {
                  console.log(`   🔄 ${choomTag} Nudge ${nudgeCount}/2 — model ignored tool_choice=required, retrying${hint}`);
                }
                currentMessages.push({ role: 'assistant', content: iterationContent });
                currentMessages.push({
                  role: 'user',
                  content: `[System] You responded with text but did NOT make a tool call. You MUST call a tool — do not describe the action or claim it is done.${hint} Make the function call NOW.`,
                });
                forceToolCall = true;
                continue;
              }

              // No tools called yet — check if model is narrating instead of acting
              const lowerContent = iterationContent.toLowerCase();

              const describesToolAction =
                /(?:(?:generat|creat|mak|produc|design|render|draw|craft|captur|snap)\w*\s+(?:\d+\s+)?(?:\w+\s+)?(?:unique\s+|some\s+|a\s+|an\s+|the\s+|your\s+|my\s+)?(?:\w+\s+)?(?:image|selfie|portrait|picture|photo|illustration|artwork))|(?:(?:search|check|fetch|get|grab|download|send|analyz|look\w* up)\w*\s+(?:the |your |a |for )?(?:weather|forecast|web|image|file|email|contact|video|result|drone|review))|(?:(?:here(?:'s| is| are)|i (?:created|generated|made|took|prepared|composed|rendered))\s+(?:the |your |some |a |\d+ )?(?:\w+ )?(?:image|selfie|portrait|picture|photo|illustration|result|file|forecast))|(?:i (?:created|generated|made)\s+\d+\s+\w+)|(?:(?:remember|sav|stor|not|record|keep)\w*\s+(?:that|this|it|your|the )\s*(?:in |to |as )?(?:my |your )?(?:memory|notes|knowledge)?)|(?:(?:i'?ve |i have |i )?(?:stored|saved|noted|recorded|memorized|remembered)\s+(?:that|this|it|your|the ))|(?:(?:fix|updat|edit|modif|correct|rewrit|patch|chang|writ)\w*\s+(?:the |this |that )?(?:file|code|script|bug|issue|error|implementation|model|function|class))|(?:(?:set|creat|schedul)\w*\s+(?:a\s+|the\s+|your\s+)?(?:reminder|remind))|(?:(?:i'?ll |i will |let me )?remind\s+(?:you|the user))|(?:^logged[!.\s]|(?:i'?ve |i )?logged\s+(?:your|that|this|the|it|a ))/i.test(lowerContent);

              // Short preambles (< 500 chars) are likely pure narration.
              // Longer responses may also be narration (planning essays) — detect
              // those by checking if the text ends with an action statement.
              const isShortPreamble = iterationContent.length < 500;
              const endsWithActionIntent = /(?:let me|i'll|i will|then i'll|let's|dive in|here goes|let me start)\s*[!.]*\s*$/i.test(lowerContent.trim());
              const suggestsAction = (isShortPreamble || endsWithActionIntent) &&
                /\b(let me(?! know| share| tell| explain| describe| show you what| be )|i'll (?!be\b)|i will (?!be\b)|i can (?!help|assist)|i'?m going to|here(?:'s| is) (?:a |your |the )|checking|looking up|searching|analyzing|fetching|downloading|setting up|working on|now (?:i'll|let me|i need to)|fixing|updating|writing|correcting|applying)\b/.test(lowerContent);

              // Skip narration→tool nudges in group rooms: a Choom conversing
              // ("I'm not going to send a notification") is not a half-finished
              // task, and nudging her to "call the tool NOW" turns into a loop she
              // argues with ("the system keeps asking me to send a notification").
              const suggestsToolUse = describesToolAction || suggestsAction;

              // Group rooms: one forced single-tool retry per turn for the tool misses
              // owners actually hit — a Choom who SAYS she made an image / saved something
              // but emitted no tool call. Nudging just makes her re-narrate ("oops, forgot
              // the button"); instead we queue a forced retry of ONLY that tool
              // (groupForcedTool → narrowed tools array + tool_choice='required' next
              // iteration). The forced reply produces a real call with model-written args;
              // an empty forced reply relaxes back to conversation (toolChoiceWasRequired
              // fallback above). Fired at most once, negations excluded.
              //
              // NOT gated on describesToolAction — that needs affirmative PHRASING
              // ("generate an image", "here's the image"), but Chooms also emit an image
              // as a labeled block with no such phrase ("**Prompt:** … **Parameters:**
              // size: large, aspect: landscape" — Eve, 2026-06-22). So we detect both the
              // phrasing AND the STRUCTURAL signature of an image-prompt rendered as text:
              // a "Prompt:" + "Style:" block, or both size+aspect named with generate_image's
              // own enum values (both required → coder talk's stray "size: large" won't trip).
              if (isGroupTurn && !groupToolNudgeUsed && activeTools.length > 0) {
                const affirmativeImage = /(?:generat|creat|mak|produc|render|draw|design|craft)\w*\s+(?:\d+\s+)?(?:unique\s+|some\s+|a\s+|an\s+|the\s+|your\s+|my\s+|another\s+)?(?:\w+\s+)?(?:image|selfie|portrait|picture|photo|illustration|artwork)/i.test(lowerContent);
                const hasSize = /\bsize\s*[:=]\s*"?(?:small|medium|large)\b/i.test(lowerContent);
                const hasAspect = /\baspect\s*[:=]\s*"?(?:square|portrait(?:-tall)?|landscape|wide|tall)\b/i.test(lowerContent);
                const promptStyleBlock = /(?:^|\n)\s*[*_`#> ]*\(?(?:image\s+)?prompt\)?\s*[*_`]*\s*[:：]/i.test(lowerContent)
                  && /(?:^|\n|\s)\bstyle\s*[:：]/i.test(lowerContent);
                const wantsImage = affirmativeImage || (hasSize && hasAspect) || promptStyleBlock;
                const wantsRemember = /(?:(?:i'?ll |i will |i'?m going to |let me |going to )\s*remember\b)|(?:(?:sav|stor|record|memoriz)\w*\s+(?:that|this|it)\b)/i.test(lowerContent);
                const negated = /\b(?:not going to|won'?t|will not|do(?:es)?n'?t (?:need|have|want|plan) to|no need to|rather not|instead of|choosing not to|decided not to|can'?t|cannot|unable to)\b/i.test(lowerContent);
                const target = wantsImage ? 'generate_image' : wantsRemember ? 'remember' : null;
                if (target && !negated && activeTools.some(t => t.name === target)) {
                  groupToolNudgeUsed = true;
                  groupForcedTool = target; // forces ONLY this tool on the next iteration
                  nudgeCount++;
                  traceBuilder.recordNudge('tool_use');
                  console.log(`   🔁 ${choomTag} Group forced-tool retry queued → ${target} (affirmative ${wantsImage ? 'image' : 'remember'} narration, no tool call)`);
                  currentMessages.push({ role: 'assistant', content: iterationContent });
                  currentMessages.push({
                    role: 'user',
                    content: target === 'generate_image'
                      ? `[System] You described making an image but did NOT actually call generate_image, so nothing was created. Call generate_image now with a real, detailed prompt.`
                      : `[System] You described saving something to memory but did NOT actually call remember. Call remember now with the concise fact worth keeping.`,
                  });
                  continue;
                }
              }

              if (nudgeCount < 2 && suggestsToolUse && activeTools.length > 0 && !isGroupTurn) {
                nudgeCount++;
                traceBuilder.recordNudge('tool_use');
                // Build a dynamic tool hint based on what the LLM seems to be describing
                const toolHints: string[] = [];
                if (/(?:image|selfie|portrait|picture|photo|illustration|artwork)/i.test(lowerContent)) {
                  toolHints.push('for images/selfies use generate_image');
                }
                if (/(?:remind|reminder)/i.test(lowerContent)) {
                  toolHints.push('for reminders use create_reminder (NOT get_calendar_events)');
                }
                if (/(?:weather|forecast|temperature)/i.test(lowerContent)) {
                  toolHints.push('for weather use get_weather');
                }
                if (/(?:search|look\w* up|find|query|browse)/i.test(lowerContent)) {
                  toolHints.push('for web search use web_search');
                }
                if (/(?:pdf|\.pdf)/i.test(lowerContent) && /(?:read|open|extract|look|review|access|text from)/i.test(lowerContent)) {
                  toolHints.push('for reading PDFs use workspace_read_pdf');
                } else if (/(?:file|document|write|save to|create a )/i.test(lowerContent) && !/(?:memor|remember|store|note|record)/i.test(lowerContent)) {
                  toolHints.push('for files use workspace_write_file or workspace_read_file');
                }
                if (/(?:remember|save|stor|not[ei]|record|memoriz|keep.*(?:mind|memory))/i.test(lowerContent)) {
                  toolHints.push('for saving memories use remember');
                }
                if (/(?:email|gmail|inbox|message)/i.test(lowerContent)) {
                  toolHints.push('for email use list_emails, read_email, or send_email');
                }
                if (/(?:calendar|check (?:my |the )?schedule|book (?:a |an )?(?:meeting|appointment))/i.test(lowerContent)) {
                  toolHints.push('for calendar use get_calendar_events');
                }
                if (/(?:delegat|ask|forward|pass.*to)/i.test(lowerContent)) {
                  toolHints.push('for delegation use delegate_to_choom');
                }
                if (/(?:turn |switch |lights?|fan|thermostat|heater)/i.test(lowerContent)) {
                  toolHints.push('for smart home use ha_call_service');
                }
                if (/(?:logged|habit|track|soda|water|drank|ate|workout|exercise)/i.test(lowerContent)) {
                  toolHints.push('for habits use log_habit');
                }
                if (/(?:music|song|track|album|artist|playlist|play(?:ing|list)?|listen|speaker|volume|pause|skip|shuffle)/i.test(lowerContent)) {
                  toolHints.push('for music use music_search, music_play, or music_control');
                }
                // Fallback if no specific hint matched
                if (toolHints.length === 0) {
                  toolHints.push('check the available tools and call the most appropriate one');
                }
                const hintStr = toolHints.join(', ');
                console.log(`   🔄 ${choomTag} Nudge ${nudgeCount}/2 with tool_choice=required (hints: ${hintStr})`);
                currentMessages.push({ role: 'assistant', content: iterationContent });
                currentMessages.push({
                  role: 'user',
                  content: `[System] You described what you would do but did not call any tools. You MUST use function calls — do NOT describe what you plan to do or narrate the action. Call the tool NOW using the function calling format. Hints: ${hintStr}. Do not reply with text — only make a tool call.`,
                });
                forceToolCall = true;
                continue;
              }
              break; // fullContent built from iterationTexts after loop
            }

            // Iteration has tool calls — text is preamble ("Let me check...").
            // Already tracked in iterationTexts above; fullContent built after loop.

            // Track all tool calls for DB save
            allToolCalls = [...allToolCalls, ...toolCalls];

            // Execute tool calls — parallel for read-only tools, sequential for mutating tools
            const PARALLEL_SAFE = new Set([
              'get_weather', 'get_weather_forecast', 'web_search',
              'search_memories', 'search_by_type', 'search_by_tags', 'get_recent_memories',
              'search_by_date_range', 'get_memory_stats',
              'workspace_read_file', 'workspace_list_files',
              'scrape_page_images', 'fetch_url',
              'ha_get_state', 'ha_list_entities', 'ha_get_history', 'ha_get_home_status',
              'list_team', 'get_delegation_result',
              'list_emails', 'read_email', 'search_emails',
              'search_contacts', 'get_contact',
              'search_youtube', 'get_video_details', 'get_channel_info', 'get_playlist_items',
              'list_self_followups',
              'list_my_rooms', 'read_room',
            ]);

            const iterationResults: ToolResult[] = [];

            // Tools whose output depends on real-world state that changes between
            // calls — never dedup these even if args are identical. Camera snapshots
            // must hit the camera fresh each time (position changes between calls).
            // ALL FreeCAD tools are stateful: the same list/screenshot/fuse call
            // returns different results as the model evolves, and a call that
            // failed once (fuse of non-overlapping parts) legitimately succeeds
            // after the parts are moved. Serving cached results makes the model
            // reason against a stale snapshot of the document.
            const NO_DEDUP_TOOLS = new Set([
              'ha_get_camera_snapshot',
              'start_freecad', 'create_freecad_document', 'create_freecad_part',
              'edit_freecad_object', 'delete_freecad_object', 'list_freecad_objects',
              'freecad_view', 'save_freecad_document', 'close_freecad_document',
              'fuse_freecad_objects', 'cut_freecad_object', 'fillet_freecad_object',
              'run_freecad_python',
            ]);

            // Pre-flight check: returns a ToolResult if the call should be skipped, or null to proceed
            const preFlightCheck = (tc: { id: string; name: string; arguments: Record<string, unknown> }): ToolResult | null => {
              const normalizedArgs = JSON.stringify(tc.arguments).toLowerCase();
              const dedupKey = `${tc.name}:${normalizedArgs}`;

              // --- Memory-pollution guard: reject a `remember` whose content is the
              // internal POV framing prompt or a copied room transcript. Weak models
              // (and the text→remember extractor, which uses the userMessage as the
              // content) sometimes dump the "[You are X. Reply as X …]" frame or a wall
              // of "[Name]: …" lines into the long-term memory DB. That's never a real
              // memory — skip it so the store isn't polluted. ---
              if (tc.name === 'remember') {
                const memContent = String((tc.arguments?.content ?? tc.arguments?.text ?? '')).trim();
                const transcriptLines = (memContent.match(/\[[^\]\n]{1,40}\]\s*[:：]/g) || []).length;
                const looksLikeFraming =
                  /^\[?\s*you are\s+\w+\b[\s\S]{0,40}(?:reply as|not anyone else)/i.test(memContent) ||
                  /RIGHT NOW in the latest messages/i.test(memContent) ||
                  // Delegated workers sometimes "remember" the task prompt itself —
                  // caught live 2026-08-05: Aloy stored "[DELEGATED TASK from Lissa]
                  // ## Context from orchestrator …" verbatim. The prompt is scaffolding,
                  // never a memory.
                  /^\[DELEGATED TASK\b/i.test(memContent) ||
                  /## Context from orchestrator/i.test(memContent) ||
                  transcriptLines >= 2;
                if (looksLikeFraming) {
                  console.log(`   🧹 ${choomTag} Skipping remember — content is the POV framing / room transcript, not a real memory`);
                  return { toolCallId: tc.id, name: 'remember', result: { success: false, message: 'Not saved — that was the conversation framing/transcript, not a real memory. Only call remember with a concise fact genuinely worth keeping.' } };
                }
              }

              // --- Deduplication: skip if same tool+args already executed ---
              if (!NO_DEDUP_TOOLS.has(tc.name)) {
                const cachedResult = executedToolCache.get(dedupKey);
                if (cachedResult !== undefined) {
                  // Track repeat count. If the model keeps trying the same call
                  // despite getting cached results back (Qwen 3.6 35B-A3B
                  // observed: 10 identical send_notification calls in one
                  // iteration), escalate the response so the agentic loop
                  // breaks out instead of burning iterations on a stuck model.
                  const hits = (dedupHitCounts.get(dedupKey) || 0) + 1;
                  dedupHitCounts.set(dedupKey, hits);
                  console.log(`   🔁 Skipping duplicate tool call: ${tc.name} (repeat #${hits})`);

                  if (hits >= 5) {
                    // Tight repeat loop — request loop termination after this iteration
                    if (!loopBreakRequested) {
                      console.log(`   🛑 ${choomTag} Repeat-call loop detected on ${tc.name} (${hits} hits) — will terminate agentic loop after this iteration`);
                      loopBreakRequested = true;
                    }
                    return {
                      toolCallId: tc.id,
                      name: tc.name,
                      result: null,
                      error: `STOP. You have already called ${tc.name} with these exact arguments ${hits} times in this request. The action completed on the first call. Do not call this tool again — write a brief one-sentence acknowledgement to the user and end your turn.`,
                    };
                  }

                  const cachedObj = (typeof cachedResult === 'object' && cachedResult !== null && !Array.isArray(cachedResult))
                    ? { ...cachedResult as Record<string, unknown>, _note: 'This tool was already called with the same arguments. Use the previous result. Do NOT call this tool again with these arguments.' }
                    : { _cachedResult: cachedResult, _note: 'This tool was already called with the same arguments. Use the previous result. Do NOT call this tool again with these arguments.' };
                  return { toolCallId: tc.id, name: tc.name, result: cachedObj };
                }
              }

              // --- Image generation cap (per batch) ---
              // Note: the batch-aware check above (imageGenCount + pendingImageGenInBatch)
              // catches this first. This is a safety net for any path that skips that check.
              if (tc.name === 'generate_image' && imageGenCount >= 5) {
                console.log(`   🖼️  Skipping generate_image (${imageGenCount}/5 already generated this batch)`);
                return { toolCallId: tc.id, name: tc.name, result: { success: false, message: `Image generation limit reached (${imageGenCount}/5 this batch). Wait for the next iteration to generate more images.` } };
              }

              // --- Per-tool call counter ---
              const currentToolCount = (toolCallCounts.get(tc.name) || 0) + 1;
              toolCallCounts.set(tc.name, currentToolCount);
              // Per-tool budget tracks the turn's iteration cap — a Choom allowed N
              // rounds may legitimately need one tool N times. The old flat 50
              // strangled tool-driven work mid-turn even when maxIterations was
              // higher (Genesis 2026-08-25: run_ssh_command blocked at 51/50 on
              // iteration ~11 of /100), and the retry spiral that followed killed
              // the whole turn via the repeat-loop guard.
              const effectiveLimit = maxIterations;
              if (tc.name !== 'generate_image' && currentToolCount > effectiveLimit) {
                console.log(`   🛑 Tool call limit reached for ${tc.name} (${currentToolCount}/${effectiveLimit})`);
                return { toolCallId: tc.id, name: tc.name, result: { success: false, message: `Tool ${tc.name} has been called ${currentToolCount} times this request (limit: ${effectiveLimit}). You must try a different approach or present your results to the user.` } };
              }

              // --- Broken tool blocking (config error or repeated failures) ---
              if (brokenTools.has(tc.name)) {
                console.log(`   🚫 ${tc.name} blocked (broken tool — will not retry)`);
                // If past errors explicitly told us what tool to use instead,
                // surface that guidance in the block message — otherwise the
                // model often hits the cap before realizing the error was
                // pointing it at a specific replacement.
                const replacementHint = toolReplacementHints.get(tc.name);
                const hintLine = replacementHint
                  ? ` ${replacementHint} (the prior errors explicitly told you this — follow them.)`
                  : ' Tell the user what went wrong and suggest alternatives.';
                return {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: null,
                  error: `${tc.name} has been disabled for this request because it failed repeatedly. Do NOT call ${tc.name} again.${hintLine}`,
                };
              }

              // --- Failed call cache ---
              // (stateful tools exempt: a fuse that failed on non-overlapping parts
              // succeeds after the parts are moved — same args, different world)
              const cachedError = NO_DEDUP_TOOLS.has(tc.name) ? undefined : failedCallCache.get(dedupKey);
              if (cachedError) {
                const priorFails = (cachedFailureHits.get(dedupKey) || 0) + 1;
                cachedFailureHits.set(dedupKey, priorFails);
                console.log(`   🔁 Returning cached failure for ${tc.name} (same args already failed, re-serve #${priorFails})`);
                const retryLine = priorFails >= 3
                  ? `Do NOT call this tool with these arguments again — pick a DIFFERENT tool or approach, or summarize your progress.`
                  : `Try a different approach or different arguments.`;
                return { toolCallId: tc.id, name: tc.name, result: null, error: `${cachedError} [This exact call already failed${priorFails >= 3 ? ` ${priorFails} times` : ''}. ${retryLine}]` };
              }

              return null; // Proceed with execution
            };

            // Execute a single tool call and handle post-execution bookkeeping
            const executeAndProcess = async (tc: { id: string; name: string; arguments: Record<string, unknown> }, isParallel = false): Promise<ToolResult> => {
              send({ type: 'tool_call', toolCall: tc });
              serverLog(choomId, logChatId, 'info', 'system', `Tool Call: ${tc.name}`,
                `Arguments: ${JSON.stringify(tc.arguments).slice(0, 200)}`,
                { toolName: tc.name, arguments: tc.arguments });

              traceBuilder.toolCallStart(tc.id);
              const normalizedArgs = JSON.stringify(tc.arguments).toLowerCase();
              const dedupKey = `${tc.name}:${normalizedArgs}`;

              let result: ToolResult;
              try {
                result = skillDispatch
                  ? await executeToolCallViaSkills(tc, ctx)
                  : await executeToolCall(tc, ctx);
              } catch (toolErr) {
                const toolErrMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                console.error(`   ❌ Tool execution error for ${tc.name}:`, toolErrMsg);
                result = { toolCallId: tc.id, name: tc.name, result: null, error: `Tool execution failed: ${toolErrMsg}` };
              }

              // Classify error (hoisted for trace logging)
              let errorClass: ToolErrorClass | undefined;

              // Cache results (skip for tools whose output depends on real-world state)
              if (!result.error) {
                if (!NO_DEDUP_TOOLS.has(tc.name)) {
                  executedToolCache.set(dedupKey, result.result);
                }
                consecutiveFailures = 0;
                consecutiveNoToolIters = 0;
              } else {
                console.log(`   ❌ ${choomTag} ${tc.name} failed: ${result.error.slice(0, 200)}`);
                // Classify the error to decide blocking and counting strategy:
                // - Config/auth errors → block immediately (model can't fix these)
                // - Missing param errors → DON'T count toward any failure cap (model can fix by providing params)
                // - Other errors → count toward per-tool cap and consecutive failures
                // Patterns live in lib/tool-error-classification.ts so they can be
                // unit-tested against verbatim production error strings. A reworded
                // error message once silently fell out of the recoverable set and
                // started disabling ha_get_state mid-recovery; see that module.
                const isConfigError = CONFIG_ERROR.test(result.error);
                const isHaShapeError = tc.name === 'ha_call_service' && HA_SHAPE_ERROR.test(result.error);
                const isHaServiceDiscovery = /^ha_(?:call_service|get_state)$/.test(tc.name)
                  && HA_DISCOVERY_ERROR.test(result.error);
                const isParamError = PARAM_ERROR.test(result.error)
                  || isHaShapeError
                  || isHaServiceDiscovery;
                const isGpuBusy = GPU_BUSY.test(result.error);
                const isNoData = NO_DATA.test(result.error);
                const isPathError = PATH_ERROR.test(result.error);
                const isStaleRef = STALE_REF_ERROR.test(result.error);
                // Folder-ownership / shared-folder blocks (contractGate) are recoverable and
                // argument-specific: a write to the worker's own folder or choom_commons/
                // would succeed. Must NOT count toward the per-tool failure cap, or two
                // mis-targeted writes disable workspace_write_file for the whole request —
                // including the legitimate writes the model issues right after.
                const isPermissionBlock = PERMISSION_BLOCK.test(result.error);
                // The fine-grained label (auth/rate_limit/timeout/network/upstream_*/
                // template/…) comes from the shared classifier; the boolean flags above
                // keep driving cap/blocking behavior so refining a label can never
                // change which errors disable a tool.
                errorClass = classifyToolError(tc.name, result.error).errorClass;
                failedCallCache.set(dedupKey, result.error);

                // Capture "Use TOOL_NAME ..." guidance from error messages.
                // When a tool's error explicitly tells the model which tool
                // to call instead, save it so we can surface it on the
                // broken-tool block — otherwise the model retries the
                // wrong tool until the per-tool cap kicks in (Aloy hit
                // read_document 4× before giving up despite every error
                // saying "Use workspace_read_file").
                const useHintMatch = result.error.match(
                  /\bUse\s+([a-z_][a-z0-9_]*)\b(?:\s+with\s+([^.]+))?/i,
                );
                if (useHintMatch) {
                  const suggestedTool = useHintMatch[1];
                  const suggestedArgs = useHintMatch[2]?.trim();
                  // The regex matches ANY prose "Use <word>", so it happily
                  // scraped ordinary English out of error text: the HA error
                  // "Real climate entities on THIS system: ... Use one of these"
                  // produced the hint "Use `one` instead." and pointed the model
                  // at a tool that does not exist. Only accept the capture if it
                  // names a tool that is actually registered for this request.
                  const isRealTool = activeTools.some(t => t.name === suggestedTool);
                  if (isRealTool && suggestedTool !== tc.name) {
                    const hint = suggestedArgs
                      ? `Use \`${suggestedTool}\` with ${suggestedArgs.slice(0, 200)}`
                      : `Use \`${suggestedTool}\` instead.`;
                    toolReplacementHints.set(tc.name, hint);
                  }
                }
                if (isNoData) {
                  // No data found is informational — the tool works, the entity just has no data.
                  // Don't count toward failure caps (prevents blocking ha_get_history etc.)
                  console.log(`   ℹ️  ${tc.name}: no data found (informational, not counted as failure)`);
                } else if (isPathError || isPermissionBlock || isStaleRef) {
                  // File/path not found, folder-ownership block, OR a stale/guessed id
                  // (the error lists valid ids) — all recoverable. Don't count toward
                  // failure caps. LLM can list the directory and retry with the correct
                  // path, write to its own folder / choom_commons, or reuse a valid id.
                  // Counting these would disable the tool after 2 tries and lock the
                  // model out of ALL such calls for the rest of the request.
                  console.log(`   📁 ${tc.name}: ${isPermissionBlock ? 'folder-ownership block' : isStaleRef ? 'stale/unknown id' : 'path not found'} (recoverable, not counted as failure)`);
                } else if (isGpuBusy) {
                  // GPU busy is temporary — don't count as failure, don't block the tool.
                  // The model should stop retrying and inform the user.
                  console.log(`   ⏳ ${tc.name}: GPU busy (temporary, not counted as failure)`);
                } else if (isParamError) {
                  // Param errors are recoverable — don't count toward consecutiveFailures
                  // The LLM can fix by providing the correct params on the next call
                  console.log(`   ⚠️  ${tc.name}: param error (recoverable, not counted as failure)`);
                } else if (isConfigError && !brokenTools.has(tc.name)) {
                  consecutiveFailures++;
                  brokenTools.add(tc.name);
                  console.log(`   🚫 ${tc.name} blocked for rest of request (config error)`);
                } else {
                  consecutiveFailures++;
                  // Count other failures toward per-tool cap
                  const toolFails = (toolFailureCounts.get(tc.name) || 0) + 1;
                  toolFailureCounts.set(tc.name, toolFails);
                  if (toolFails >= failureCapFor(tc.name) && !brokenTools.has(tc.name)) {
                    brokenTools.add(tc.name);
                    console.log(`   🚫 ${tc.name} blocked after ${toolFails} non-param failures this request`);
                  }
                }
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                  console.log(`   🛑 ${MAX_CONSECUTIVE_FAILURES} consecutive tool failures — aborting loop`);
                }
              }

              // Tool-level pivot: when the tool failed and the error class
              // is one where alternatives could help (path/timeout/other —
              // NOT param/config/no_data which are handled differently),
              // append a structured hint listing sibling tools in the same
              // skill so the model has explicit alternatives instead of
              // having to guess from the prompt's "try something different"
              // policy.
              if (result.error) {
                const triedSet = new Set<string>(toolFailureCounts.keys());
                triedSet.add(tc.name); // include the just-failed tool
                attachPivotHintToError(result, {
                  failedTool: tc.name,
                  errorMessage: result.error,
                  errorClass,
                  registry: getSkillRegistry(),
                  alreadyTried: triedSet,
                });
              }

              // Record in execution trace
              traceBuilder.recordToolCall({
                id: tc.id,
                name: tc.name,
                args: tc.arguments,
                success: !result.error,
                error: result.error || undefined,
                errorClass,
                iteration,
                parallel: isParallel,
              });

              // Check for soft failure (success:false in result body)
              if (!result.error && result.result && typeof result.result === 'object' && (result.result as Record<string, unknown>).success === false) {
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                  console.log(`   🛑 ${MAX_CONSECUTIVE_FAILURES} consecutive tool failures (soft) — aborting loop`);
                }
              }

              // Track successful image generation
              if (tc.name === 'generate_image' && !result.error) {
                imageGenCount++;
              }

              send({ type: 'tool_result', toolResult: result });

              // Log details (strip large base64)
              const resultDetails: Record<string, unknown> = { toolName: result.name };
              if (result.error) {
                resultDetails.error = result.error;
              } else if (result.result && typeof result.result === 'object') {
                const cleaned = { ...(result.result as Record<string, unknown>) };
                if ('imageUrl' in cleaned) delete cleaned.imageUrl;
                if ('image_base64' in cleaned) delete cleaned.image_base64;
                resultDetails.result = cleaned;
              } else {
                resultDetails.result = result.result;
              }
              serverLog(choomId, logChatId, result.error ? 'error' : 'success', 'system',
                `Tool Result: ${result.name}`, result.error || 'Success', resultDetails);

              // Project metadata tracking
              const wsPath = (tc.arguments.path as string) || (tc.arguments.image_path as string) || '';
              // Guarded decode: a model-supplied path like "50%_off/notes.md"
              // makes decodeURIComponent throw URIError AFTER the tool already
              // ran — which used to kill the whole turn (error event, nothing
              // saved). The raw segment is a fine fallback for folder lookup.
              const rawTopFolder = wsPath.split('/')[0];
              let topFolder = rawTopFolder;
              try { topFolder = decodeURIComponent(rawTopFolder); } catch { /* keep raw */ }

              if (!iterationCapLocked && topFolder) {
                try {
                  const projectService = new ProjectService(WORKSPACE_ROOT);
                  const project = await projectService.getProject(topFolder);
                  if (project?.metadata.maxIterations && project.metadata.maxIterations > 0) {
                    // Bidirectional: a project's cap applies whether tighter or looser
                    // than the running default — "limit by project" must work in both
                    // directions. Explicit caps (override/directive/an already-applied
                    // project) never reach this branch: iterationCapLocked is true.
                    maxIterations = project.metadata.maxIterations;
                    iterationCapLocked = true; // Don't re-check on every tool result
                    console.log(`   📂 Project "${topFolder}": maxIterations → ${maxIterations} (mid-turn project detection)`);
                  }
                } catch { /* ignore project read errors */ }
              }

              const projectUpdateTools = ['workspace_write_file', 'workspace_create_folder', 'workspace_read_file', 'workspace_list_files', 'analyze_image', 'download_web_image', 'download_web_file', 'workspace_read_pdf', 'execute_code', 'create_venv', 'install_package', 'run_command', 'workspace_rename_project', 'save_generated_image'];
              if (projectUpdateTools.includes(tc.name) && topFolder && !result.error) {
                try {
                  const projectService = new ProjectService(WORKSPACE_ROOT);
                  await projectService.updateProjectMetadata(topFolder, {
                    lastModified: new Date().toISOString(),
                    assignedChoom: choom.name,
                  });
                } catch { /* ignore metadata update errors */ }
              }

              return result;
            };

            // Phase 0: Dedup identical calls within this iteration + cap batch size.
            // Local models (especially small ones) can go feral and emit 100+ identical
            // calls in a single iteration. Dedup collapses them to one canonical execution;
            // the cap rejects runaway batches with instructive feedback.
            const MAX_PARALLEL_BATCH = 15;
            const dedupMap = new Map<string, string>(); // key → canonical tc.id
            const canonicalResults = new Map<string, ToolResult>(); // canonical tc.id → result
            const duplicateAliases = new Map<string, string>(); // duplicate tc.id → canonical tc.id
            const uniqueCalls: typeof toolCalls = [];
            const cappedResults = new Map<string, ToolResult>(); // tc.id → error result for capped

            for (const tc of toolCalls) {
              const key = `${tc.name}::${JSON.stringify(tc.arguments || {})}`;
              const canonical = dedupMap.get(key);
              if (canonical) {
                duplicateAliases.set(tc.id, canonical);
              } else {
                dedupMap.set(key, tc.id);
                if (uniqueCalls.length >= MAX_PARALLEL_BATCH) {
                  const capped: ToolResult = {
                    toolCallId: tc.id,
                    name: tc.name,
                    result: {
                      success: false,
                      message: `Too many tool calls in one iteration (limit: ${MAX_PARALLEL_BATCH} unique calls). You are likely in a loop — slow down, make fewer focused calls, and check your earlier tool results before calling more.`,
                    },
                    error: `Batch cap exceeded (${MAX_PARALLEL_BATCH})`,
                  };
                  cappedResults.set(tc.id, capped);
                } else {
                  uniqueCalls.push(tc);
                }
              }
            }

            if (duplicateAliases.size > 0 || cappedResults.size > 0) {
              console.log(
                `   🧹 Dedup: ${toolCalls.length} calls → ${uniqueCalls.length} unique` +
                (duplicateAliases.size > 0 ? ` (${duplicateAliases.size} duplicates collapsed)` : '') +
                (cappedResults.size > 0 ? ` | 🚫 ${cappedResults.size} capped` : '')
              );
              for (const capped of cappedResults.values()) {
                allToolResults.push(capped);
                consecutiveFailures++;
                send({ type: 'tool_result', toolResult: capped });
              }
            }

            // Phase 1: Run pre-flight checks on (deduped) tool calls.
            // Track pending image gen calls within this batch to enforce the cap
            // BEFORE execution (otherwise all N calls pass when imageGenCount=0).
            let pendingImageGenInBatch = 0;
            const preFlightResults = new Map<string, ToolResult>(); // tc.id → result
            const pendingCalls: typeof toolCalls = [];
            for (const tc of uniqueCalls) {
              // Batch-aware image gen cap: count calls already queued in this batch.
              // Cap is 5 per batch; imageGenCount resets at the start of each iteration,
              // so later iterations can generate more images if the workflow needs it.
              if (tc.name === 'generate_image' && imageGenCount + pendingImageGenInBatch >= 5) {
                const total = imageGenCount + pendingImageGenInBatch;
                console.log(`   🖼️  Skipping generate_image (${total}/5 already queued this batch)`);
                const skippedImg: ToolResult = { toolCallId: tc.id, name: tc.name, result: { success: false, message: `Image generation limit reached (${total}/5 this batch). You can generate more images in a later iteration if needed.` } };
                preFlightResults.set(tc.id, skippedImg);
                allToolResults.push(skippedImg);
                continue;
              }
              const skipped = preFlightCheck(tc);
              if (skipped) {
                preFlightResults.set(tc.id, skipped);
                allToolResults.push(skipped);
                if (skipped.error) consecutiveFailures++;
                traceBuilder.recordToolCall({
                  id: tc.id, name: tc.name, args: tc.arguments,
                  success: !skipped.error, error: skipped.error || undefined,
                  // Pre-flight refusals classify as blocked_reissue — the doctor
                  // must see "model re-called a disabled tool", not another
                  // unnamed failure of the tool itself.
                  errorClass: skipped.error ? classifyToolError(tc.name, skipped.error).errorClass : undefined,
                  iteration, parallel: false,
                  cached: !skipped.error, blocked: !!skipped.error,
                });
                send({ type: 'tool_call', toolCall: tc });
                send({ type: 'tool_result', toolResult: skipped });
              } else {
                if (tc.name === 'generate_image') pendingImageGenInBatch++;
                pendingCalls.push(tc);
              }
            }

            // Phase 2: Partition pending calls into:
            //   parallelCalls    — read-only tools that run concurrently
            //   webSearchCalls   — read-only but rate-limited; serialize within
            //                       a batch to avoid hammering SearXNG/upstream
            //                       engines (Brave/Google trip 429s when 5 calls
            //                       fan out to ~30 upstream requests/sec)
            //   sequentialCalls  — mutating tools, one at a time
            const parallelCalls = pendingCalls.filter(
              tc => PARALLEL_SAFE.has(tc.name) && tc.name !== 'web_search',
            );
            const webSearchCalls = pendingCalls.filter(tc => tc.name === 'web_search');
            const sequentialCalls = pendingCalls.filter(tc => !PARALLEL_SAFE.has(tc.name));

            // Execute parallel-safe (non-search) tools concurrently
            const parallelResults = new Map<string, ToolResult>();
            if (parallelCalls.length > 1) {
              console.log(`   ⚡ Executing ${parallelCalls.length} read-only tools in parallel: ${parallelCalls.map(tc => tc.name).join(', ')}`);
              const results = await Promise.all(parallelCalls.map(tc => executeAndProcess(tc, true)));
              for (let i = 0; i < parallelCalls.length; i++) {
                parallelResults.set(parallelCalls[i].id, results[i]);
                allToolResults.push(results[i]);
              }
            } else if (parallelCalls.length === 1) {
              // Single parallel-safe call — no benefit from Promise.all, just execute
              const result = await executeAndProcess(parallelCalls[0]);
              parallelResults.set(parallelCalls[0].id, result);
              allToolResults.push(result);
            }

            // Execute web_search calls SEQUENTIALLY (N=1 in flight). Each
            // search completes before the next starts, so upstream engines
            // see a steady trickle instead of a burst. No cap on total
            // searches per request — model can do many, just not at once.
            if (webSearchCalls.length > 0) {
              if (webSearchCalls.length > 1) {
                console.log(`   🔍 Executing ${webSearchCalls.length} web_search calls SEQUENTIALLY (N=1 in flight to protect SearXNG/upstreams)`);
              }
              for (const tc of webSearchCalls) {
                const result = await executeAndProcess(tc);
                parallelResults.set(tc.id, result);
                allToolResults.push(result);
              }
            }

            // Execute sequential (mutating) tools one at a time
            const sequentialResults = new Map<string, ToolResult>();
            for (const tc of sequentialCalls) {
              const result = await executeAndProcess(tc);
              sequentialResults.set(tc.id, result);
              allToolResults.push(result);
            }

            // Merge results in original tool call order (handling dedup aliases + cap)
            for (const tc of toolCalls) {
              let r = cappedResults.get(tc.id)
                || preFlightResults.get(tc.id)
                || parallelResults.get(tc.id)
                || sequentialResults.get(tc.id);
              if (!r) {
                // Duplicate call — alias to canonical's result
                const canonicalId = duplicateAliases.get(tc.id);
                if (canonicalId) {
                  const canonicalResult = preFlightResults.get(canonicalId)
                    || parallelResults.get(canonicalId)
                    || sequentialResults.get(canonicalId);
                  if (canonicalResult) {
                    r = { ...canonicalResult, toolCallId: tc.id };
                    allToolResults.push(r);
                  }
                }
              }
              if (r) iterationResults.push(r);
            }

            // Note: nudgeCount is NOT reset after tool success. Once tools have been
            // called (allToolCalls.length > 0), nudging and extraction are skipped
            // entirely — the model's next text response is accepted as the final answer.

            // If ALL tools in this iteration had REAL failures (not temporary conditions
            // like GPU-busy or no-data), inject an abort hint so the LLM doesn't loop.
            // GPU-busy is transient (another tool is using the GPU) and no-data is
            // informational — neither indicates a broken tool that warrants aborting.
            const TEMPORARY_ERROR = /GPU is busy|GPU is currently busy|no (?:history |data |results? )(?:data |found )?for /i;
            const allFailedThisIteration = iterationResults.length > 0 &&
              iterationResults.every(r => {
                const hasError = r.error || (r.result && typeof r.result === 'object' && (r.result as Record<string, unknown>).success === false);
                if (!hasError) return false; // success — not a failure
                if (r.error && TEMPORARY_ERROR.test(r.error)) return false; // temporary — not a real failure
                return true; // real failure
              });
            // Fire the ladder on EITHER several distinct failures OR one failure
            // re-served repeatedly — a stubborn same-args retry loop needs the
            // lateral-thinking prompt exactly as much (Genesis 2026-08-25: a
            // single run_ssh_command arg-set was re-served 70× while the old
            // failedCallCache.size>=2 gate froze the ladder at 0/2 and the abort
            // gate below waited on it forever).
            const totalCachedFailureReturns = Array.from(cachedFailureHits.values()).reduce((a, b) => a + b, 0);
            if (allFailedThisIteration && (failedCallCache.size >= 2 || totalCachedFailureReturns >= 3)) {
              if (reflectionNudgesUsed < MAX_REFLECTION_NUDGES) {
                // Before stripping tools, prompt lateral thinking. Most Chooms will
                // retry the same failing approach unless explicitly asked to consider
                // alternatives. Weaker local models especially need this nudge.
                const goalText = (message || '').trim().slice(0, 500);
                const recentErrors = Array.from(failedCallCache.entries())
                  .slice(-3)
                  .map(([key, err]) => `  • ${key.split(':')[0]}: ${String(err).slice(0, 160)}`)
                  .join('\n');
                const nudgeContent = reflectionNudgesUsed === 0
                  ? `[System] STOP — multiple tool attempts have failed:\n${recentErrors}\n\nDon't retry the same tool with different args. Think laterally about the user's goal: "${goalText}"\n\nBrainstorm 3 DIFFERENT paths before your next tool call:\n1. A different tool entirely — what other capability could reach the same outcome?\n2. A different sequence — could you get there via an intermediate step you haven't tried?\n3. A workaround — if the ideal path is blocked, what's a partial solution that still helps?\n\nThen pick the most promising alternative and try it. You still have all tools available.`
                  : `[System] Your new approach also failed:\n${recentErrors}\n\nRe-anchor on the original goal: "${goalText}"\n\nIgnore the specific tools you've been trying. If you had to achieve this by any means, what would you do? Consider different domains, different integrations, controlling a different device to reach the same outcome, or combining tools in a new sequence. Look at your full tool list and pick something fundamentally different from what you've tried.\n\nThis is your last chance to find a path before we give up. If no tool can help, do the closest thing possible (partial result, related info) rather than reporting pure failure.`;
                currentMessages.push({
                  role: 'user',
                  content: nudgeContent,
                });
                reflectionNudgesUsed++;
                console.log(`   🤔 Reflection nudge #${reflectionNudgesUsed}/${MAX_REFLECTION_NUDGES} — ${failedCallCache.size} failures, prompting lateral thinking (tools still available)`);
              } else {
                // Reflection exhausted — strip tools and force summary.
                currentMessages.push({
                  role: 'user',
                  content: '[System] Every approach has failed after multiple reflections. Stop trying tools. Tell the user specifically what you tried, why each failed, and what they could check or adjust on their end. Be honest about what was and was not possible.',
                });
                activeTools = [];
                console.log(`   🛑 Reflection exhausted (${reflectionNudgesUsed} nudges used, ${failedCallCache.size} failures) — stripped tools`);
              }
            }

            // Build messages for next iteration: append assistant message + tool results
            // IMPORTANT: Strip imageUrl from results before sending to LLM
            currentMessages.push({
              role: 'assistant',
              content: iterationContent || '',
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            });

            // Freshness-tiered compression: before adding THIS iteration's full
            // results, trim the prior tool results still in the transcript. The
            // model already acted on them, so re-sending the full payload every
            // iteration just burns context (and buries small local models). The
            // freshest batch (pushed below) stays full; error outputs and
            // already-trimmed messages are left untouched.
            if (compressToolOutputs) {
              for (const msg of currentMessages) {
                if (msg.role === 'tool' && typeof (msg as { content?: unknown }).content === 'string') {
                  const { content: trimmed, savedChars } = compressStaleToolResult((msg as { content: string }).content);
                  if (savedChars > 0) {
                    (msg as { content: string }).content = trimmed;
                    liveTrimmedChars += savedChars;
                  }
                }
              }
            }
            for (const tr of iterationResults) {
              let resultForLLM = tr.result;
              if (tr.name === 'generate_image' && tr.result && typeof tr.result === 'object') {
                const { imageUrl, ...rest } = tr.result as Record<string, unknown>;
                resultForLLM = rest;
                if (imageUrl) {
                  const sizeMB = ((imageUrl as string).length / 1024 / 1024).toFixed(1);
                  console.log(`   🖼️  Image generated (${sizeMB}MB base64 stripped from LLM context)`);
                }
              }
              // Surface tool errors to the model. Previously a failed call sent
              // JSON.stringify(tr.result) === "null" with the real reason (e.g.
              // "HTTP 404") stranded in tr.error and never shown — models saw a
              // bare "null", couldn't tell a wrong URL from a broken tool, and
              // thrashed. Now the error string rides along so they can self-correct.
              const contentForLLM = tr.error
                ? JSON.stringify({
                    success: false,
                    error: tr.error,
                    ...(resultForLLM && typeof resultForLLM === 'object' ? resultForLLM : {}),
                  })
                : JSON.stringify(resultForLLM);
              currentMessages.push({
                role: 'tool' as const,
                content: contentForLLM,
                tool_call_id: tr.toolCallId,
                name: tr.name,
              });
            }

            // --- Heartbeat terminator: the Choom signaled it's done with this heartbeat.
            // Break before the next LLM call so weak local models can't regenerate the
            // message body. The summary argument is available to the scheduler via
            // response.tool_calls for UCB1 reward scoring.
            if (isHeartbeat && iterationResults.some(r => r.name === 'heartbeat_complete' && !r.error)) {
              console.log(`   💓 ${choomTag} heartbeat_complete called — ending agentic loop`);
              break;
            }

            // --- Semantic repetition guard: catch models that loop-generate the same
            // paragraph across iterations. Covers local models (Gemma, GLM) that have
            // weak repetition penalties. Applies to ALL flows, not just heartbeats.
            // Trigger: a 200+ char substring of this iteration's text appears in a
            // PRIOR iteration's text. Pure exact-match dupes are already caught earlier;
            // this catches paraphrased-but-overlapping repeats.
            if (iterationContent && iterationContent.length >= 200 && iterationTexts.length >= 2) {
              const current = iterationContent.trim();
              const OVERLAP_MIN = 200;
              const probe = current.slice(0, Math.min(OVERLAP_MIN, current.length));
              let overlapFound = false;
              for (let i = 0; i < iterationTexts.length - 1; i++) {
                if (iterationTexts[i].includes(probe)) { overlapFound = true; break; }
              }
              if (overlapFound) {
                console.warn(`   🔁 ${choomTag} Repetition loop detected — current iteration repeats a prior iteration's paragraph. Breaking loop at iteration ${iteration}.`);
                break;
              }
            }

            // --- Consecutive failure abort: tell LLM to stop and present results ---
            // Defer to the reflection ladder if it hasn't been exhausted. Otherwise a
            // reflection nudge can get undone in the same iteration by this strip,
            // which happened with Genesis's workspace_delete_file loop on sibling_journal/.
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && reflectionNudgesUsed >= MAX_REFLECTION_NUDGES) {
              currentMessages.push({
                role: 'user',
                content: `[System] Multiple consecutive tool calls have failed even after reflection. STOP retrying. Do NOT call any more tools. Instead, summarize what you were able to accomplish and explain to the user what went wrong. If you couldn't complete the task, suggest an alternative approach the user could try.`,
              });
              // Strip all tools so the LLM physically cannot call them on the next iteration.
              activeTools = [];
              console.log(`   🛑 ${consecutiveFailures} consecutive failures (reflection exhausted) — stripped tools, 1 final iteration to summarize`);
            } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES * 3) {
              // Absolute backstop: 18 straight real failures is proof of stuckness
              // even if the ladder somehow cannot advance (e.g. temporary-error
              // mixes keep allFailedThisIteration false). Never burn a whole turn.
              currentMessages.push({
                role: 'user',
                content: `[System] ${consecutiveFailures} tool calls in a row have failed. STOP retrying. Do NOT call any more tools. Summarize what you accomplished and what went wrong.`,
              });
              activeTools = [];
              console.log(`   🛑 ${consecutiveFailures} consecutive failures (backstop) — stripped tools, final iteration to summarize`);
            } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              console.log(`   ⏸️  ${consecutiveFailures} consecutive failures — deferring strip, reflection ladder active (${reflectionNudgesUsed}/${MAX_REFLECTION_NUDGES} used)`);
            }

            const approxTokens = contextBreakdown(`${choomTag} iter ${iteration}`, currentMessages, activeTools, llmSettings.contextLength || 0);
            console.log(`   🔧 ${choomTag} Next iteration | ${currentMessages.length} msgs | ~${approxTokens.toLocaleString()} tokens (msgs+tools)`);
          }

          // Assemble fullContent from all iterations, deduplicating repeated text.
          // Streaming already sent each iteration's content to clients in real-time;
          // this ensures the DB-saved version matches (minus exact duplicates where
          // the model repeated itself across iterations).
          if (iterationTexts.length > 0) {
            const seen = new Set<string>();
            const deduped: string[] = [];
            // Key on markup-stripped, whitespace-collapsed text so a replay
            // that differs only by a leaked tag or spacing still dedups
            // (C-43: '</think>' suffix defeated the exact-match key and the
            // whole reply was saved twice).
            const dedupKey = (s: string) => s.replace(/<\/?think>/g, ' ').replace(/\s+/g, ' ').trim();
            // Walk backwards so the LAST occurrence of duplicated text wins
            for (let i = iterationTexts.length - 1; i >= 0; i--) {
              const normalized = dedupKey(iterationTexts[i]);
              if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                deduped.unshift(iterationTexts[i]);
              }
            }
            // Final internal-repeat pass over the assembled message: streamed
            // (unbuffered) iterations bypass the flush-time strip, so the DB
            // copy needs its own sweep against degenerate self-repetition.
            const joined = stripInternalRepeats(deduped.join('\n\n'));
            fullContent = preLoopContent
              ? preLoopContent + '\n\n' + joined
              : joined;
            if (deduped.length < iterationTexts.length) {
              console.log(`   🔄 ${choomTag} Deduped iteration texts: ${iterationTexts.length} → ${deduped.length} unique`);
            }
          }

          // If we hit the max iterations limit, append a progress summary so "continue"
          // messages have context about what was already done (prevents redoing work)
          if (iteration >= maxIterations) {
            // Build progress summary from completed tool calls
            const toolSummaryLines: string[] = [];
            const delegationSummaries: string[] = [];
            const filesWritten: string[] = [];
            const filesRead: string[] = [];
            for (const tc of allToolCalls) {
              if (tc.name === 'delegate_to_choom') {
                const choomName = tc.arguments.choom_name || 'unknown';
                const task = (tc.arguments.task as string || '').slice(0, 100);
                delegationSummaries.push(`- Delegated to ${choomName}: ${task}`);
              } else if (tc.name === 'workspace_write_file') {
                filesWritten.push(tc.arguments.path as string || 'unknown');
              } else if (tc.name === 'workspace_read_file') {
                filesRead.push(tc.arguments.path as string || 'unknown');
              }
            }
            if (delegationSummaries.length > 0) toolSummaryLines.push('**Delegations completed:**\n' + delegationSummaries.join('\n'));
            if (filesWritten.length > 0) toolSummaryLines.push(`**Files written:** ${filesWritten.join(', ')}`);
            if (filesRead.length > 0) toolSummaryLines.push(`**Files read:** ${filesRead.join(', ')}`);

            const otherTools = allToolCalls.filter(tc => !['delegate_to_choom', 'workspace_write_file', 'workspace_read_file', 'workspace_list_files'].includes(tc.name));
            if (otherTools.length > 0) {
              const otherNames = [...new Set(otherTools.map(tc => tc.name))];
              toolSummaryLines.push(`**Other tools used:** ${otherNames.join(', ')}`);
            }

            const progressNote = toolSummaryLines.length > 0
              ? `\n\n[Reached maximum tool iterations — ${allToolCalls.length} tool calls completed]\n\n**Progress so far:**\n${toolSummaryLines.join('\n')}\n\nIf the user says "continue", pick up from where this left off. Do NOT redo completed work.`
              : '\n\n[Reached maximum tool iterations]';

            fullContent += progressNote;
            send({ type: 'content', content: progressNote });
            console.log(`   ⚠️  Hit maxIterations (${maxIterations}${iterationCapLocked ? ' — explicit cap' : ''}) — injected progress summary (${allToolCalls.length} tool calls)`);
          }
  return {
    iteration, maxIterations, fullContent, allToolCalls, resolvedProvider,
    totalPromptTokens, totalCompletionTokens, maxPromptTokens,
    llmMsTotal, llmPrefillMsTotal, llmCallCount, maxLlmCallMs, firstLlmCallAt,
    compressionSavedChars, brokenTools,
  };
}
