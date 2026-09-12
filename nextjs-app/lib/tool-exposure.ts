/**
 * Tool exposure: which tool definitions a turn sends to the model.
 *
 * Phase 2 of the context plan ("Room to Think", 2026-09-12). Every turn used
 * to send all ~136 tools — 57k chars slimmed, ~14k tokens, on EVERY iteration
 * — and a 4B-active local model had to pick among near-synonyms
 * (workspace_read_file / read_document / workspace_read_pdf / download_from_drive).
 * The skill layer already has the right shape: a one-line summary per skill
 * is always in the prompt (the menu), and full docs are pulled for the skills
 * that match the message. In `skills` mode the tools array follows the same
 * logic:
 *
 *   exposed = CORE ∪ tools(skills matched to the message)
 *                  ∪ tools used earlier in this chat
 *                  ∪ tools of skills opened with open_skill
 *
 * `open_skill(name)` loads a skill's tools for the rest of the turn and
 * returns its instructions, so nothing is unreachable — it is one call away
 * instead of one token away. Cloud models keep `full` exposure; the mode is a
 * per-model profile field (LLMModelProfile.toolExposure) with a client
 * settings override, so it can be turned on for one Choom on one model and
 * compared in the traces (maxPromptTokens, toolFailureCount, nudgeTypes).
 */
import type { ToolDefinition } from '@/lib/types';
import type { SkillRegistry } from '@/lib/skill-registry';

export type ToolExposure = 'full' | 'skills';

export const OPEN_SKILL_TOOL = 'open_skill';

/**
 * Always exposed in skills mode: what a companion reaches for on most turns —
 * memory, the house, the calendar, images, her workspace, her sisters, and
 * the meta tool that opens everything else. Path-specific strips (rooms,
 * delegation, non-heartbeat) still apply on top of this list.
 */
export const CORE_TOOLS: ReadonlyArray<string> = [
  OPEN_SKILL_TOOL,
  // memory
  'search_memories', 'remember', 'get_recent_memories',
  // time, weather, calendar, reminders
  'get_weather', 'get_calendar_events', 'create_reminder',
  // the house
  'ha_get_home_status', 'ha_get_camera_snapshot',
  // images
  'generate_image', 'save_generated_image', 'analyze_image',
  // workspace
  'workspace_list_files', 'workspace_read_file', 'workspace_write_file',
  // reaching out and her own future
  'send_notification', 'heartbeat_complete',
  'schedule_self_followup', 'schedule_room_followup', 'list_self_followups',
  'list_my_rooms', 'talk_with_sisters', 'delegate_to_choom',
  // the web
  'web_search',
];

export interface ExposureInput {
  /** The turn's tool set after every path-specific strip. */
  activeTools: ToolDefinition[];
  registry: Pick<SkillRegistry, 'matchSkills' | 'getSkill' | 'getSkillNames' | 'getSkillForTool'>;
  /** The user message (or room transcript) the skill matcher scores. */
  message: string;
  /** Tool names called earlier in this chat (from stored assistant messages). */
  historyToolNames: Iterable<string>;
  /** Skills already opened this turn / chat. */
  openedSkills?: Iterable<string>;
  /** How many skills the message matcher may add (default 3). */
  maxMatchedSkills?: number;
}

export interface ExposureResult {
  tools: ToolDefinition[];
  matchedSkills: string[];
  fromHistory: string[];
  hiddenCount: number;
}

/** Build the skills-mode tool set. Pure apart from the registry lookups. */
export function buildExposedTools(input: ExposureInput): ExposureResult {
  const { activeTools, registry, message } = input;
  const byName = new Map(activeTools.map(t => [t.name, t]));
  const exposed = new Set<string>();
  const add = (name: string) => { if (byName.has(name)) exposed.add(name); };

  for (const name of CORE_TOOLS) add(name);

  const matched = registry.matchSkills(message, input.maxMatchedSkills ?? 3);
  const matchedSkills: string[] = [];
  for (const skill of matched) {
    matchedSkills.push(skill.metadata.name);
    for (const t of skill.toolDefinitions) add(t.name);
  }

  const fromHistory: string[] = [];
  for (const name of input.historyToolNames) {
    if (byName.has(name) && !exposed.has(name)) fromHistory.push(name);
    add(name);
  }

  for (const skillName of input.openedSkills ?? []) {
    const skill = registry.getSkill(skillName);
    if (skill) for (const t of skill.toolDefinitions) add(t.name);
  }

  // Keep the original order so the schema prefix stays stable across turns
  // (a stable prefix is what lets a local server reuse its KV cache).
  const tools = activeTools.filter(t => exposed.has(t.name));
  return { tools, matchedSkills, fromHistory, hiddenCount: activeTools.length - tools.length };
}

/** Tool names called in stored assistant messages, newest first, deduped. */
export function toolNamesFromHistory(
  messages: Array<{ role: string; toolCalls?: string | null }>,
  maxMessages: number = 40,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const recent = messages.filter(m => m.role === 'assistant' && m.toolCalls).slice(-maxMessages).reverse();
  for (const m of recent) {
    let calls: unknown;
    try { calls = JSON.parse(m.toolCalls as string); } catch { continue; }
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      const n = (c as { name?: unknown })?.name;
      if (typeof n === 'string' && n && !seen.has(n)) { seen.add(n); names.push(n); }
    }
  }
  return names;
}

/**
 * The open_skill definition, with the live skill list in its enum so a model
 * cannot invent a skill name. Built per request; the static definition in the
 * skill's tools.ts is the fallback shape.
 */
export function openSkillToolDefinition(skillNames: string[]): ToolDefinition {
  return {
    name: OPEN_SKILL_TOOL,
    description: 'Load another skill\'s tools for this conversation and read its instructions. Only some tools are loaded at a time; the AVAILABLE SKILLS list in your instructions shows which skill holds which tool. Call this first when you need a tool that is not currently available, then call the tool.',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name exactly as listed under AVAILABLE SKILLS',
          enum: skillNames,
        },
      },
      required: ['skill'],
    },
  };
}

/** The sentence added to the prompt in skills mode so the model knows the menu is bigger than the tray. */
export function skillsModeNote(exposedCount: number, totalCount: number, matchedSkills: string[]): string {
  const matched = matchedSkills.length ? ` Loaded for this message: ${matchedSkills.join(', ')}.` : '';
  return `\n\n## TOOLS LOADED NOW\n${exposedCount} of ${totalCount} tools are loaded for this turn (your core tools plus the skills relevant to the message).${matched} Every other tool in the AVAILABLE SKILLS list is one call away: call open_skill with the skill name, then use the tool. Never say a tool is unavailable — open its skill.`;
}

/**
 * Registry tool names a reply mentions that are NOT in the exposed set —
 * "let me check music_now_playing" from a model that cannot see that tool.
 * The loop opens those skills instead of nudging her to "call the tool NOW".
 */
export function unexposedToolMentions(
  text: string,
  exposedNames: Set<string>,
  registry: Pick<SkillRegistry, 'getSkillForTool'>,
  allToolNames: Iterable<string>,
): Array<{ tool: string; skill: string }> {
  const lower = text.toLowerCase();
  const out: Array<{ tool: string; skill: string }> = [];
  const seenSkills = new Set<string>();
  for (const name of allToolNames) {
    if (exposedNames.has(name)) continue;
    if (!lower.includes(name)) continue;
    const skill = registry.getSkillForTool(name);
    if (!skill || seenSkills.has(skill.metadata.name)) continue;
    seenSkills.add(skill.metadata.name);
    out.push({ tool: name, skill: skill.metadata.name });
  }
  return out;
}
