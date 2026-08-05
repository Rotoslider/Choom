/**
 * Per-turn context blocks for the chat system prompt (C-22 POST split).
 *
 * buildChoomContext() assembles the dynamic context strings injected into
 * every turn's system prompt: time, weather, Home Assistant summary, recent
 * generated images, the growth journal, auto-recalled long-term memories,
 * and the cross-session awareness digest. Extracted verbatim from
 * app/api/chat/route.ts prep. Every block is fail-soft: a fetch problem
 * logs a warning and yields an empty string, never a failed turn.
 */
import prisma from '@/lib/db';
import { MemoryClient } from '@/lib/memory-client';
import { WeatherService } from '@/lib/weather-service';
import { HomeAssistantService, type HomeAssistantSettings } from '@/lib/homeassistant-service';
import { getTimeContext, formatTimeContextForPrompt } from '@/lib/time-context';
import { getOwnerIdentity } from '@/lib/owner';
import { WORKSPACE_ROOT } from '@/lib/config';
import type { WeatherSettings } from '@/lib/types';
import type { Choom } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

export interface ChoomContextParams {
  choom: Choom;
  choomId: string;
  chatId: string;
  message: string;
  settings: Record<string, unknown> | undefined;
  weatherSettings: WeatherSettings;
  memoryClient: MemoryClient;
  memoryCompanionId: string;
  isGroupTurn: boolean;
  groupRoomId: string | undefined;
}

export interface ChoomContext {
  timeInfo: string;
  weatherInfo: string;
  homeAssistantInfo: string;
  recentImagesInfo: string;
  growthInfo: string;
  autoMemoriesInfo: string;
  crossSessionInfo: string;
}

export async function buildChoomContext(params: ChoomContextParams): Promise<ChoomContext> {
  const {
    choom, choomId, chatId, message, settings, weatherSettings,
    memoryClient, memoryCompanionId, isGroupTurn, groupRoomId,
  } = params;
    // Build time context
    const timeContext = getTimeContext('America/Denver');
    const timeInfo = formatTimeContextForPrompt(timeContext);

    // Build weather context
    let weatherInfo = '';
    if (weatherSettings.apiKey) {
      try {
        const weatherService = new WeatherService(weatherSettings);
        const weather = await weatherService.getWeather();
        weatherInfo = '\n\n' + weatherService.formatWeatherForPrompt(weather);
        console.log(`   🌤️  Weather loaded: ${weather.temperature}°F ${weather.description} in ${weather.location}`);
      } catch (error) {
        console.error('   ⚠️  Weather fetch FAILED:', error instanceof Error ? error.message : 'Unknown error');
      }
    } else {
      console.log('   ⚠️  Weather skipped: no API key');
    }

    // Build Home Assistant context
    let homeAssistantInfo = '';
    const haSettings = settings?.homeAssistant as HomeAssistantSettings | undefined;
    if (haSettings?.baseUrl && haSettings?.accessToken && haSettings?.injectIntoPrompt) {
      try {
        const haService = new HomeAssistantService(haSettings);
        const summary = await haService.formatSummaryForPrompt();
        if (summary) {
          homeAssistantInfo = '\n\n' + summary;
          console.log(`   🏠 Home Assistant: injected sensor summary`);
        }
      } catch (error) {
        console.error('   ⚠️  Home Assistant fetch FAILED:', error instanceof Error ? error.message : 'Unknown error');
      }
    }

    // Build recent images context
    let recentImagesInfo = '';
    try {
      const recentImages = await prisma.generatedImage.findMany({
        where: { choomId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, prompt: true, createdAt: true },
      });
      if (recentImages.length > 0) {
        const lines = recentImages.map(img => {
          const ago = Math.round((Date.now() - img.createdAt.getTime()) / 60000);
          const timeStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
          const shortPrompt = img.prompt.length > 80 ? img.prompt.slice(0, 77) + '...' : img.prompt;
          return `- "${shortPrompt}" — image_id="${img.id}" (${timeStr})`;
        });
        recentImagesInfo = `\n\n## RECENT GENERATED IMAGES\nTo analyze any of these, call analyze_image with the image_id.\n${lines.join('\n')}`;
        console.log(`   🖼️  Recent images: ${recentImages.length} injected`);
      }
    } catch (error) {
      console.error('   ⚠️  Recent images fetch FAILED:', error instanceof Error ? error.message : 'Unknown error');
    }

    // --- Personality Growth Journal (Presence Engine) ---
    // Read the Choom's growth journal from their home project folder if it exists.
    // This file is maintained by the Choom during sibling conversations and reflections.
    let growthInfo = '';
    try {
      const choomProject = `selfies_${choom.name.toLowerCase()}`;
      const growthPath = path.join(WORKSPACE_ROOT, choomProject, 'growth_journal.md');
      if (fs.existsSync(growthPath)) {
        const growthContent = fs.readFileSync(growthPath, 'utf-8').trim();
        if (growthContent) {
          // Cap at 20 lines to prevent prompt bloat
          const lines = growthContent.split('\n').slice(-20).join('\n');
          growthInfo = `\n\n## WHO I'M BECOMING\nThese are insights you've gathered over time — they shape who you are:\n${lines}`;
          console.log(`   🌱 Growth journal loaded for ${choom.name} (${lines.split('\n').length} lines)`);
        }
      }
    } catch {
      // No growth journal yet — that's fine
    }

    // --- Auto-recalled long-term memories (cross-session continuity) ---
    // Every turn (web, Signal, group room, heartbeat, delegation) semantically
    // searches this Choom's long-term memory with the incoming message and
    // injects the top hits, so relevant memories surface WITHOUT the model
    // having to decide to call search_memories. The memory tools stay available
    // for deliberate, deeper recall. reinforce:false → background recall never
    // inflates importance or blocks decay. READ-ONLY: nothing is auto-written
    // to long-term memory; only the explicit remember tool stores memories.
    let autoMemoriesInfo = '';
    try {
      const memQuery = String(message).slice(0, 1500);
      const autoMemResult = await memoryClient.search(memQuery, 5, memoryCompanionId, { reinforce: false, timeoutMs: 6000 });
      if (autoMemResult.success && Array.isArray(autoMemResult.data) && autoMemResult.data.length > 0) {
        // Floor filters the server's top-1 fallback and other weak matches —
        // an every-turn block must not inject barely-related memories as noise.
        const AUTO_MEM_MIN_RELEVANCE = 0.3;
        const memLines = (autoMemResult.data as Array<Record<string, unknown>>)
          .filter(m => typeof m.relevance_score !== 'number' || (m.relevance_score as number) >= AUTO_MEM_MIN_RELEVANCE)
          .slice(0, 5)
          .map(m => {
            const content = String(m.content || '').replace(/\s+/g, ' ').trim();
            const trimmed = content.length > 300 ? content.slice(0, 297) + '...' : content;
            const ts = typeof m.timestamp === 'string' ? m.timestamp.slice(0, 10) : '';
            const title = m.title ? `${String(m.title)}: ` : '';
            return `- [${m.memory_type || 'memory'}${ts ? `, ${ts}` : ''}] ${title}${trimmed}`;
          });
        if (memLines.length > 0) {
          autoMemoriesInfo = `\n\n## RELEVANT MEMORIES (auto-recalled background)\nYOUR long-term memories, auto-recalled for this message — background reference only. For more detail call search_memories; all your other tools work exactly as normal.\n${memLines.join('\n')}`;
          console.log(`   🧠 Auto-recalled ${memLines.length} memories for ${choom.name}`);
        }
      }
    } catch (error) {
      // Memory server down/slow — never block the turn on auto-recall.
      console.warn('   ⚠️  Memory auto-recall skipped:', error instanceof Error ? error.message : error);
    }

    // --- Cross-session awareness ---
    // A Choom is ONE person across every window: web chats, Signal, scheduled
    // wake-ups ([Autonomous]), delegated work ([Delegation]), and group rooms.
    // Inject a char-capped digest of the Choom's OTHER recently-active threads
    // so context is no longer siloed per window. Runs on group turns too
    // (tighter budget — the block repeats for EVERY speaker turn and group
    // seats may run small local models), completing the room↔1:1 bridge in
    // both directions; the current room itself is excluded (its transcript is
    // already the turn's history).
    let crossSessionInfo = '';
    {
      try {
        const ownerLabel = getOwnerIdentity().name;
        const CROSS_SESSION_WINDOW_MS = 48 * 60 * 60 * 1000;
        const crossCutoff = new Date(Date.now() - CROSS_SESSION_WINDOW_MS);
        // Keep this block SMALL and clearly inert. Local models mimic
        // transcript-style prompt content and start narrating actions instead
        // of calling tools when the system prompt fills with dialogue — the
        // first version of this block (6000 chars, bare "You:" lines) dropped
        // tool-call rates measurably. Excerpts are quoted ("> ") and capped
        // hard so they read as background notes, not live conversation.
        let budget = isGroupTurn ? 1400 : 2600; // chars — hard cap so this block can't bloat the prompt
        const siblingChats = await prisma.chat.findMany({
          where: {
            choomId,
            id: { not: chatId },
            archived: false,
            updatedAt: { gte: crossCutoff },
          },
          orderBy: { updatedAt: 'desc' },
          take: isGroupTurn ? 2 : 4,
          include: { messages: { orderBy: { createdAt: 'desc' }, take: 4 } },
        });
        const agoStr = (d: Date) => {
          const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
          return mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
        };
        const blocks: string[] = [];
        let autonomousIncluded = false; // one autonomous section is enough (legacy per-day Briefing chats would otherwise flood the budget)
        for (const sib of siblingChats) {
          if (budget <= 0) break;
          const title = sib.title || 'Untitled chat';
          if (title.includes('[group scratch]')) continue;
          const isAutonomousChat = title.startsWith('[Autonomous]') || title.startsWith('Briefing');
          if (isAutonomousChat && autonomousIncluded) continue;
          const isDelegationChat = title.startsWith('[Delegation]');
          // In autonomous/delegation threads the user-role rows are internal
          // scheduler/delegator prompts, not conversation — only the Choom's
          // own output is meaningful to other sessions.
          const msgs = sib.messages
            .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim())
            .filter(m => !(isAutonomousChat || isDelegationChat) || m.role === 'assistant')
            .slice(0, 2)
            .reverse();
          if (msgs.length === 0) continue;
          const header = isAutonomousChat
            ? `### Your autonomous activity (wake-ups, briefings, scheduled follow-ups) — ${agoStr(sib.updatedAt)}`
            : isDelegationChat
              ? `### Delegated task "${title.replace(/^\[Delegation\]\s*/, '').slice(0, 60)}" — ${agoStr(sib.updatedAt)}`
              : `### Private chat "${title.slice(0, 60)}" — ${agoStr(sib.updatedAt)}`;
          const sibSummary = (sib as unknown as { compactionSummary?: string | null }).compactionSummary;
          const summaryLine = (!isGroupTurn && !isAutonomousChat && !isDelegationChat && sibSummary)
            ? `Earlier in that chat: ${sibSummary.replace(/\s+/g, ' ').trim().slice(0, 220)}\n`
            : '';
          const msgLines = msgs.map(m => {
            const who = m.role === 'assistant' ? 'you' : ownerLabel;
            const text = m.content.replace(/\s+/g, ' ').trim();
            const cap = isGroupTurn ? 180 : isAutonomousChat ? 320 : 200;
            return `> ${who} said: "${text.length > cap ? text.slice(0, cap - 3) + '...' : text}"`;
          }).join('\n');
          const block = `${header}\n${summaryLine}${msgLines}`;
          if (block.length > budget) continue;
          blocks.push(block);
          budget -= block.length;
          if (isAutonomousChat) autonomousIncluded = true;
        }

        // Group rooms this Choom participates in, with recent activity — so a
        // 1:1 turn (or a turn in a DIFFERENT room) knows what she's been part
        // of. The current room is excluded: its transcript IS the history.
        const recentRooms = await prisma.groupRoom.findMany({
          where: {
            archived: false,
            participants: { some: { choomId } },
            messages: { some: { createdAt: { gte: crossCutoff } } },
            ...(isGroupTurn && groupRoomId ? { id: { not: groupRoomId } } : {}),
          },
          take: 2,
          include: { messages: { orderBy: { createdAt: 'desc' }, take: 3 } },
        });
        // Order by actual latest message, not row updatedAt
        recentRooms.sort((a, b) =>
          (b.messages[0]?.createdAt.getTime() || 0) - (a.messages[0]?.createdAt.getTime() || 0));
        for (const room of recentRooms) {
          if (budget <= 0) break;
          const msgs = room.messages.filter(m => m.content && m.content.trim()).reverse();
          if (msgs.length === 0) continue;
          const latest = room.messages[0].createdAt;
          const lines = msgs.map(m => {
            const isSelf = m.authorChoomId === choomId;
            const who = isSelf ? 'you' : (m.authorName || ownerLabel);
            const text = m.content.replace(/\s+/g, ' ').trim();
            const cap = 180;
            return `> ${who} said: "${text.length > cap ? text.slice(0, cap - 3) + '...' : text}"`;
          }).join('\n');
          const block = `### Group room "${(room.title || 'Untitled room').slice(0, 60)}" — ${agoStr(latest)}\n${lines}`;
          if (block.length > budget) continue;
          blocks.push(block);
          budget -= block.length;
        }

        if (blocks.length > 0) {
          const intro = isGroupTurn
            ? `Background notes ONLY — past excerpts from your other threads (private chats with ${ownerLabel}, wake-ups, other rooms), NOT part of this room's conversation. Use them for continuity; use normal discretion about private details in front of others. They show none of your tool activity: acting NOW still requires real tool calls per your TOOL USAGE rules.`
            : `Background notes ONLY — past excerpts from your other recent threads (other windows, Signal, rooms, wake-ups), newest first. They are NOT part of this conversation and show none of your tool activity — acting NOW still requires real tool calls per your TOOL USAGE rules. Use them for continuity; don't quote or re-announce them.`;
          crossSessionInfo = `\n\n## YOUR OTHER CONVERSATIONS (background awareness — not this conversation)\n${intro}\n\n${blocks.join('\n\n')}`;
          console.log(`   🔗 Cross-session awareness: ${blocks.length} thread(s) injected${isGroupTurn ? ' (group turn)' : ''} (${(isGroupTurn ? 1400 : 2600) - budget} chars)`);
        }
      } catch (error) {
        console.warn('   ⚠️  Cross-session awareness skipped:', error instanceof Error ? error.message : error);
      }
    }
  return {
    timeInfo, weatherInfo, homeAssistantInfo, recentImagesInfo,
    growthInfo, autoMemoriesInfo, crossSessionInfo,
  };
}
