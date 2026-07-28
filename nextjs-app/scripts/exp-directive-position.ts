/**
 * EXPERIMENT — where should the tool directive live in a long prompt?
 *
 * SAFETY: LM Studio only. Never executes a tool. No DB/workspace/network writes.
 *
 * THE PROBLEM the user described: "the tool calls or the instructions for tool
 * calls gets lost in the mess" once context is long. Compaction exists but is
 * not enough.
 *
 * WHY THAT WOULD HAPPEN. In production the "## TOOL USAGE (CRITICAL)" block
 * sits in the SYSTEM PROMPT at index 0. Then come the awareness blocks, the
 * skill docs, and pages of conversation. By the time the model generates, that
 * directive is ~13k tokens upstream, while the last thing it read was an
 * affectionate exchange. Transformers weight recent tokens heavily, so the
 * narrative frame wins and the model narrates instead of calling.
 *
 * This is the same reasoning that fixed the [Tool guidance] injection earlier
 * in this overhaul: guidance works where it is RECENT, not where it is first.
 *
 * CONDITIONS (identical long context, identical tools, only placement varies):
 *   P0  directive in the system prompt only            <- production today
 *   P1  system prompt + one-line reminder appended to the final user turn
 *   P2  system prompt + reminder as a separate last user message
 *   P3  directive ONLY at the end (removed from system)
 *   P4  system prompt + reminder naming the LIKELY tool for this request
 *
 * Scored on the 53 high-confidence cases where the user's message unambiguously
 * demands a tool, so "did not call" is unambiguously wrong.
 */
import { getAllToolsFromSkills } from '../lib/tool-definitions';
import * as fs from 'fs';

const CASES = '/tmp/claude-1000/-home-nuc1-projects-misc-freecad-mcp/7fe77c43-9c75-4fe0-aad8-cf7687b2a7a7/scratchpad/cases_v3.json';
const TRIALS = Number(process.env.EXP_TRIALS || 2);
const CONC = Number(process.env.EXP_CONC || 2);
const MODEL = process.env.EXP_MODEL || 'qwen/qwen3.6-35b-a3b';
const EP = process.env.EXP_EP || 'http://127.0.0.1:1234/v1';

type Tool = { name: string; description: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } };
type Case = { sp: string; history: Array<{ role: string; content: string }>; msg: string; firstTool: string; allTools: string[] };

const DIRECTIVE = `## TOOL USAGE (CRITICAL)
You MUST use function calls to perform actions. NEVER describe what you would do — call the tool directly.
Examples of WRONG behavior: "I'll search for that..." or "Let me check the weather..." (without a tool call)
ALWAYS call tools via function calls when a request requires them. Do NOT narrate — just call.`;
const REMINDER = '[Reminder] If this request needs a tool, call it NOW as a function call. Do not describe the action — perform it.';

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

async function post(messages: unknown[], tools: unknown[], tool_choice = 'auto') {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(`${EP}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice, temperature: 0.3, max_tokens: 500 }),
    });
    if (!r.ok) return { calls: [] as string[], tok: 0, err: `HTTP ${r.status}` };
    const j = await r.json(); const m = j.choices?.[0]?.message || {};
    return { calls: (m.tool_calls || []).map((c: any) => c.function?.name).filter(Boolean) as string[], tok: j.usage?.prompt_tokens || 0, err: null };
  } catch (e) { return { calls: [] as string[], tok: 0, err: String(e).slice(0, 50) }; }
  finally { clearTimeout(to); }
}
async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(xs.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]); } }));
  return out;
}

async function main() {
  const all = (await getAllToolsFromSkills()) as Tool[];
  const cases: Case[] = JSON.parse(fs.readFileSync(CASES, 'utf-8'));
  const tools = wrap(all);
  const hist = (c: Case) => c.history.filter(h => h.role === 'user' || h.role === 'assistant').map(h => ({ role: h.role, content: h.content }));

  const build = (c: Case, mode: string) => {
    const withDir = `${c.sp}\n\n${DIRECTIVE}\n`;
    const noDir = `${c.sp}\n`;
    switch (mode) {
      case 'P0': return [{ role: 'system', content: withDir }, ...hist(c), { role: 'user', content: c.msg }];
      case 'P1': return [{ role: 'system', content: withDir }, ...hist(c), { role: 'user', content: `${c.msg}\n\n${REMINDER}` }];
      case 'P2': return [{ role: 'system', content: withDir }, ...hist(c), { role: 'user', content: c.msg }, { role: 'user', content: REMINDER }];
      case 'P3': return [{ role: 'system', content: noDir }, ...hist(c), { role: 'user', content: c.msg }, { role: 'user', content: `${DIRECTIVE}\n${REMINDER}` }];
      case 'P4': return [{ role: 'system', content: withDir }, ...hist(c), { role: 'user', content: c.msg },
        { role: 'user', content: `[Reminder] This request maps to the "${c.firstTool}" tool. Call it NOW as a function call — do not describe it.` }];
      default: return [];
    }
  };

  const MODES = ['P0', 'P1', 'P2', 'P3', 'P4'];
  const score: Record<string, { hit: number; any: number; n: number; tok: number }> = {};
  for (const m of MODES) score[m] = { hit: 0, any: 0, n: 0, tok: 0 };
  const perTool: Record<string, Record<string, [number, number]>> = {};

  const jobs = cases.flatMap(c => Array.from({ length: TRIALS }, () => c));
  console.log(`model=${MODEL}  cases=${cases.length} x ${TRIALS} trials  (tool-demanding turns only)\n`);

  await mapLimit(jobs, CONC, async (c) => {
    const want = new Set([c.firstTool, ...c.allTools]);
    for (const m of MODES) {
      const r = await post(build(c, m), tools);
      score[m].n++; score[m].tok += r.tok;
      if (r.calls.length) score[m].any++;
      const hit = r.calls.some(x => want.has(x));
      if (hit) score[m].hit++;
      perTool[c.firstTool] ||= {};
      perTool[c.firstTool][m] ||= [0, 0];
      perTool[c.firstTool][m][1]++;
      if (hit) perTool[c.firstTool][m][0]++;
    }
  });

  const NAME: Record<string, string> = {
    P0: 'system prompt only (production)', P1: 'appended to final user turn',
    P2: 'separate last user message', P3: 'ONLY at the end', P4: 'names the likely tool',
  };
  console.log('  mode  placement                        correct   called-any   avg tok');
  for (const m of MODES) {
    const v = score[m];
    console.log(`  ${m}    ${NAME[m].padEnd(32)} ${(100 * v.hit / v.n).toFixed(1).padStart(5)}%   ${(100 * v.any / v.n).toFixed(1).padStart(5)}%   ${Math.round(v.tok / v.n)}`);
  }
  console.log('\n  per-tool correct (hit/total):');
  for (const [t, m] of Object.entries(perTool)) {
    console.log(`    ${t.padEnd(24)} ${MODES.map(x => `${x}:${m[x]?.[0] ?? 0}/${m[x]?.[1] ?? 0}`).join('  ')}`);
  }
}
main();
