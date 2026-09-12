/**
 * Phase 2 of the context plan (2026-09-12): skills-mode tool exposure.
 * Every turn used to send all ~136 tools (~14k tokens of schema per
 * iteration). In `skills` mode the tools array is a core set plus the skills
 * matched to the message, tools used earlier in the chat, and anything opened
 * with open_skill.
 */
jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));

import { getAllToolsFromSkills } from '@/lib/tool-definitions';
import { getSkillRegistry } from '@/lib/skill-registry';
import {
  buildExposedTools, toolNamesFromHistory, unexposedToolMentions, openSkillToolDefinition, CORE_TOOLS, OPEN_SKILL_TOOL,
} from '@/lib/tool-exposure';

const all = getAllToolsFromSkills();
const registry = getSkillRegistry();

describe('buildExposedTools', () => {
  test('a plain greeting exposes the core set and nothing else, and it is a fraction of the schema', () => {
    const r = buildExposedTools({ activeTools: all, registry, message: 'good morning, how did you sleep?', historyToolNames: [] });
    const names = r.tools.map(t => t.name);
    for (const core of CORE_TOOLS) expect(names).toContain(core);
    expect(names).not.toContain('music_play');
    expect(names).not.toContain('run_freecad_python');
    expect(r.tools.length).toBeLessThan(all.length / 3);
    expect(JSON.stringify(r.tools).length).toBeLessThan(JSON.stringify(all).length / 2.5);
  });

  test('the message pulls in matched skills', () => {
    const r = buildExposedTools({ activeTools: all, registry, message: 'play some music in the shop', historyToolNames: [] });
    expect(r.matchedSkills).toContain('music-assistant');
    expect(r.tools.map(t => t.name)).toContain('music_play');
  });

  test('tools used earlier in the chat come back', () => {
    const r = buildExposedTools({ activeTools: all, registry, message: 'thanks', historyToolNames: ['log_habit'] });
    expect(r.fromHistory).toEqual(['log_habit']);
    expect(r.tools.map(t => t.name)).toContain('log_habit');
  });

  test('a scheduler grounding prompt that names its tools gets them all', () => {
    const msg = 'Call search_memories to recall recent conversations. You also have get_weather, get_calendar_events, ha_get_home_status, list_self_followups and workspace_list_files.';
    const names = buildExposedTools({ activeTools: all, registry, message: msg, historyToolNames: [] }).tools.map(t => t.name);
    for (const n of ['search_memories', 'get_weather', 'get_calendar_events', 'ha_get_home_status', 'list_self_followups', 'workspace_list_files']) expect(names).toContain(n);
  });

  test('path strips still win: a tool removed before exposure stays removed', () => {
    const noSsh = all.filter(t => t.name !== 'run_ssh_command');
    const r = buildExposedTools({ activeTools: noSsh, registry, message: 'run_ssh_command on the nuc', historyToolNames: ['run_ssh_command'] });
    expect(r.tools.map(t => t.name)).not.toContain('run_ssh_command');
  });

  test('order is the original order, so the schema prefix is stable across turns', () => {
    const r = buildExposedTools({ activeTools: all, registry, message: 'hi', historyToolNames: [] });
    const idx = r.tools.map(t => all.findIndex(a => a.name === t.name));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe('helpers', () => {
  test('toolNamesFromHistory reads stored assistant tool calls newest first, deduped', () => {
    const msgs = [
      { role: 'assistant', toolCalls: JSON.stringify([{ name: 'get_weather' }]) },
      { role: 'user', toolCalls: null },
      { role: 'assistant', toolCalls: 'not json' },
      { role: 'assistant', toolCalls: JSON.stringify([{ name: 'log_habit' }, { name: 'get_weather' }]) },
    ];
    expect(toolNamesFromHistory(msgs)).toEqual(['log_habit', 'get_weather']);
  });

  test('unexposedToolMentions finds a named tool the model cannot see and maps it to its skill', () => {
    const exposed = new Set(CORE_TOOLS);
    const found = unexposedToolMentions('Let me check music_now_playing and then search_memories.', exposed, registry, all.map(t => t.name));
    expect(found).toEqual([{ tool: 'music_now_playing', skill: 'music-assistant' }]);
  });

  test('open_skill carries the live skill list as an enum', () => {
    const def = openSkillToolDefinition(['music-assistant', 'habit-tracker']);
    expect(def.name).toBe(OPEN_SKILL_TOOL);
    expect(def.parameters.properties.skill.enum).toEqual(['music-assistant', 'habit-tracker']);
  });

  test('the registry has open_skill and its handler returns tools and instructions', async () => {
    const skill = registry.getSkillForTool('open_skill');
    expect(skill?.metadata.name).toBe('skill-loader');
    const r = await skill!.handler.execute({ id: '1', name: 'open_skill', arguments: { skill: 'music-assistant' } }, {} as never);
    expect(r.error).toBeUndefined();
    expect((r.result as { tools_loaded: string[] }).tools_loaded).toContain('music_play');
    expect(String((r.result as { instructions: string }).instructions).length).toBeGreaterThan(50);
    const bad = await skill!.handler.execute({ id: '2', name: 'open_skill', arguments: { skill: 'no-such-skill' } }, {} as never);
    expect(bad.error).toMatch(/No skill named/);
  });
});
