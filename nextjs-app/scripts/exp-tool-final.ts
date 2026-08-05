/**
 * EXPERIMENT v3 — tool exposure, on cases where the answer is unambiguous.
 *
 * SAFETY: LM Studio only. Never executes a tool. No DB/workspace/network writes.
 *
 * WHY v3 EXISTS. v1 and v2 both produced an all-132 baseline too low to trust
 * (8.3%, then 25-37%). Instrumenting real turns showed the cause was not the
 * prompt and not a retry bug — it was the LABEL. Ground truth was "the first
 * tool this production turn happened to call", but these are companion
 * conversations where tool use is often ELECTIVE: the Choom decides to send a
 * selfie (generate_image) or quietly save a memory (remember) while replying
 * warmly to "I walked in 92 degree heat". A model that answers affectionately
 * and calls nothing is behaving correctly there, yet v2 scored it a miss.
 *
 * v3 keeps only turns where the USER MESSAGE ITSELF demands the tool
 * ("what's the weather", "grab a tower cam snapshot", "remind me to..."), so a
 * miss is genuinely a miss. 53 of 473 turns qualify.
 *
 * Reports per-tool and per-model, with repeat trials, because qwen and gemma
 * behave very differently and a single trial hides that.
 */
import { getAllToolsFromSkills } from '../lib/tool-definitions';
import * as fs from 'fs';

const CASES = '/tmp/claude-1000/-home-nuc1-projects-misc-freecad-mcp/7fe77c43-9c75-4fe0-aad8-cf7687b2a7a7/scratchpad/cases_v3.json';
const TRIALS = Number(process.env.EXP_TRIALS || 2);
const CORE_N = Number(process.env.EXP_CORE || 25);
const CONC = Number(process.env.EXP_CONC || 3);
const MAXTOK = Number(process.env.EXP_MAXTOK || 700);

type Tool = { name: string; description: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } };
type Case = { choom: string; sp: string; history: Array<{ role: string; content: string }>; msg: string; firstTool: string; allTools: string[] };

const TARGETS = [
  { label: 'qwen3.6-35b', model: 'qwen/qwen3.6-35b-a3b' },
  { label: 'gemma-4-31b', model: 'google/gemma-4-31b-qat' },
];
const EP = 'http://127.0.0.1:1234/v1';

const DIRECTIVES = `
## TOOL USAGE (CRITICAL)
You MUST use function calls to perform actions. NEVER describe what you would do — call the tool directly.
Examples of WRONG behavior: "I'll search for that..." or "Let me check the weather..." (without a tool call)
ALWAYS call tools via function calls when a request requires them. Do NOT narrate — just call.

## IMPORTANT
- Use tools via function calls (the tools array), not by writing tool names in your response
- For local weather (home, here, my area): call \`get_weather\` with NO location parameter.
`;
const OWNER = `\n## CONTEXT\nOwner: Donny. Location: Rodeo, New Mexico.\n`;

function slim(t: Tool) {
  let d = t.description;
  const s = d.indexOf('. ');
  if (s > 0 && s < 120) d = d.slice(0, s + 1);
  else if (d.length > 120) d = d.slice(0, 117) + '...';
  const props: Record<string, unknown> = {};
  for (const [k, p] of Object.entries<Record<string, unknown>>((t.parameters?.properties || {}) as never)) {
    const o: Record<string, unknown> = { type: p.type };
    if (p.enum) o.enum = p.enum; if (p.items) o.items = p.items; if (p.default !== undefined) o.default = p.default;
    props[k] = o;
  }
  return { name: t.name, description: d, parameters: { type: 'object', properties: props, ...(t.parameters?.required ? { required: t.parameters.required } : {}) } };
}
const wrap = (ts: Tool[]) => ts.map(t => ({ type: 'function' as const, function: slim(t) }));

const FIND_TOOL: Tool = {
  name: 'find_tool',
  description: 'Search for a tool you need but do not have. If no available tool matches, call this FIRST with a short description of what you need, then call the tool it returns.',
  parameters: { properties: { query: { type: 'string' } } as never, required: ['query'] },
};

async function post(model: string, messages: unknown[], tools: unknown[], tool_choice: string) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 180000);
  try {
    const r = await fetch(`${EP}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ model, messages, tools, tool_choice, temperature: 0.3, max_tokens: MAXTOK }),
    });
    if (!r.ok) return { err: `HTTP ${r.status}`, calls: [] as string[], tok: 0, raw: null as any };
    const j = await r.json(); const m = j.choices?.[0]?.message || {};
    return { err: null, calls: (m.tool_calls || []).map((c: any) => c.function?.name).filter(Boolean) as string[], tok: j.usage?.prompt_tokens || 0, raw: m };
  } catch (e) { return { err: String(e).slice(0, 60), calls: [] as string[], tok: 0, raw: null as any }; }
  finally { clearTimeout(to); }
}
/** auto first; if it narrates instead of acting, force — same as production. */
async function attempt(model: string, messages: unknown[], tools: unknown[]) {
  const a = await post(model, messages, tools, 'auto');
  if (a.err || a.calls.length) return a;
  const f = await post(model, messages, tools, 'required');
  return f.err ? a : f;
}
async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(xs.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]); } }));
  return out;
}

async function main() {
  const all = (await getAllToolsFromSkills()) as Tool[];
  const byName = new Map(all.map(t => [t.name, t]));
  const cases: Case[] = JSON.parse(fs.readFileSync(CASES, 'utf-8'));

  const freq = new Map<string, number>();
  for (const c of cases) freq.set(c.firstTool, (freq.get(c.firstTool) || 0) + 1);
  // Core = most-used tools overall (not from this filtered set, which would be circular)
  const globalFreq = new Map<string, number>();
  for (const c of JSON.parse(fs.readFileSync('/tmp/claude-1000/-home-nuc1-projects-misc-freecad-mcp/7fe77c43-9c75-4fe0-aad8-cf7687b2a7a7/scratchpad/cases_v2.json', 'utf-8')) as Case[])
    globalFreq.set(c.firstTool, (globalFreq.get(c.firstTool) || 0) + 1);
  const core = [...globalFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, CORE_N)
    .map(([n]) => byName.get(n)).filter(Boolean) as Tool[];
  const coreSet = new Set(core.map(t => t.name));

  const search = (q: string) => {
    const qs = new Set(q.toLowerCase().match(/[a-z]{3,}/g) || []);
    return all.map(t => { const w = new Set(`${t.name.replace(/_/g, ' ')} ${t.description}`.toLowerCase().match(/[a-z]{3,}/g) || []); let s = 0; for (const x of qs) if (w.has(x)) s++; return { t, s }; })
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8).map(x => x.t);
  };
  const msgs = (c: Case) => [
    { role: 'system', content: `${c.sp}\n${OWNER}\n${DIRECTIVES}` },
    ...c.history.filter(h => h.role === 'user' || h.role === 'assistant').map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: c.msg },
  ];

  console.log(`cases=${cases.length}  trials=${TRIALS}  core=${CORE_N} — B/C use core MINUS each case's own target tool, so every case tests discovery\n`);

  for (const tg of TARGETS) {
    const per: Record<string, { A: [number, number]; B: [number, number]; C: [number, number] }> = {};
    let tokA = 0, tokB = 0, tokC = 0, nA = 0, searched = 0, recovered = 0;
    const jobs = cases.flatMap(c => Array.from({ length: TRIALS }, () => c));
    const rs = await mapLimit(jobs, CONC, async (c) => {
      const base = msgs(c); const want = new Set([c.firstTool, ...c.allTools]);
      // HOLD-OUT: the high-confidence cases all use popular tools that already
      // sit inside core-25, so a plain core never poses the discovery question
      // (measured: 0 of 53 cases needed a non-core tool). Remove the case's OWN
      // target tool from the core instead. That is precisely the scenario
      // tiering must survive: the needed tool is absent, so the model must
      // either discover it (B) or fail (C).
      const heldOut = core.filter(t => !want.has(t.name));
      const A = await attempt(tg.model, base, wrap(all));
      const C = await attempt(tg.model, base, wrap(heldOut));
      const B1 = await attempt(tg.model, base, wrap([...heldOut, FIND_TOOL]));
      let bHit = B1.calls.some(x => want.has(x)), bTok = B1.tok, sr = false, rc = false;
      if (!bHit && B1.calls.includes('find_tool')) {
        sr = true;
        let q = c.msg; try { q = JSON.parse(B1.raw?.tool_calls?.[0]?.function?.arguments || '{}').query || c.msg; } catch {}
        const found = search(String(q));
        const B2 = await attempt(tg.model, [...base,
          { role: 'assistant', content: '', tool_calls: B1.raw.tool_calls },
          { role: 'tool', tool_call_id: B1.raw.tool_calls[0].id, name: 'find_tool', content: JSON.stringify({ tools: found.map(t => t.name) }) }],
          wrap([...heldOut, FIND_TOOL, ...found]));
        bTok += B2.tok; if (B2.calls.some(x => want.has(x))) { bHit = true; rc = true; }
      }
      return { c, aHit: A.calls.some(x => want.has(x)), cHit: C.calls.some(x => want.has(x)), bHit, tA: A.tok, tB: bTok, tC: C.tok, sr, rc, err: A.err };
    });
    for (const r of rs) {
      const k = r.c.firstTool; per[k] ||= { A: [0, 0], B: [0, 0], C: [0, 0] };
      per[k].A[1]++; per[k].B[1]++; per[k].C[1]++;
      if (r.aHit) per[k].A[0]++; if (r.bHit) per[k].B[0]++; if (r.cHit) per[k].C[0]++;
      tokA += r.tA; tokB += r.tB; tokC += r.tC; nA++; if (r.sr) searched++; if (r.rc) recovered++;
    }
    const tot = (s: 'A' | 'B' | 'C') => { let h = 0, n = 0; for (const v of Object.values(per)) { h += v[s][0]; n += v[s][1]; } return n ? (100 * h / n) : 0; };
    console.log(`=== ${tg.label} ===`);
    console.log(`  tool                     in-core   A(all132)   B(core+find)  C(core only)`);
    for (const [t, v] of Object.entries(per).sort((a, b) => b[1].A[1] - a[1].A[1])) {
      const p = (x: [number, number]) => `${String(x[0]).padStart(2)}/${String(x[1]).padStart(2)}`;
      console.log(`  ${t.padEnd(24)} 'held'      ${p(v.A)}       ${p(v.B)}        ${p(v.C)}`);
    }
    console.log(`  ----`);
    console.log(`  A all-132     ${tot('A').toFixed(1).padStart(5)}%   avg ${Math.round(tokA / nA)} tok`);
    console.log(`  B core+find   ${tot('B').toFixed(1).padStart(5)}%   avg ${Math.round(tokB / nA)} tok   (find_tool used ${searched}, recovered ${recovered})`);
    console.log(`  C core only   ${tot('C').toFixed(1).padStart(5)}%   avg ${Math.round(tokC / nA)} tok`);
    console.log(`  VALIDITY: baseline ${tot('A') >= 60 ? 'OK' : 'STILL LOW — treat B/C with suspicion'}\n`);
  }
}
main();
