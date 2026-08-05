/**
 * EXPERIMENT v2 — tool-exposure strategies, measured against the REAL prompt.
 *
 * SAFETY: talks to LM Studio only. Never executes a tool, never touches
 * Google/HA/Signal/Drive, never writes to the DB or workspace. It records
 * which tool the model CHOSE and stops.
 *
 * v1 was invalid: it sent "You are a helpful assistant with tools" and no
 * history, so the all-132 baseline scored 8.3% — the control was broken, which
 * makes every comparison meaningless. v2 reconstructs the production prompt
 * (the Choom's own systemPrompt plus the TOOL USAGE / AGENTIC BEHAVIOR
 * directives from route.ts) and replays the real preceding conversation.
 *
 * VALIDITY GATE: if condition A (all 132 tools) does not score well above v1's
 * 8.3%, the harness is still broken and NO other number here may be cited.
 *
 * STATUS AFTER THREE ITERATIONS: STILL INVALID. Do not cite B or C.
 *   v1 (bare prompt)                 qwen A =  8.3%
 *   v2 (real prompt + history)       qwen A = 25.0%   gemma A =  0.0%
 *   v2 + forced retry                qwen A = 37.5%   gemma A =  0.0%
 * Reconstructing the prompt keeps closing the gap but never reaches a credible
 * baseline, and "called any tool" stays at 25-50% even with a forced retry.
 * The residue is everything this file still does not reproduce: awareness
 * blocks (live weather/HA state/recent images), skill docs from
 * buildSkillToolDocs, compaction summaries, memory injection, and the exact
 * model params from the Choom's own profile.
 *
 * DO NOT keep patching the reconstruction. The next attempt should CAPTURE
 * instead: log the real {messages, tools, params} payload that route.ts sends
 * to the LLM for N production turns, then replay those payloads verbatim with
 * only the tools array swapped per condition. That yields a true baseline by
 * construction, because condition A literally IS the production request.
 *
 * SIDE FINDING worth chasing independently: LM Studio rejects named
 * tool_choice ({type:'function'...}) with a 400 — "Supported string values:
 * none, auto, required" — which route.ts:4270 already documents. In this
 * harness plain 'required' also failed to force a call on a mismatched
 * request. forceToolCallUsed fires on 34.5% of production traces (2,300 of
 * 6,663), so how reliably 'required' actually forces on LM Studio is worth
 * measuring on its own.
 */
import { getAllToolsFromSkills } from '../lib/tool-definitions';
import * as fs from 'fs';

const CASES_PATH = '/tmp/claude-1000/-home-nuc1-projects-misc-freecad-mcp/7fe77c43-9c75-4fe0-aad8-cf7687b2a7a7/scratchpad/cases_v2.json';
const N = Number(process.env.EXP_CASES || 40);
const CORE_N = Number(process.env.EXP_CORE || 25);
const CONC = Number(process.env.EXP_CONC || 3);

type Tool = { name: string; description: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } };
type Case = { choom: string; sp: string; history: Array<{ role: string; content: string }>; msg: string; firstTool: string; allTools: string[] };
type Target = { label: string; endpoint: string; model: string };

const TARGETS: Target[] = [
  { label: 'qwen3.6-35b', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3.6-35b-a3b' },
  { label: 'gemma-4-31b', endpoint: 'http://127.0.0.1:1234/v1', model: 'google/gemma-4-31b-qat' },
];

/** Verbatim from route.ts — the directives that actually drive tool use. */
const DIRECTIVES = `
## TOOL USAGE (CRITICAL)
You MUST use function calls to perform actions. NEVER describe what you would do — call the tool directly.
Examples of WRONG behavior: "I'll search for that..." or "Let me check the weather..." (without a tool call)
Examples of RIGHT behavior: [immediately calls web_search or get_weather tool]
ALWAYS call tools via function calls when a request requires them. Do NOT narrate — just call.

## AGENTIC BEHAVIOR
You can call tools multiple times across multiple steps. After receiving tool results, you may call
additional tools, retry with corrected parameters, or chain tools sequentially.

## IMPORTANT
- Use tools via function calls (the tools array), not by writing tool names in your response
- For local weather (home, here, my area): call \`get_weather\` with NO location parameter.
- When the user asks about "here" or "my location", use the configured weather coordinates.
`;

const OWNER = `\n## CONTEXT\nThe owner is Donny. Location: Rodeo, New Mexico. Current time: afternoon.\n`;

function slim(t: Tool) {
  let d = t.description;
  const s = d.indexOf('. ');
  if (s > 0 && s < 120) d = d.slice(0, s + 1);
  else if (d.length > 120) d = d.slice(0, 117) + '...';
  const props: Record<string, unknown> = {};
  for (const [k, p] of Object.entries<Record<string, unknown>>((t.parameters?.properties || {}) as never)) {
    const o: Record<string, unknown> = { type: p.type };
    if (p.enum) o.enum = p.enum;
    if (p.items) o.items = p.items;
    if (p.default !== undefined) o.default = p.default;
    props[k] = o;
  }
  return { name: t.name, description: d, parameters: { type: 'object', properties: props, ...(t.parameters?.required ? { required: t.parameters.required } : {}) } };
}
const wrap = (ts: Tool[]) => ts.map(t => ({ type: 'function' as const, function: slim(t) }));

const FIND_TOOL: Tool = {
  name: 'find_tool',
  description: 'Search for a tool you need but do not currently have. If no available tool matches the request, call this FIRST with a short description of what you need, then call the tool it returns.',
  parameters: { properties: { query: { type: 'string' } } as never, required: ['query'] },
};

async function callOnce(tg: Target, messages: unknown[], tools: unknown[], ms: number) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${tg.endpoint}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ model: tg.model, messages, tools, tool_choice: 'auto', temperature: 0.2, max_tokens: 300 }),
    });
    if (!r.ok) return { err: `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`, usage: null, calls: [] as string[], raw: null as any };
    const j = await r.json();
    const m = j.choices?.[0]?.message || {};
    return { err: null, usage: j.usage, calls: (m.tool_calls || []).map((c: any) => c.function?.name).filter(Boolean) as string[], raw: m };
  } catch (e) { return { err: e instanceof Error ? `${e.name}: ${e.message}` : String(e), usage: null, calls: [] as string[], raw: null as any }; }
  finally { clearTimeout(to); }
}
async function call(tg: Target, messages: unknown[], tools: unknown[], ms = 120000, attempt = 0): Promise<Awaited<ReturnType<typeof callOnce>>> {
  const r = await callOnce(tg, messages, tools, ms);
  if (r.err && attempt < 2 && /HTTP 4|abort/i.test(r.err)) {
    await new Promise(res => setTimeout(res, 2500 * (attempt + 1)));
    return call(tg, messages, tools, ms, attempt + 1);
  }
  return r;
}

/**
 * Production does not accept a bare narration. When strong tool intent is
 * detected it sets tool_choice='required' (forceToolCall), and when the model
 * narrates instead of acting it nudges and retries. Measuring a single
 * unforced shot therefore measures something the Chooms never actually do —
 * the first v2 run showed only 12-37% of turns calling any tool at all, which
 * is the harness omitting this, not the model refusing.
 *
 * Applied identically to every condition so the comparison stays fair.
 */
async function callForced(tg: Target, messages: unknown[], tools: unknown[], ms = 120000) {
  const first = await call(tg, messages, tools, ms);
  if (first.err || first.calls.length) return first;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${tg.endpoint}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ model: tg.model, messages, tools, tool_choice: 'required', temperature: 0.2, max_tokens: 300 }),
    });
    if (!r.ok) return first;
    const j = await r.json();
    const m = j.choices?.[0]?.message || {};
    return { err: null, usage: j.usage || first.usage, calls: (m.tool_calls || []).map((c: any) => c.function?.name).filter(Boolean) as string[], raw: m };
  } catch { return first; } finally { clearTimeout(to); }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function main() {
  const all = (await getAllToolsFromSkills()) as Tool[];
  const byName = new Map(all.map(t => [t.name, t]));
  const cases: Case[] = JSON.parse(fs.readFileSync(CASES_PATH, 'utf-8'));

  const freq = new Map<string, number>();
  for (const c of cases) freq.set(c.firstTool, (freq.get(c.firstTool) || 0) + 1);
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const core = [...new Set([...ranked.slice(0, CORE_N), ...all.slice(0, 0).map(t => t.name)])]
    .map(n => byName.get(n)).filter(Boolean) as Tool[];
  const coreSet = new Set(core.map(t => t.name));

  // Stratify: half the sample must NEED a tool outside the core, or the
  // discovery question is never actually posed.
  const need = cases.filter(c => !coreSet.has(c.firstTool));
  const have = cases.filter(c => coreSet.has(c.firstTool));
  const stride = <T,>(a: T[], n: number) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
  const sample = [...stride(need, Math.floor(N / 2)), ...stride(have, Math.ceil(N / 2))];

  const msgsFor = (c: Case) => [
    { role: 'system', content: `${c.sp}\n${OWNER}\n${DIRECTIVES}` },
    ...c.history.filter(h => h.role === 'user' || h.role === 'assistant').map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: c.msg },
  ];

  const searchFor = (q: string) => {
    const qs = new Set(q.toLowerCase().match(/[a-z]{3,}/g) || []);
    return all.map(t => {
      const w = new Set(`${t.name.replace(/_/g, ' ')} ${t.description}`.toLowerCase().match(/[a-z]{3,}/g) || []);
      let s = 0; for (const x of qs) if (w.has(x)) s++;
      return { t, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8).map(x => x.t);
  };

  for (const tg of TARGETS) {
    const acc = { A: { hit: 0, n: 0, tok: 0, err: 0, called: 0 }, B: { hit: 0, n: 0, tok: 0, err: 0, searched: 0, rec: 0, called: 0 }, C: { hit: 0, n: 0, tok: 0, err: 0, called: 0 } };
    const rows = await mapLimit(sample, CONC, async (c) => {
      const base = msgsFor(c);
      const want = new Set([c.firstTool, ...c.allTools]);

      const a = await callForced(tg, base, wrap(all));
      const cc = await callForced(tg, base, wrap(core));
      const b1 = await callForced(tg, base, wrap([...core, FIND_TOOL]));
      let bHit = b1.calls.some(x => want.has(x)), bTok = b1.usage?.prompt_tokens || 0, searched = false, rec = false;
      if (!bHit && b1.calls.includes('find_tool')) {
        searched = true;
        let q = c.msg;
        try { q = JSON.parse(b1.raw?.tool_calls?.[0]?.function?.arguments || '{}').query || c.msg; } catch { /* keep msg */ }
        const found = searchFor(String(q));
        const b2 = await call(tg, [...base,
          { role: 'assistant', content: '', tool_calls: b1.raw.tool_calls },
          { role: 'tool', tool_call_id: b1.raw.tool_calls[0].id, name: 'find_tool', content: JSON.stringify({ tools: found.map(t => t.name) }) },
        ], wrap([...core, FIND_TOOL, ...found]));
        bTok += b2.usage?.prompt_tokens || 0;
        if (b2.calls.some(x => want.has(x))) { bHit = true; rec = true; }
      }
      return { c, a, cc, b1, bHit, bTok, searched, rec, want };
    });

    for (const r of rows) {
      if (r.a.err) acc.A.err++; else { acc.A.n++; acc.A.tok += r.a.usage?.prompt_tokens || 0; if (r.a.calls.length) acc.A.called++; if (r.a.calls.some(x => r.want.has(x))) acc.A.hit++; }
      if (r.cc.err) acc.C.err++; else { acc.C.n++; acc.C.tok += r.cc.usage?.prompt_tokens || 0; if (r.cc.calls.length) acc.C.called++; if (r.cc.calls.some(x => r.want.has(x))) acc.C.hit++; }
      if (r.b1.err) acc.B.err++; else { acc.B.n++; acc.B.tok += r.bTok; if (r.b1.calls.length) acc.B.called++; if (r.bHit) acc.B.hit++; if (r.searched) acc.B.searched++; if (r.rec) acc.B.rec++; }
    }
    const pc = (h: number, n: number) => n ? (100 * h / n).toFixed(1).padStart(5) + '%' : '    —';
    console.log(`\n=== ${tg.label} ===  (${sample.length} cases, ${Math.floor(N/2)} needing a non-core tool)`);
    console.log(`  A all-132        ${pc(acc.A.hit, acc.A.n)} correct   ${pc(acc.A.called, acc.A.n)} called any tool   avg ${Math.round(acc.A.tok / Math.max(1, acc.A.n))} tok   err ${acc.A.err}`);
    console.log(`  B core-${CORE_N}+search ${pc(acc.B.hit, acc.B.n)} correct   ${pc(acc.B.called, acc.B.n)} called any tool   avg ${Math.round(acc.B.tok / Math.max(1, acc.B.n))} tok   err ${acc.B.err}`);
    console.log(`      used find_tool ${acc.B.searched}/${acc.B.n}, recovered after search ${acc.B.rec}`);
    console.log(`  C core-${CORE_N} only   ${pc(acc.C.hit, acc.C.n)} correct   ${pc(acc.C.called, acc.C.n)} called any tool   avg ${Math.round(acc.C.tok / Math.max(1, acc.C.n))} tok   err ${acc.C.err}`);
    if (acc.A.n && acc.A.hit / acc.A.n < 0.30) console.log(`  !! VALIDITY GATE FAILED for ${tg.label}: baseline <30%, do not cite B or C.`);
  }
}
main();
