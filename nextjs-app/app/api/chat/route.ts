import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { LLMClient, ChatMessage } from '@/lib/llm-client';
import { MemoryClient } from '@/lib/memory-client';
import { WorkspaceService } from '@/lib/workspace-service';
import { isLocalEndpoint } from '@/lib/stream-timeouts';
import { ProjectService } from '@/lib/project-service';
import type { LLMProviderConfig, LLMModelProfile } from '@/lib/types';
import { findLLMProfile } from '@/lib/model-profiles';
import { getLiveContextWindow } from '@/lib/model-metadata';
import { allTools, getAllToolsFromSkills, useSkillDispatch } from '@/lib/tool-definitions';
import { loadCoreSkills, loadCustomSkills } from '@/lib/skill-loader';
import { CompactionService } from '@/lib/compaction-service';

import { buildChoomContext } from '@/lib/chat-context';
import { buildSystemPrompt } from '@/lib/chat-prompt';
import type { LLMSettings, ToolDefinition, WeatherSettings } from '@/lib/types';
import * as fs from 'fs';
import * as path from 'path';

// Default client settings + workspace write policy — moved to shared modules
// so the tool-execution module can use them without importing the route (C-22).
import {
  defaultLLMSettings, DEFAULT_MEMORY_ENDPOINT,
  defaultWeatherSettings,
} from '@/lib/chat-defaults';
import {
  WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB,
  WORKSPACE_ALLOWED_EXTENSIONS,
} from '@/lib/config';

import { getHardcodedToolDocs, buildSkillToolDocs } from '@/lib/tool-execution';
import {
  serverLog, smartMerge, recordGuiActivity, MAX_ITERATIONS,
} from '@/lib/chat-shared';
import { runChatTurn } from '@/lib/chat-stream';

// ============================================================================
// Main POST handler
// ============================================================================

// Cross-turn near-verbatim repeat detector — the 1:1 counterpart of the group
// rooms' self-repeat catch (isRepeatOrParrot in group-chat-runner.ts, ba6b5e4).
// Weak local models anchor on their previous turn and replay it nearly
// word-for-word (classic case: re-apologizing and re-running the same tools on
// the turn AFTER a correction→apology exchange). Lives in
// lib/repetition-guard.ts together with stripRepeatedParagraphs (C-29).

export async function POST(request: NextRequest) {

  // Load skills on first request (idempotent)
  const skillDispatch = useSkillDispatch();
  if (skillDispatch) {
    loadCoreSkills();
    loadCustomSkills();
  }

  try {
    const body = await request.json();
    const { choomId, chatId, message, settings, isDelegation, suppressNotifications, noTools, maxIterationsOverride, isHeartbeat, taskModelOverride, delegatorName } = body;
    // True only when the OWNER actually typed this (web UI or an incoming Signal
    // message) — NOT heartbeats, self-followups, cron, briefings, group, or
    // delegation. Drives cross-surface routing: an un-addressed Signal message
    // goes to whichever Choom the owner last genuinely talked to (see
    // /api/chooms/recent-user — it reads Chat.lastUserMessageAt stamped below).
    const userInitiated: boolean = !!body.userInitiated;
    // Autonomous fires (heartbeats, self-followups, briefings, cron automations)
    // now share ONE persistent per-Choom "[Autonomous]" chat instead of minting a
    // new Chat row per fire. freshContext preserves their original semantics:
    // messages are PERSISTED to that chat (so other sessions can see the activity
    // via the cross-session block below) but the LLM call starts with an empty
    // history — the sparse-prompt design the Presence Engine depends on.
    const freshContext: boolean = !!body.freshContext;
    // Group-room turn: the orchestrator (/api/group-chat) renders the shared
    // transcript from THIS Choom's point of view and passes it as groupMessages.
    // When set, we ignore the scratch chat's own history and use groupMessages,
    // inject a ## GROUP ROOM system block, and strip delegation/plan tools.
    const isGroupTurn: boolean = !!body.isGroupTurn;
    const groupMessages: Array<{ role: 'user' | 'assistant'; content: string }> = Array.isArray(body.groupMessages) ? body.groupMessages : [];
    const groupSpeakerName: string = body.speakerName || '';
    const groupParticipantNames: string[] = Array.isArray(body.groupParticipantNames) ? body.groupParticipantNames : [];
    const groupProjectFolder: string | undefined = body.groupProjectFolder || undefined;
    const groupRoomTopic: string | undefined = (typeof body.groupRoomTopic === 'string' && body.groupRoomTopic.trim()) ? body.groupRoomTopic.trim() : undefined;
    const groupRoomId: string | undefined = (typeof body.groupRoomId === 'string' && body.groupRoomId.trim()) ? body.groupRoomId.trim() : undefined;
    const groupRecentImages: string[] = Array.isArray(body.groupRecentImages) ? body.groupRecentImages : [];
    // { imagePath: description } — server-side vision describes each shared image
    // once so every speaker is TOLD what it shows (no fabricating, no per-Choom
    // analyze_image needed). Empty when vision is unavailable/failed.
    const groupImageDescriptions: Record<string, string> = (body.groupImageDescriptions && typeof body.groupImageDescriptions === 'object' && !Array.isArray(body.groupImageDescriptions))
      ? body.groupImageDescriptions as Record<string, string>
      : {};
    // This speaker started the room (called talk_with_sisters). The host should
    // stay IN the conversation, not just open it and go quiet.
    const groupIsInitiator: boolean = !!body.groupIsInitiator;
    // ActivityLog chatId for this request. For group turns, tag rows with the
    // GROUP ROOM id (not the hidden per-participant scratch chat) so they're
    // attributable to the room — drives a per-room Activity Log and keeps group
    // activity out of any 1:1 chat's log.
    const logChatId: string = (isGroupTurn && groupRoomId) ? groupRoomId : chatId;
    // Active project pinned for THIS chat via the header dropdown. When set, it
    // overrides auto-detection for the whole chat; when unset, the Choom auto-
    // detects from the message and otherwise defaults to her own selfies folder.
    // Set when this turn pins a NEW project to the chat (the user named one in the
    // message) — emitted to the web header once the SSE `send` exists, so its
    // dropdown reflects the change. Persistence itself happens on the Chat row.
    let autoSetProjectInfo: { folder: string; name: string } | null = null;

    if (!choomId || !chatId || !message) {
      return new Response(
        JSON.stringify({ error: 'choomId, chatId, and message are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch choom and chat data
    const [choom, chat] = await Promise.all([
      prisma.choom.findUnique({ where: { id: choomId } }),
      prisma.chat.findUnique({
        where: { id: chatId },
        include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } },
      }),
    ]);

    if (!choom || !chat) {
      return new Response(
        JSON.stringify({ error: 'Choom or Chat not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Record GUI activity so heartbeat scheduler defers while we're chatting
    if (!isDelegation && !isGroupTurn) {
      recordGuiActivity(choom.name);
    }

    // Stamp this chat as the owner's most-recent genuine conversation, so an
    // un-addressed Signal message routes back to this Choom (cross-surface
    // continuity). Fire-and-forget; never block the turn on it.
    if (userInitiated && !isHeartbeat && !isGroupTurn && !isDelegation) {
      prisma.chat
        .update({ where: { id: chatId }, data: { lastUserMessageAt: new Date() } })
        .catch((e) => console.warn('lastUserMessageAt stamp failed:', e));
    }

    // Save user message. Skipped for group turns — the group orchestrator owns
    // the canonical transcript (GroupMessage rows); the scratch chat is only a
    // FK/tracing anchor and we don't want to bloat it with per-turn instructions.
    if (!isGroupTurn) {
      await prisma.message.create({
        data: {
          chatId,
          role: 'user',
          content: message,
        },
      });

      // Update chat title if needed
      if (!chat.title) {
        const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
        await prisma.chat.update({ where: { id: chatId }, data: { title } });
      }
    }

    // Build LLM settings: Layer 1 (code defaults) -> Layer 2 (client/settings panel) -> Layer 3 (Choom overrides)
    const clientLLMSettings = settings?.llm || {};
    const llmSettings: LLMSettings = {
      ...defaultLLMSettings,
      ...clientLLMSettings,
      ...(choom.llmModel && { model: choom.llmModel }),
      ...(choom.llmEndpoint && { endpoint: choom.llmEndpoint }),
    };

    // Settings hierarchy trace
    console.log(`\n⚙️  Settings Hierarchy for "${choom.name}":`);
    console.log(`   Layer 1 (defaults): model=${defaultLLMSettings.model}, endpoint=${defaultLLMSettings.endpoint}`);
    console.log(`   Layer 2 (settings panel): model=${clientLLMSettings.model || '(not set)'}, endpoint=${clientLLMSettings.endpoint || '(not set)'}`);
    console.log(`   Layer 3 (Choom DB): llmModel=${choom.llmModel || '(not set)'}, llmEndpoint=${choom.llmEndpoint || '(not set)'}, llmProviderId=${choom.llmProviderId || '(not set)'}, timeout=${choom.llmTimeoutSec || 120}s`);
    console.log(`   ✅ RESOLVED: model=${llmSettings.model}, endpoint=${llmSettings.endpoint}`);
    if (choom.llmFallbackModel1 || choom.llmFallbackProvider1) {
      console.log(`   🔄 Fallback 1: model=${choom.llmFallbackModel1 || '(provider default)'}, provider=${choom.llmFallbackProvider1 || 'local'}`);
    }
    if (choom.llmFallbackModel2 || choom.llmFallbackProvider2) {
      console.log(`   🔄 Fallback 2: model=${choom.llmFallbackModel2 || '(provider default)'}, provider=${choom.llmFallbackProvider2 || 'local'}`);
    }
    if (choom.imageSettings) {
      try {
        const imgSettings = JSON.parse(choom.imageSettings);
        console.log(`   🖼️  Choom Image Settings: general.checkpoint=${imgSettings?.general?.checkpoint || '(not set)'}, selfPortrait.checkpoint=${imgSettings?.selfPortrait?.checkpoint || '(not set)'}`);
      } catch { /* ignore parse errors */ }
    } else {
      console.log(`   🖼️  Choom Image Settings: (none configured)`);
    }

    // Get memory endpoint from client settings or use default
    const memoryEndpoint = settings?.memory?.endpoint || DEFAULT_MEMORY_ENDPOINT;

    let llmClient: { streamChat: LLMClient['streamChat'] } = new LLMClient(llmSettings);

    // Resolve providers: prefer client-sent, fall back to bridge-config.json
    let providers: LLMProviderConfig[] = (settings?.providers as LLMProviderConfig[]) || [];
    if (providers.length === 0) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const bridgePath = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');
        if (fs.existsSync(bridgePath)) {
          const bridgeCfg = JSON.parse(fs.readFileSync(bridgePath, 'utf-8'));
          providers = (bridgeCfg.providers || []) as LLMProviderConfig[];
          if (providers.length > 0) {
            console.log(`   📂 Loaded ${providers.length} providers from bridge-config.json (not sent by client)`);
          }
        }
      } catch { /* ignore */ }
    }
    // Layer 2b: Global provider override (if LLM settings have a provider selected)
    // SKIP if Choom has an explicit local model (llmModel set, no llmProviderId) —
    // the user chose a specific local model for this Choom, and applying the global
    // cloud provider would send the local model name to the wrong endpoint.
    const globalProviderId = (clientLLMSettings as Record<string, unknown>)?.llmProviderId as string | undefined;
    const choomHasExplicitLocalModel = !!(choom.llmModel && !choom.llmProviderId);
    let usingCloudProvider = false;
    let activeProviderId = 'local';
    if (globalProviderId && providers.length > 0 && !choomHasExplicitLocalModel) {
      const globalProvider = providers.find(
        (p: LLMProviderConfig) => p.id === globalProviderId
      );
      if (globalProvider) {
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: globalProvider.endpoint,
        };
        if (globalProvider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, globalProvider.apiKey || '', globalProvider.endpoint);
          console.log(`   🔌 Layer 2b (global provider): ${globalProvider.name} (anthropic) model=${llmSettings.model}`);
        } else {
          llmClient = new LLMClient(providerSettings, globalProvider.apiKey || undefined);
          console.log(`   🔌 Layer 2b (global provider): ${globalProvider.name} (openai) model=${llmSettings.model}`);
        }
        llmSettings.endpoint = globalProvider.endpoint;
        usingCloudProvider = !isLocalEndpoint(globalProvider.endpoint);
        activeProviderId = globalProvider.id;
      }
    } else if (choomHasExplicitLocalModel && globalProviderId) {
      console.log(`   ⏭️  Layer 2b skipped: Choom has explicit local model "${choom.llmModel}" (no provider) — keeping local endpoint`);
    }

    // Layer 3b: Choom-level provider override (if Choom has a provider assigned)
    if (choom.llmProviderId && providers.length > 0) {
      const choomProvider = providers.find(
        (p: LLMProviderConfig) => p.id === choom.llmProviderId
      );
      if (choomProvider) {
        const choomModel = choom.llmModel || choomProvider.models[0] || llmSettings.model;
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: choomProvider.endpoint,
          model: choomModel,
        };

        if (choomProvider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, choomProvider.apiKey || '', choomProvider.endpoint);
          console.log(`   🔌 Layer 3b (Choom provider): ${choomProvider.name} (anthropic) model=${choomModel}`);
        } else {
          llmClient = new LLMClient(providerSettings, choomProvider.apiKey || undefined);
          console.log(`   🔌 Layer 3b (Choom provider): ${choomProvider.name} (openai) model=${choomModel}`);
        }
        llmSettings.model = choomModel;
        llmSettings.endpoint = choomProvider.endpoint;
        usingCloudProvider = !isLocalEndpoint(choomProvider.endpoint);
        activeProviderId = choomProvider.id;
      }
    }
    // Capture the Choom's resolved primary model BEFORE task override.
    // Used to fall back to the primary when a heartbeat/cron task override fails.
    const preOverrideModel = llmSettings.model;
    const preOverrideEndpoint = llmSettings.endpoint;
    const preOverrideProviderId = activeProviderId;
    const preOverrideIsCloud = usingCloudProvider;

    // Layer 4: Per-task model override (highest priority)
    // Heartbeats, automations, and other scheduled tasks can specify a model+provider
    // that overrides everything — including the Choom's own DB settings.
    // This allows cheap/fast models for simple tasks (selfies, reminders) while keeping
    // the Choom's primary model for complex work (coding, research).
    if (taskModelOverride?.model) {
      const overrideProviderId = taskModelOverride.provider_id;
      if (overrideProviderId && overrideProviderId !== '_local' && providers.length > 0) {
        const overrideProvider = providers.find((p: LLMProviderConfig) => p.id === overrideProviderId);
        if (overrideProvider) {
          const overrideSettings: LLMSettings = {
            ...llmSettings,
            model: taskModelOverride.model,
            endpoint: overrideProvider.endpoint,
          };
          if (overrideProvider.type === 'anthropic') {
            const { AnthropicClient } = await import('@/lib/anthropic-client');
            llmClient = new AnthropicClient(overrideSettings, overrideProvider.apiKey || '', overrideProvider.endpoint);
          } else {
            llmClient = new LLMClient(overrideSettings, overrideProvider.apiKey || undefined);
          }
          llmSettings.model = taskModelOverride.model;
          llmSettings.endpoint = overrideProvider.endpoint;
          usingCloudProvider = !isLocalEndpoint(overrideProvider.endpoint);
          activeProviderId = overrideProvider.id;
          console.log(`   🎯 Layer 4 (task override): ${overrideProvider.name} model=${taskModelOverride.model}`);
        }
      } else {
        // Local model override — reset endpoint to local LM Studio
        // (previous layers may have set it to a cloud provider endpoint)
        llmSettings.model = taskModelOverride.model;
        llmSettings.endpoint = taskModelOverride.endpoint || defaultLLMSettings.endpoint;
        llmClient = new LLMClient(llmSettings);
        usingCloudProvider = false;
        activeProviderId = 'local';
        console.log(`   🎯 Layer 4 (task override): local model=${taskModelOverride.model}, endpoint=${llmSettings.endpoint}`);
      }
    }

    const memoryClient = new MemoryClient(memoryEndpoint);

    // Use companionId for memory operations (falls back to choomId if not set)
    const memoryCompanionId = choom.companionId || choomId;

    // Weather settings are resolved here (not inside the context builder)
    // because the tool-execution context in runChatTurn needs them too.
    const weatherSettings: WeatherSettings = smartMerge(
      defaultWeatherSettings,
      settings?.weather as Partial<WeatherSettings> | undefined,
    );

    // Build tool documentation section
    // When USE_SKILL_DISPATCH=true, uses progressive disclosure from skill registry
    // When false, uses the hardcoded tool documentation (original behavior)
    const toolDocs = skillDispatch
      ? buildSkillToolDocs(message)
      : getHardcodedToolDocs();

    // Per-turn context blocks (time, weather, Home Assistant, recent images,
    // growth journal, auto-recalled memories, cross-session awareness) —
    // lib/chat-context.ts (C-22).
    const {
      timeInfo, weatherInfo, homeAssistantInfo, recentImagesInfo,
      growthInfo, autoMemoriesInfo, crossSessionInfo,
    } = await buildChoomContext({
      choom, choomId, chatId, message, settings, weatherSettings,
      memoryClient, memoryCompanionId, isGroupTurn, groupRoomId,
    });

    // System prompt assembly (base directives + context blocks + choomDecides
    // image autonomy + group-room rules) — lib/chat-prompt.ts (C-22).
    const finalSystemPrompt = buildSystemPrompt({
      choom, toolDocs,
      timeInfo, weatherInfo, homeAssistantInfo, recentImagesInfo,
      growthInfo, autoMemoriesInfo, crossSessionInfo,
      isGroupTurn, groupSpeakerName, groupParticipantNames, groupRoomTopic,
      groupRecentImages, groupImageDescriptions, groupIsInitiator, groupProjectFolder,
    });

    // Dynamic tool filtering: local models degrade with too many tools (>20).
    // Send ~15-25 tools: essential base + dynamically matched from message/context/history.
    // slimToolDefinition() in llm-client.ts further reduces token overhead per tool.
    let allToolDefs: ToolDefinition[] = skillDispatch ? getAllToolsFromSkills() : allTools;
    // Safety fallback: if skill dispatch returned 0 tools (e.g., registry reset by HMR),
    // fall back to the static allTools array so the Choom isn't left tool-less.
    if (allToolDefs.length === 0 && allTools.length > 0) {
      console.warn(`   ⚠️  getAllToolsFromSkills() returned 0 tools — falling back to static allTools (${allTools.length})`);
      allToolDefs = allTools;
    }
    let activeTools: ToolDefinition[] = allToolDefs;

    // <!-- max_iterations: N --> to cap agentic loop iterations per Choom
    let choomMaxIterations = 0; // 0 = use default
    const maxIterMatch = (choom.systemPrompt || '').match(/<!--\s*max_iterations:\s*(\d+)\s*-->/);
    if (maxIterMatch) {
      choomMaxIterations = Math.max(3, parseInt(maxIterMatch[1]));
    }

    // All tools are always available. slimToolDefinition() in llm-client.ts
    // handles token overhead (~40-60% reduction). Filtering tools out of the
    // array prevents the LLM from ever calling them — lesson learned twice.
    console.log(`   🛠️  All ${activeTools.length} tools available (no filtering)`);

    // noTools mode: strip ALL tools so the LLM can only produce text.
    // Used by scheduler briefings where all data is pre-fetched in the prompt.
    if (noTools) {
      console.log(`   🚫 noTools mode: stripped all ${activeTools.length} tools — text-only response`);
      activeTools = [];
    }

    // Delegation mode: strip delegation + plan tools to prevent recursive delegation loops.
    // Also strip heartbeat_complete — that tool only makes sense during a heartbeat.
    // Strip schedule_self_followup too — a delegated Choom shouldn't queue its own
    // future ticks detached from the orchestrator's flow; it should return a result.
    if (isDelegation || isGroupTurn) {
      const stripTools = new Set([
        'delegate_to_choom', 'list_team', 'get_delegation_result',
        'create_plan', 'execute_plan', 'adjust_plan',
        'heartbeat_complete', 'talk_with_sisters',
      ]);
      // In a GROUP turn, schedule_self_followup is the wrong tool (it fires as a
      // private 1:1 heartbeat) — strip it so the Choom uses schedule_room_followup,
      // which actually re-enters the room. list/cancel + schedule_room_followup stay.
      if (isGroupTurn) {
        stripTools.add('schedule_self_followup');
      }
      // A DELEGATED worker shouldn't queue detached ticks of ANY kind — strip all
      // self-scheduling so it returns a result instead.
      if (isDelegation) {
        stripTools.add('schedule_self_followup');
        stripTools.add('schedule_room_followup');
        stripTools.add('list_self_followups');
        stripTools.add('cancel_self_followup');
      }
      const before = activeTools.length;
      activeTools = activeTools.filter(t => !stripTools.has(t.name));
      console.log(`   🔒 ${isGroupTurn ? 'Group-turn' : 'Delegation'} mode: stripped ${before - activeTools.length} delegation/plan tools → ${activeTools.length} tools`);
    }

    // heartbeat_complete is the agentic-loop terminator for the Presence Engine.
    // It MUST be hidden from every non-heartbeat flow (regular chat, Signal, web UI,
    // goal review, morning briefing) — otherwise models could call it and silently
    // end a user conversation.
    if (!isHeartbeat) {
      const before = activeTools.length;
      activeTools = activeTools.filter(t => t.name !== 'heartbeat_complete');
      if (before !== activeTools.length) {
        console.log(`   🔒 Non-heartbeat: stripped heartbeat_complete tool`);
      }
    }

    // Build raw history messages (before compaction).
    // Filter out dead entries: empty assistant messages from previous timeouts,
    // and collapse consecutive duplicate user retries (keep only the last).
    // Group turns ignore the scratch chat's DB history and use the POV-rendered
    // transcript supplied by the orchestrator (own lines → assistant, everyone
    // else → user prefixed "[Name]:").
    // freshContext (autonomous fires in the shared [Autonomous] chat): persist
    // messages but start the LLM from an empty history — heartbeats must not
    // replay their own previous prompts/output (sparse-prompt design; weak
    // models mimic prior HB output when they see it).
    const historySource: Array<{ role: string; content: string }> = isGroupTurn
      ? groupMessages
      : freshContext
        ? []
        : chat.messages;
    const rawHistory: Array<{ role: string; content: string }> = [];
    for (const msg of historySource) {
      if (msg.role === 'tool') continue;
      // Skip empty assistant messages (timeout leftovers with no content and no tool calls)
      if (msg.role === 'assistant' && (!msg.content || msg.content.trim() === '')) continue;
      rawHistory.push({ role: msg.role, content: msg.content });
    }
    // Collapse consecutive duplicate user messages (user retrying same prompt)
    const historyMessages: ChatMessage[] = [];
    for (let i = 0; i < rawHistory.length; i++) {
      const msg = rawHistory[i];
      // If this is a user message and the next message is the same user message, skip this one
      if (msg.role === 'user' && i + 1 < rawHistory.length) {
        const next = rawHistory[i + 1];
        if (next.role === 'user' && next.content === msg.content) continue;
      }
      historyMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    // A chat conversation must not start with an assistant message after the
    // system prompt. The room INITIATOR's only prior line is her opening, which
    // renders as a lone leading assistant turn → [system][assistant][user]. qwen
    // answers that malformed shape with an EMPTY completion — and because she's
    // then silent she never produces a new self-line, so the split stays pinned to
    // her opening and she's stuck empty EVERY round. THIS is why the initiator
    // "never speaks in the room except at pop-in" (confirmed in traces: force=False
    // and still respLen=0). Prepend a minimal user framer so the turn is well-formed.
    if (isGroupTurn && historyMessages.length > 0 && historyMessages[0].role === 'assistant') {
      historyMessages.unshift({
        role: 'user',
        content: '[The group room is open and your siblings are here. Your first line below is how you opened the conversation — now read what they say and reply as yourself.]',
      });
    }

    // Per-model context window: a model's profile (built-in or user) contextLength
    // overrides the global slider when the resolved model isn't the global default —
    // so a RAM-capped local model (e.g. a Mac group seat loaded at 32K in LM Studio)
    // compacts and truncates against ITS real window, not the 256K global. Resolved
    // HERE, BEFORE the compaction budget below — otherwise cross-turn compaction
    // would budget against the wrong (global) context and overflow a small model.
    // Mirrors the guard at "Profile application:" so behavior matches the API-call path.
    // Resolved once here; the later "Profile application" block reuses it so a
    // stale static profile can never overwrite the live endpoint's answer.
    let resolvedCtxWindow: number | null = null;
    {
      const _globalModel = (clientLLMSettings as Record<string, unknown>)?.model as string || defaultLLMSettings.model;
      const _userProfiles = (settings?.modelProfiles as LLMModelProfile[]) || [];
      const _ctxProfile = findLLMProfile(llmSettings.model, _userProfiles);
      // Window authority, most to least trusted:
      //   1. a user profile with the EXACT model id — the explicit override lever
      //   2. the serving endpoint's live answer (LM Studio loaded_context_length /
      //      OpenRouter context_length) — static profiles went stale on 12 of 33
      //      models in the 2026-08-05 audit, so the endpoint is asked first
      //   3. the static profile (built-in or normalized-matched user profile)
      const _userExactCtx = _userProfiles.find(p => p.modelId === llmSettings.model)?.contextLength;
      const _liveCtx = _userExactCtx === undefined
        ? await getLiveContextWindow(llmSettings.model, llmSettings.endpoint)
        : null;
      const _window = _userExactCtx ?? _liveCtx ?? _ctxProfile?.contextLength;
      const _windowSrc = _userExactCtx !== undefined ? 'user profile' : _liveCtx ? 'live endpoint' : 'static profile';
      if (_window !== undefined && _window !== null) {
        resolvedCtxWindow = _window;
        if (llmSettings.model !== _globalModel) {
          llmSettings.contextLength = _window;
          console.log(`   📏 ${choom.name} per-model context: ${llmSettings.model} → ${_window.toLocaleString()} (${_windowSrc})`);
        } else if ((llmSettings.contextLength || 0) > _window) {
          // Clamp (C-53): when the resolved model IS the global default, the
          // client's store contextLength is used as-is — and it can exceed the
          // model's real window. A very long chat would then blow past the
          // model's context (the server silently drops oldest messages) before
          // compaction ever triggers. Never budget beyond the real window.
          console.log(`   📏 ${choom.name} context clamp: client ${llmSettings.contextLength?.toLocaleString()} > ${_windowSrc} window ${_window.toLocaleString()} for ${llmSettings.model} — clamping`);
          llmSettings.contextLength = _window;
        }
      }
    }

    // Cross-turn compaction: summarize old messages if history exceeds token budget
    const compactionService = new CompactionService(llmSettings);
    let compactionSummary = (chat as { compactionSummary?: string | null }).compactionSummary || null;
    let systemPromptWithSummary = finalSystemPrompt;

    // Build a non-streaming LLM client for summarization
    const summarizationClient = (() => {
      // Check if llmClient has a chat() method (LLMClient has it, AnthropicClient now has it too)
      if ('chat' in llmClient && typeof (llmClient as Record<string, unknown>).chat === 'function') {
        return llmClient as { chat: (messages: ChatMessage[], tools?: ToolDefinition[]) => Promise<{ content: string; toolCalls: unknown; finishReason: string }> };
      }
      // Fallback: create a plain LLMClient for summarization (local endpoint, no API key needed)
      return new LLMClient(llmSettings);
    })();

    let compactedHistory: ChatMessage[] = historyMessages;
    let compactionWasPerformed = false;
    let compactionStats = { messagesDropped: 0, tokensBefore: 0, tokensAfter: 0 };

    if (historyMessages.length > 0 && !isGroupTurn) {
      try {
        const compactionResult = await compactionService.compactCrossTurn(
          finalSystemPrompt, activeTools, historyMessages, compactionSummary, summarizationClient
        );

        if (compactionResult.summaryUpdated) {
          compactionSummary = compactionResult.newSummary;
          // Persist updated summary to DB
          await prisma.chat.update({
            where: { id: chatId },
            data: { compactionSummary: compactionResult.newSummary },
          });
          console.log(`   🗜️  Compaction: ${compactionResult.messagesDropped} msgs folded into summary (~${compactionResult.tokensBeforeCompaction.toLocaleString()} → ~${compactionResult.tokensAfterCompaction.toLocaleString()} tokens)`);
          serverLog(choomId, logChatId, 'info', 'system', 'Context Compaction',
            `${compactionResult.messagesDropped} messages summarized`,
            { tokensBefore: compactionResult.tokensBeforeCompaction, tokensAfter: compactionResult.tokensAfterCompaction,
              messagesDropped: compactionResult.messagesDropped });
        }

        // Inject summary into system prompt if we have one
        if (compactionSummary) {
          systemPromptWithSummary = finalSystemPrompt + `\n\n## PREVIOUS CONVERSATION SUMMARY\n${compactionSummary}`;
        }

        compactedHistory = compactionResult.messages;
        compactionWasPerformed = compactionResult.summaryUpdated;
        compactionStats = {
          messagesDropped: compactionResult.messagesDropped,
          tokensBefore: compactionResult.tokensBeforeCompaction,
          tokensAfter: compactionResult.tokensAfterCompaction,
        };
      } catch (compactErr) {
        console.warn('   ⚠️  Cross-turn compaction failed, using full history:', compactErr instanceof Error ? compactErr.message : compactErr);
      }
    }

    const currentMessages: ChatMessage[] = [
      { role: 'system', content: systemPromptWithSummary },
      ...compactedHistory,
    ];

    // Heartbeat→chat transition: when a non-heartbeat user message arrives in a
    // chat that started with a heartbeat prompt, inject a transition marker.
    // Without this, the model sees the heartbeat prompt in history and continues
    // heartbeat behavior (sibling files, heartbeat_complete, curiosity cabinet
    // steps, surprise tasks) instead of responding conversationally.
    // All messages are preserved for context.
    if (!isHeartbeat && compactedHistory.length >= 2) {
      const firstUser = compactedHistory.find(m => m.role === 'user');
      if (firstUser?.content) {
        const fc = firstUser.content;
        const isHeartbeatPrompt =
          // OODA presence heartbeat
          (fc.includes('You are waking up') && fc.includes('## OBSERVE')) ||
          // Curiosity cabinet
          fc.includes('You are performing an autonomous') ||
          // Surprise me
          (fc.startsWith('Surprise me') && fc.includes('surprise_log')) ||
          // Generic: scheduled prompt with heartbeat_complete instruction
          fc.includes('call `heartbeat_complete`') ||
          fc.includes('call heartbeat_complete');

        if (isHeartbeatPrompt) {
          const firstAssistantIdx = currentMessages.findIndex(
            (m, i) => i > 0 && m.role === 'assistant',
          );
          if (firstAssistantIdx > 0) {
            currentMessages.splice(firstAssistantIdx + 1, 0, {
              role: 'user' as 'user' | 'assistant',
              content: '[System] The scheduled task above is complete. The user is now chatting with you directly. Respond conversationally — do NOT continue the task instructions from the first message (no sibling journal, no heartbeat_complete, no curiosity cabinet steps, no surprise tasks, no environment scanning). Just talk to them naturally.',
            });
            console.log(`   🔄 Heartbeat→chat transition marker injected after heartbeat response`);
          }
        }
      }
    }

    // Pre-detect project from user message or recent chat history (FIRST, before image injection)
    // Used for: (1) injecting exact folder name so LLM doesn't create duplicates,
    //           (2) applying per-project iteration limits (e.g. 100 instead of 25)
    //           (3) scoping image pre-injection to only the detected project folder
    let enrichedMessage = message;
    let detectedProject: { folder: string; metadata: { maxIterations?: number; name?: string; llmProviderId?: string; llmModel?: string; assignedChoom?: string } } | null = null;
    if (isGroupTurn) {
      // Group turns use the GROUP ROOM workspace block (injected above) instead
      // of per-Choom home-project detection, which would otherwise add a
      // conflicting "## YOUR WORKSPACE" block pointing at selfies_<name>/.
      currentMessages[0].content += `\nYou have ${MAX_ITERATIONS} thinking rounds available. Each round can include multiple parallel tool calls — calling 5 tools in one round only uses 1 round, not 5.`;
    } else try {
      const projectService = new ProjectService(WORKSPACE_ROOT);
      const allProjects = await projectService.listProjects();
      const msgLowerForProject = message.toLowerCase().replace(/[_\s]+/g, ' ');

      // Helper: find matching projects in text, preferring longest (most specific) match
      const findBestMatch = (text: string): typeof detectedProject => {
        const matches: typeof allProjects = [];
        for (const proj of allProjects) {
          const folderNorm = proj.folder.toLowerCase().replace(/[_\s]+/g, ' ');
          const metaNameNorm = (proj.metadata.name || '').toLowerCase().replace(/[_\s]+/g, ' ');
          if ((folderNorm.length >= 4 && text.includes(folderNorm)) ||
              (metaNameNorm.length >= 4 && text.includes(metaNameNorm))) {
            matches.push(proj);
          }
        }
        if (matches.length === 0) return null;
        // Priority: (1) assigned to current Choom, (2) longest folder name, (3) has maxIterations
        const choomName = choom.name.toLowerCase();
        matches.sort((a, b) => {
          // Strongly prefer projects assigned to the current Choom
          const aAssigned = (a.metadata.assignedChoom || '').toLowerCase() === choomName ? 1 : 0;
          const bAssigned = (b.metadata.assignedChoom || '').toLowerCase() === choomName ? 1 : 0;
          if (aAssigned !== bAssigned) return bAssigned - aAssigned;
          // Then prefer longest folder name (most specific: "selfies_lissa" beats "selfies")
          const lenDiff = b.folder.length - a.folder.length;
          if (lenDiff !== 0) return lenDiff;
          const aHasIter = a.metadata.maxIterations && a.metadata.maxIterations > 0 ? 1 : 0;
          const bHasIter = b.metadata.maxIterations && b.metadata.maxIterations > 0 ? 1 : 0;
          return bHasIter - aHasIter;
        });
        return matches[0];
      };

      // (b) Did the CURRENT message explicitly name a project? ("we're working in
      // X") — if so, PIN it to this chat (persisted on the Chat row) so it sticks
      // for every later message, on web AND on Signal. Then notify the web header
      // so its dropdown updates (autoSetProjectInfo, emitted once `send` exists).
      detectedProject = findBestMatch(msgLowerForProject);
      if (detectedProject) {
        const chatPinned = (chat as { activeProjectFolder?: string | null }).activeProjectFolder;
        if (chatPinned !== detectedProject.folder) {
          await prisma.chat.update({ where: { id: chatId }, data: { activeProjectFolder: detectedProject.folder } }).catch(() => {});
          autoSetProjectInfo = { folder: detectedProject.folder, name: detectedProject.metadata.name || detectedProject.folder };
          console.log(`   📌 ${choom.name} — pinned project "${detectedProject.folder}" to this chat (named in message)`);
        }
      } else {
        // No project named now → use the project pinned on this chat (set earlier
        // by the header dropdown or a previous "we're working in X").
        const chatPinned = (chat as { activeProjectFolder?: string | null }).activeProjectFolder;
        if (chatPinned) detectedProject = allProjects.find(p => p.folder === chatPinned) || null;
      }
      // (a) No more "assigned home project" fallback. When no project is active,
      // the Choom defaults to her own selfies_ folder (handled in the else branch
      // below) — unrelated chats no longer inherit someone's last project.
      const isAssignedFallback = false;

      // Inject project context so LLM uses the exact folder name
      if (detectedProject) {
        // For explicit project detection, honor the project's maxIterations (dedicated work).
        // For the home-fallback case, stick with the default iteration count — the home
        // project is just a folder hint, not an invitation to spend 100 rounds on a
        // "what's the weather?" query.
        const projMaxIter = isAssignedFallback
          ? MAX_ITERATIONS
          : (detectedProject.metadata.maxIterations || MAX_ITERATIONS);
        if (isAssignedFallback) {
          // Softer hint: this is the Choom's default workspace, not a hard lock.
          // They can still create a new project if the user asks for one explicitly.
          enrichedMessage += `\n\n[System: Your default workspace is "${detectedProject.folder}" (this is YOUR project folder as ${choom.name}). Save any files you create inside "${detectedProject.folder}/" — do NOT create a new top-level folder for everyday work. Only create a new project if the user explicitly asks for one.]`;
          currentMessages[0].content += `\n\n## YOUR WORKSPACE\nYour home project folder is \`${detectedProject.folder}/\`. When saving files without an explicit project named by the user, save them inside \`${detectedProject.folder}/\` (e.g. \`${detectedProject.folder}/notes/today.md\`). Do NOT create new top-level folders unless the user explicitly asks you to start a new project.\n\n**Shared folder — \`choom_commons/\`** (NOT inside your home folder, NEVER prefix with \`selfies_*/\`):\n\`choom_commons/\` is where ALL cross-Choom communication happens: letters, notes, delegation handoffs, shared drafts, research, and any content meant for a sibling. Each sibling has a folder: \`choom_commons/for_eve/\`, \`choom_commons/for_genesis/\`, \`choom_commons/for_aloy/\`, \`choom_commons/for_lissa/\`, \`choom_commons/for_anya/\`, \`choom_commons/for_optic/\`. Write content FOR a sibling in their folder. Shared drafts go in \`choom_commons/drafts/\`.\n\n\`sibling_journal/\` is an old archive — you may read it for historical context but do NOT write new content there. All new cross-Choom content goes in \`choom_commons/\`.\n\nYour \`growth_journal.md\` IS inside your home folder: \`${detectedProject.folder}/growth_journal.md\`.\n\nYou may NEVER write to another Choom's \`selfies_*/\` folder. If you need to leave something for another Choom, use \`choom_commons/for_[their_name]/\`.\n\n**BEFORE cross-Choom actions** (writing to a sibling, delegating, modifying shared files): read \`choom_commons/COMMUNICATION_PROTOCOL.md\` first. If unsure whether a protocol exists for what you're about to do, search \`choom_commons/\` for relevant guidelines. Don't rely on what you think you remember — read the actual file.`;
        } else {
          enrichedMessage += `\n\n[System: Active project: "${detectedProject.folder}" (${projMaxIter} thinking rounds available). Use this EXACT folder name for all workspace file operations. Do NOT create a new folder with different casing or naming.]`;
        }
        // Also update system prompt with the correct iteration limit
        currentMessages[0].content += `\nYou have ${projMaxIter} thinking rounds available. Each round can include multiple parallel tool calls — calling 5 tools in one round only uses 1 round, not 5. Do not stop early thinking you are running out of rounds.`;
        console.log(`   📂 Project "${detectedProject.folder}" ${isAssignedFallback ? 'assigned as home (fallback)' : 'detected'} — injecting context (maxIterations: ${projMaxIter})`);
      } else {
        // (a) No active project → default to the Choom's OWN selfies_ folder (her
        // personal space), with choom_commons for cross-Choom work. This replaces
        // the old "assigned home project" fallback that leaked a forced project
        // into unrelated chats.
        const selfiesFolder = `selfies_${choom.name.toLowerCase()}`;
        currentMessages[0].content += `\n\n## YOUR WORKSPACE\nYour default workspace is \`${selfiesFolder}/\` — your own personal folder. When you save a file without a project being named, save it inside \`${selfiesFolder}/\` (e.g. \`${selfiesFolder}/notes/today.md\`). Don't spin up a new top-level folder for one-off saves — those belong in \`${selfiesFolder}/\`. But if what you're working on genuinely grows into its own body of work, use your judgment and create a dedicated project for it with \`workspace_create_project\` (the user can also name or pick one from the chat's project menu). One-off note → selfies; a real project worth keeping together → its own folder.\n\n**Shared folder — \`choom_commons/\`** (NOT inside your selfies folder): where ALL cross-Choom communication happens — letters, notes, delegation handoffs, shared drafts, research. Each sibling has a folder (e.g. \`choom_commons/for_eve/\`, \`choom_commons/for_aloy/\`); shared drafts go in \`choom_commons/drafts/\`. Write content FOR a sibling in their folder. You may NEVER write into another Choom's \`selfies_*/\` folder. Your \`growth_journal.md\` lives in \`${selfiesFolder}/growth_journal.md\`.\n\nYou have ${MAX_ITERATIONS} thinking rounds available. Each round can include multiple parallel tool calls — calling 5 tools in one round only uses 1 round, not 5.`;
        console.log(`   🪪 ${choom.name} — no active project; default workspace ${selfiesFolder}/`);
      }
    } catch { /* ignore project detection errors */ }

    // Pre-process: detect workspace/file requests and inject listing context
    // Scoped to detected project folder when available (avoids flooding context with unrelated images)
    const msgLower = message.toLowerCase();
    const mentionsImages = /\b(image|images|photo|photos|picture|pictures|jpg|jpeg|png|screenshot)\b/.test(msgLower);
    const mentionsWorkspace = /\b(project|folder|workspace|directory|files?)\b/.test(msgLower);
    const mentionsReview = /\b(review|analyze|look at|check|examine|describe|inspect|see|show)\b/.test(msgLower);
    const mentionsList = /\b(list|what'?s in|contents?|show me|what do i have|what files|what'?s there|empty|anything in)\b/.test(msgLower);

    // Skip in noTools mode: scheduler briefings dump yesterday's conversation history
    // into the prompt, which contains false-positive triggers ("image", "files", "see")
    // that would inject an analyze_image directive Genesis would dutifully follow,
    // overwriting the actual briefing instructions.
    if (!noTools && mentionsWorkspace && (mentionsImages || mentionsReview || mentionsList)) {
      try {
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
        const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);

        // Scope scanning to detected project folder, or scan all top-level dirs
        const scanDirs: string[] = detectedProject ? [detectedProject.folder] : [];
        const allFilePaths: string[] = [];
        const imagePaths: string[] = [];

        if (scanDirs.length === 0) {
          // No project detected — scan top-level to find all dirs
          const topLevel = await ws.listFiles('');
          for (const entry of topLevel) {
            if (entry.type === 'directory') scanDirs.push(entry.name);
            else if (entry.type === 'file') {
              allFilePaths.push(`📄 ${entry.name} (${entry.size} bytes)`);
              if (imageExts.some(ext => entry.name.toLowerCase().endsWith(ext))) {
                imagePaths.push(entry.name);
              }
            }
          }
        }

        for (const dir of scanDirs) {
          allFilePaths.push(`📁 ${dir}/`);
          const subFiles = await ws.listFiles(dir);
          for (const f of subFiles) {
            if (f.type === 'file') {
              allFilePaths.push(`  📄 ${dir}/${f.name} (${f.size} bytes)`);
              if (imageExts.some(ext => f.name.toLowerCase().endsWith(ext))) {
                imagePaths.push(`${dir}/${f.name}`);
              }
            } else if (f.type === 'directory') {
              allFilePaths.push(`  📁 ${dir}/${f.name}/`);
            }
          }
        }

        if (mentionsImages && mentionsReview && imagePaths.length > 0) {
          // Image-specific: inject image paths with analyze_image instructions (only when user asks to review/analyze)
          const fileList = imagePaths.map(p => `- ${p}`).join('\n');
          enrichedMessage = `${enrichedMessage}\n\n[System: Found ${imagePaths.length} image(s) in ${detectedProject ? `project "${detectedProject.folder}"` : 'workspace'}:\n${fileList}\nUse the analyze_image tool with image_path for each image listed above.]`;
          console.log(`   🖼️  Pre-injected ${imagePaths.length} workspace image paths into message${detectedProject ? ` (scoped to ${detectedProject.folder})` : ''}`);
        } else if (allFilePaths.length > 0) {
          // General listing: inject workspace tree
          const tree = allFilePaths.join('\n');
          enrichedMessage = `${enrichedMessage}\n\n[System: Current ${detectedProject ? `project "${detectedProject.folder}"` : 'workspace'} contents:\n${tree}\n]`;
          console.log(`   📂  Pre-injected workspace listing (${allFilePaths.length} entries) into message`);
        }
      } catch (err) {
        console.warn('   ⚠️  Failed to pre-list workspace files:', err);
      }
    }

    // Layer 4: Per-project LLM provider override
    if (detectedProject?.metadata?.llmProviderId && providers.length > 0) {
      const provider = providers.find(
        (p: LLMProviderConfig) => p.id === detectedProject!.metadata.llmProviderId
      );
      if (provider) {
        const projectModel = detectedProject.metadata.llmModel || provider.models[0] || llmSettings.model;
        const providerSettings: LLMSettings = {
          ...llmSettings,
          endpoint: provider.endpoint,
          model: projectModel,
        };

        if (provider.type === 'anthropic') {
          const { AnthropicClient } = await import('@/lib/anthropic-client');
          llmClient = new AnthropicClient(providerSettings, provider.apiKey || '', provider.endpoint);
          console.log(`   🔌 Layer 4 (project provider): ${provider.name} (anthropic) model=${projectModel}`);
        } else {
          llmClient = new LLMClient(providerSettings, provider.apiKey || undefined);
          console.log(`   🔌 Layer 4 (project provider): ${provider.name} (openai) model=${projectModel}`);
        }
        llmSettings.model = projectModel;
        llmSettings.endpoint = provider.endpoint;
        usingCloudProvider = !isLocalEndpoint(provider.endpoint);
      }
    }

    // Profile application: apply per-model parameter profile if resolved model differs from global default
    const globalModel = (clientLLMSettings as Record<string, unknown>)?.model as string || defaultLLMSettings.model;
    if (llmSettings.model !== globalModel) {
      const userProfiles = (settings?.modelProfiles as LLMModelProfile[]) || [];
      const profile = findLLMProfile(llmSettings.model, userProfiles);
      if (profile) {
        // Apply profile params to llmSettings (only fields that are defined in the profile)
        if (profile.temperature !== undefined) llmSettings.temperature = profile.temperature;
        if (profile.topP !== undefined) llmSettings.topP = profile.topP;
        if (profile.maxTokens !== undefined) llmSettings.maxTokens = profile.maxTokens;
        // Context: the live-endpoint resolution above outranks the static
        // profile value (which the 2026-08-05 audit caught stale on 12 models).
        if (resolvedCtxWindow !== null) llmSettings.contextLength = resolvedCtxWindow;
        else if (profile.contextLength !== undefined) llmSettings.contextLength = profile.contextLength;
        if (profile.frequencyPenalty !== undefined) llmSettings.frequencyPenalty = profile.frequencyPenalty;
        if (profile.presencePenalty !== undefined) llmSettings.presencePenalty = profile.presencePenalty;
        if (profile.topK !== undefined) llmSettings.topK = profile.topK;
        if (profile.repetitionPenalty !== undefined) llmSettings.repetitionPenalty = profile.repetitionPenalty;
        if (profile.enableThinking !== undefined) llmSettings.enableThinking = profile.enableThinking;

        // Reconstruct llmClient with updated settings.
        // Use the actual resolved provider state (usingCloudProvider) to determine
        // which client class and credentials to use — NOT the provider chain, which
        // can misleadingly pick up a global provider for a Choom that's using local.
        if (usingCloudProvider) {
          // Find the provider that was actually applied (Choom > Project > Global)
          const clientProviderId = choom.llmProviderId
            || detectedProject?.metadata?.llmProviderId
            || globalProviderId;
          const activeProvider = clientProviderId && providers.length > 0
            ? providers.find((p: LLMProviderConfig) => p.id === clientProviderId)
            : null;

          if (activeProvider?.type === 'anthropic' && activeProvider.apiKey) {
            const { AnthropicClient } = await import('@/lib/anthropic-client');
            llmClient = new AnthropicClient(llmSettings, activeProvider.apiKey, activeProvider.endpoint);
          } else if (activeProvider) {
            llmClient = new LLMClient(llmSettings, activeProvider.apiKey || undefined);
          } else {
            llmClient = new LLMClient(llmSettings);
          }
        } else {
          llmClient = new LLMClient(llmSettings);
        }

        console.log(`   📋 Model profile applied: "${profile.label || profile.modelId}" (temp=${profile.temperature}, topP=${profile.topP}, maxTokens=${profile.maxTokens}${profile.topK !== undefined ? `, topK=${profile.topK}` : ''}${profile.enableThinking !== undefined ? `, thinking=${profile.enableThinking}` : ''})`);
      }
    }

    // The actual local LM Studio endpoint for local fallbacks.
    // If the Choom has a custom local endpoint (e.g., different LM Studio instance),
    // use that; otherwise fall back to the env/code default.
    // Do NOT use llmSettings.endpoint here — it may have been overwritten by a cloud
    // provider in Layers 2b/3b/4.
    const localLMStudioEndpoint = (!choom.llmProviderId && choom.llmEndpoint)
      ? choom.llmEndpoint
      : defaultLLMSettings.endpoint;

    // Build fallback model configurations (tried in order if primary times out or errors)
    // retryDelayMs: when set, the fallback loop sleeps this long before the attempt —
    // used by the same-model local retry so the local server can settle.
    type FallbackConfig = { model: string; providerId: string | null; label: string; retryDelayMs?: number };
    const fallbackConfigs: FallbackConfig[] = [];

    // When a task override is active (heartbeat/cron using a different model than the
    // Choom's primary), prepend the primary model as fallback #0. This way if the
    // heartbeat model fails, we try the Choom's trusted primary before burning through
    // the configured fallback chain (which might be the same model that just failed).
    const taskOverrideActive = !!(taskModelOverride?.model) &&
      llmSettings.model !== preOverrideModel;
    if (taskOverrideActive && preOverrideModel) {
      const preProvider = preOverrideProviderId !== 'local'
        ? providers.find((p: LLMProviderConfig) => p.id === preOverrideProviderId) : null;
      const preLabel = preProvider ? `${preProvider.name}/${preOverrideModel}` : `local/${preOverrideModel}`;
      fallbackConfigs.push({
        model: preOverrideModel,
        providerId: preOverrideProviderId !== 'local' ? preOverrideProviderId : null,
        label: `${preLabel} (primary)`,
      });
      console.log(`   🔄 Task override active — prepended primary model as fallback #0: ${preLabel}`);
    }

    const fbEntries = [
      { model: choom.llmFallbackModel1, providerId: choom.llmFallbackProvider1 },
      { model: choom.llmFallbackModel2, providerId: choom.llmFallbackProvider2 },
    ];
    for (const fb of fbEntries) {
      if (!fb.model && !fb.providerId) continue; // Not configured
      const provider = fb.providerId ? providers.find((p: LLMProviderConfig) => p.id === fb.providerId) : null;
      const model = fb.model || provider?.models?.[0] || llmSettings.model;
      const label = provider ? `${provider.name}/${model}` : `local/${model}`;
      // Skip fallback entries that duplicate the currently-active model+provider
      // (e.g., heartbeat uses Gemma and fallback #1 is also Gemma on same endpoint)
      const activeModel = llmSettings.model;
      const activeEndpoint = llmSettings.endpoint;
      const fbEndpoint = provider?.endpoint || localLMStudioEndpoint;
      if (model === activeModel && fbEndpoint === activeEndpoint) {
        console.log(`   ⏭️  Skipping fallback ${label} — same model+endpoint as active`);
        continue;
      }
      fallbackConfigs.push({ model, providerId: fb.providerId || null, label });
    }
    if (fallbackConfigs.length > 0) {
      console.log(`   🔄 Fallback models: ${fallbackConfigs.map((f, i) => `#${i + 1} ${f.label}`).join(', ')}`);
    }

    // Helper to create an LLM client from a fallback config
    async function createClientForFallback(fb: FallbackConfig): Promise<{ client: { streamChat: LLMClient['streamChat'] }; settings: LLMSettings }> {
      const fbSettings: LLMSettings = { ...llmSettings, model: fb.model };

      // Clear enableThinking inherited from the primary model — it causes
      // chat_template_kwargs to be sent to backends that don't support it
      // (e.g., LM Studio's Qwen template breaks tool calling with this flag).
      // Only re-add if the fallback's own profile explicitly sets it.
      fbSettings.enableThinking = undefined;

      // Apply the fallback model's profile (temperature, topP, etc.) instead of
      // inheriting the primary model's tuning which may be wrong for this model.
      const userProfiles = (settings?.modelProfiles as LLMModelProfile[]) || [];
      const fbProfile = findLLMProfile(fb.model, userProfiles);
      if (fbProfile) {
        if (fbProfile.temperature !== undefined) fbSettings.temperature = fbProfile.temperature;
        if (fbProfile.topP !== undefined) fbSettings.topP = fbProfile.topP;
        if (fbProfile.maxTokens !== undefined) fbSettings.maxTokens = fbProfile.maxTokens;
        if (fbProfile.topK !== undefined) fbSettings.topK = fbProfile.topK;
        if (fbProfile.frequencyPenalty !== undefined) fbSettings.frequencyPenalty = fbProfile.frequencyPenalty;
        if (fbProfile.presencePenalty !== undefined) fbSettings.presencePenalty = fbProfile.presencePenalty;
        if (fbProfile.repetitionPenalty !== undefined) fbSettings.repetitionPenalty = fbProfile.repetitionPenalty;
        if (fbProfile.enableThinking !== undefined) fbSettings.enableThinking = fbProfile.enableThinking;
        console.log(`   📋 Applied profile for fallback model ${fb.model}`);
      } else {
        // No profile found — reset sampling params to safe defaults so the
        // fallback doesn't inherit the primary model's potentially aggressive tuning
        fbSettings.presencePenalty = 0;
        fbSettings.frequencyPenalty = 0;
      }

      if (fb.providerId) {
        const provider = providers.find((p: LLMProviderConfig) => p.id === fb.providerId);
        if (provider) {
          fbSettings.endpoint = provider.endpoint;
          if (provider.type === 'anthropic') {
            // Reset sampling params to Anthropic defaults — don't inherit
            // the primary local model's topP/topK which cause API errors
            fbSettings.temperature = 0.7;
            delete (fbSettings as Partial<LLMSettings>).topP;
            delete fbSettings.topK;
            delete fbSettings.repetitionPenalty;
            const { AnthropicClient } = await import('@/lib/anthropic-client');
            return { client: new AnthropicClient(fbSettings, provider.apiKey || '', provider.endpoint), settings: fbSettings };
          }
          return { client: new LLMClient(fbSettings, provider.apiKey || undefined), settings: fbSettings };
        }
      }
      // Local model fallback — use the pre-provider local endpoint (LM Studio),
      // NOT llmSettings.endpoint which may point to NVIDIA/Anthropic after provider assignment
      fbSettings.endpoint = localLMStudioEndpoint;
      console.log(`   🔧 Local fallback: endpoint=${localLMStudioEndpoint}, model=${fb.model}`);
      return { client: new LLMClient(fbSettings), settings: fbSettings };
    }

    // Add current user message
    currentMessages.push({ role: 'user', content: enrichedMessage });

    // Log history sent to LLM for debugging conversation continuity
    const histMsgs = currentMessages.filter(m => m.role !== 'system');
    console.log(`   📜 History for "${choom.name}": ${histMsgs.length} messages (${compactionWasPerformed ? `compacted, ${compactionStats.messagesDropped} dropped` : 'uncompacted'})`);
    for (let i = 0; i < histMsgs.length; i++) {
      const m = histMsgs[i];
      console.log(`      [${i}] ${m.role}: ${(m.content || '').slice(0, 120)}${(m.content || '').length > 120 ? '...' : ''} (${(m.content || '').length} chars)`);
    }

    // Create streaming response. The whole turn — SSE plumbing, planner,
    // agentic loop, and finalize (assistant-message save, token usage,
    // execution trace) — lives in lib/chat-stream.ts + lib/agentic-loop.ts
    // (C-22 POST split). Prep above resolves everything the turn needs.
    const stream = new ReadableStream({
      async start(controller) {
        await runChatTurn({
          controller,
          choom, chat, choomId, chatId, logChatId, message,
          settings, clientLLMSettings, providers,
          isDelegation: !!isDelegation,
          suppressNotifications: !!suppressNotifications,
          noTools: !!noTools,
          maxIterationsOverride,
          isHeartbeat: !!isHeartbeat,
          isGroupTurn, freshContext, delegatorName, groupRoomId,
          taskModelOverride, taskOverrideActive,
          autoSetProjectInfo, detectedProject, choomMaxIterations, skillDispatch,
          memoryClient, memoryCompanionId, weatherSettings,
          llmClient, llmSettings, activeTools,
          usingCloudProvider, activeProviderId, fallbackConfigs, createClientForFallback,
          currentMessages, systemPromptWithSummary, compactionService,
          compactionWasPerformed, compactionStats,
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('❌ Chat API error:', error instanceof Error ? error.message : error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
