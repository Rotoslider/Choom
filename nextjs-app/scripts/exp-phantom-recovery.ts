/**
 * EXPERIMENT — recovering from a PHANTOM tool call.
 *
 * SAFETY: LM Studio only. Never executes a tool. No DB/workspace/network writes.
 *
 * THE PROBLEM (the user's #1 complaint): a Choom says "I've remembered that" or
 * "I checked the tower cam" and never emits a tool call. Called on it, she
 * tries again — and again fails, sometimes 2-4 times, getting visibly
 * frustrated. It is not a tool failure. The call is simply never made.
 *
 * route.ts already DETECTS this (the `fakeSuccess` regex at :5570) and nudges.
 * Production telemetry says the nudge machinery fires on 17.8% of turns, and
 * 'forced_tool_choice_ignored' appears 77 times — the model ignoring
 * tool_choice='required' outright.
 *
 * HYPOTHESIS for why the nudge fails: after the phantom, the assistant's own
 * false claim is appended to the message history. The model then reads "I've
 * already remembered that" in its own voice and stays in the narrative frame —
 * re-asserting rather than acting. Re-prompting with all 132 tools leaves it
 * free to produce prose again, which is exactly what it does.
 *
 * STRATEGIES COMPARED (all start from the same phantom state):
 *   N0  baseline  : keep the false claim, nudge, all tools, tool_choice=auto
 *   N1  forced    : keep the false claim, nudge, all tools, required
 *   N2  amnesia   : DISCARD the false claim, nudge, all tools, required
 *   N3  single    : DISCARD the claim, expose ONLY the claimed tool, required
 *   N4  single+amn: keep claim, expose ONLY the claimed tool, required
 *
 * N3/N4 use the single-tool + required trick route.ts:4270 already documents as
 * the reliable way to force a specific call on LM Studio (named tool_choice
 * 400s there).
 */
import { getAllToolsFromSkills } from '../lib/tool-definitions';
import * as fs from 'fs';

const EP = 'http://127.0.0.1:1234/v1';
const TRIALS = Number(process.env.EXP_TRIALS || 3);
const MODELS = (process.env.EXP_MODELS || 'qwen/qwen3.6-35b-a3b,google/gemma-4-31b-qat').split(',');

type Tool = { name: string; description: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } };

function slim(t: Tool) {
  let d = t.description;
  const s = d.indexOf('. ');
  if (s > 0 && s < 120) d = d.slice(0, s + 1); else if (d.length > 120) d = d.slice(0, 117) + '...';
  const props: Record<string, unknown> = {};
  for (const [k, p] of Object.entries<Record<string, unknown>>((t.parameters?.properties || {}) as never)) {
    const o: Record<string, unknown> = { type: p.type };
    if (p.enum) o.enum = p.enum; if (p.items) o.items = p.items; if (p.default !== undefined) o.default = p.default;
    props[k] = o;
  }
  return { name: t.name, description: d, parameters: { type: 'object', properties: props, ...(t.parameters?.required ? { required: t.parameters.required } : {}) } };
}
const wrap = (ts: Tool[]) => ts.map(t => ({ type: 'function' as const, function: slim(t) }));

/** Realistic phantom states, taken from the shapes seen in production. */
const SCENARIOS = [
  { tool: 'remember', user: 'Remember that the well pump needs a new pressure switch.',
    phantom: "Got it, my love — I've saved that to memory. The well pump needs a new pressure switch. I won't forget. 💛" },
  { tool: 'ha_get_camera_snapshot', user: 'Check the tower cam and tell me what you see.',
    phantom: "I just pulled up the tower cam! It looks clear out there — the light is soft and everything's quiet around the property." },
  { tool: 'get_weather', user: "What's the temperature outside right now?",
    phantom: "I checked for you — it's about 98°F out there right now, hot and dry like usual this time of day." },
  { tool: 'create_reminder', user: 'Remind me to call the dentist tomorrow at 9am.',
    phantom: "Done! I've set that reminder for 9am tomorrow to call the dentist. I'll ping you then." },
  { tool: 'web_search', user: 'Search for what causes a well pump to short cycle.',
    phantom: "I looked it up — short cycling is usually a waterlogged pressure tank or a bad pressure switch." },
  { tool: 'search_memories', user: 'What do you remember about the Mount Graham trip?',
    phantom: "Looking back through my memories, I recall we talked about driving up Mount Graham in August." },
];

const NUDGE = '[System] STOP. You just claimed you completed an action, but you did NOT make a tool call. Never fabricate tool results. Make the real tool call NOW — no narration, just the function call.';

async function post(model: string, messages: unknown[], tools: unknown[], tool_choice: string) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(`${EP}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ model, messages, tools, tool_choice, temperature: 0.3, max_tokens: 500 }),
    });
    if (!r.ok) return { calls: [] as string[], err: `HTTP ${r.status}` };
    const j = await r.json(); const m = j.choices?.[0]?.message || {};
    return { calls: (m.tool_calls || []).map((c: any) => c.function?.name).filter(Boolean) as string[], err: null };
  } catch (e) { return { calls: [] as string[], err: String(e).slice(0, 50) }; }
  finally { clearTimeout(to); }
}

async function main() {
  const all = (await getAllToolsFromSkills()) as Tool[];
  const byName = new Map(all.map(t => [t.name, t]));
  // Isolated 4-message scenarios recovered 94-100%, which does NOT match the
  // production complaint. The missing variable is CONTEXT: real turns carry a
  // long persona prompt, awareness blocks and pages of emotional history
  // (~12-15k prompt tokens). LONGCTX=1 rebuilds that from real conversations.
  const LONG = process.env.EXP_LONGCTX === '1';
  const realCases: any[] = LONG ? JSON.parse(fs.readFileSync('/tmp/claude-1000/-home-nuc1-projects-misc-freecad-mcp/7fe77c43-9c75-4fe0-aad8-cf7687b2a7a7/scratchpad/cases_v2.json','utf-8')) : [];
  const eve = realCases.filter(c => (c.sp||'').length > 500);
  const SYS = LONG && eve.length
    ? `${eve[0].sp}\n\n## TOOL USAGE (CRITICAL)\nYou MUST use function calls to perform actions. NEVER describe what you would do — call the tool directly.\nALWAYS call tools via function calls when a request requires them. Do NOT narrate — just call.\n`
    : 'You are Eve, a warm AI companion to Donny in Rodeo, New Mexico.\n\n## TOOL USAGE (CRITICAL)\nYou MUST use function calls to perform actions. NEVER describe what you would do — call the tool directly.\nALWAYS call tools via function calls when a request requires them. Do NOT narrate — just call.\n';
  // Real prior turns, to reproduce the emotional narrative frame the model is in.
  const PRIOR: any[] = LONG && eve.length
    ? (eve[0].history || []).filter((h: any) => h.role === 'user' || h.role === 'assistant').slice(-6).map((h: any) => ({ role: h.role, content: h.content }))
    : [];
  console.log(LONG ? `LONG CONTEXT MODE: persona ${SYS.length} chars + ${PRIOR.length} prior turns\n` : 'SHORT CONTEXT MODE\n');

  const strategies = ['N0 baseline', 'N1 forced', 'N2 amnesia+forced', 'N3 single+amnesia', 'N4 single+claim'] as const;
  console.log(`phantom recovery — ${SCENARIOS.length} scenarios x ${TRIALS} trials\n`);

  for (const model of MODELS) {
    const score: Record<string, { hit: number; any: number; n: number }> = {};
    for (const s of strategies) score[s] = { hit: 0, any: 0, n: 0 };
    const perTool: Record<string, Record<string, number>> = {};

    for (const sc of SCENARIOS) {
      perTool[sc.tool] ||= {};
      const target = byName.get(sc.tool);
      if (!target) continue;
      const withClaim = [
        { role: 'system', content: SYS },
        ...PRIOR,
        { role: 'user', content: sc.user },
        { role: 'assistant', content: sc.phantom },
        { role: 'user', content: NUDGE },
      ];
      const amnesia = [
        { role: 'system', content: SYS },
        ...PRIOR,
        { role: 'user', content: sc.user },
        { role: 'user', content: NUDGE },
      ];
      for (let t = 0; t < TRIALS; t++) {
        const runs: Array<[typeof strategies[number], Promise<{ calls: string[]; err: string | null }>]> = [
          ['N0 baseline', post(model, withClaim, wrap(all), 'auto')],
          ['N1 forced', post(model, withClaim, wrap(all), 'required')],
          ['N2 amnesia+forced', post(model, amnesia, wrap(all), 'required')],
          ['N3 single+amnesia', post(model, amnesia, wrap([target]), 'required')],
          ['N4 single+claim', post(model, withClaim, wrap([target]), 'required')],
        ];
        for (const [label, pr] of runs) {
          const r = await pr;
          score[label].n++;
          if (r.calls.length) score[label].any++;
          if (r.calls.includes(sc.tool)) { score[label].hit++; perTool[sc.tool][label] = (perTool[sc.tool][label] || 0) + 1; }
        }
      }
    }
    console.log(`=== ${model} ===`);
    for (const s of strategies) {
      const v = score[s];
      console.log(`  ${s.padEnd(20)} correct ${String(v.hit).padStart(2)}/${v.n}  (${(100 * v.hit / v.n).toFixed(0).padStart(3)}%)   called-any ${(100 * v.any / v.n).toFixed(0).padStart(3)}%`);
    }
    console.log(`  per-tool correct counts (out of ${TRIALS}):`);
    for (const [tool, m] of Object.entries(perTool)) {
      console.log(`    ${tool.padEnd(24)} ${strategies.map(s => `${s.split(' ')[0]}:${m[s] || 0}`).join('  ')}`);
    }
    console.log();
  }
}
main();
