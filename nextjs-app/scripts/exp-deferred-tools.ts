/**
 * EXPERIMENT: can a ~35B local model handle deferred (just-in-time) tool loading?
 *
 * SAFETY — this script calls the local LM Studio endpoint and NOTHING else.
 * It never executes a tool, never touches Google/HA/Signal/Drive, never writes
 * to the database or the workspace. It inspects which tool the model *chose*
 * and stops there. (Written after a harness that replayed real tool arguments
 * against live accounts; see memory/blast-radius-before-acting.)
 *
 * WHY THIS EXPERIMENT
 * The earlier tiering simulation scored a missing tool as permanent failure,
 * which made every filtering strategy look bad (90-97% recall). But that is
 * only true without a recovery path. Modern agent harnesses — including the
 * one this assistant runs on — expose a small always-on core plus a tool-search
 * function that loads schemas on demand. Recall then becomes 100% by
 * construction: a missing tool costs one extra round trip, not the request.
 *
 * The open question is not whether the pattern works (it does, for large
 * models) but whether a 35B q8 local model reliably takes the extra reasoning
 * step: "the tool I need is not here -> search for it -> then call it".
 * That is what this measures, against the user's actual model.
 *
 * CONDITIONS
 *   A  all-132        every tool exposed (today's behaviour)          1 turn
 *   B  core+search    top-N by frequency + find_tool(query)           up to 2 turns
 *   C  core-only      top-N by frequency, no escape hatch (control)   1 turn
 *
 * C exists to separate "the core happened to contain it" from "the model
 * successfully discovered it".
 *
 * !! RESULT OF THE FIRST RUN: INVALID — DO NOT CITE ITS NUMBERS !!
 * 12 cases, qwen3.6-35b-a3b: A 8.3% / B 8.3% / C 8.3% correct. The BASELINE
 * being 8.3% is the tell: with all 132 tools present the model should pick the
 * right one far more often than that, so the instrument is broken, not the
 * strategies. Two causes, both mine:
 *   1. This sends a bare "You are a helpful assistant with tools" system
 *      prompt. Production sends the Choom's full persona, tool guidance and
 *      awareness blocks (location, owner, time). Stripped of that, "what's the
 *      weather" is genuinely ambiguous and the model asks for a location
 *      instead of calling get_weather — which is correct behaviour, scored as
 *      a miss here.
 *   2. Ground truth is every tool used across a whole agentic turn, including
 *      ones chosen on later iterations after earlier tool RESULTS were in
 *      context. Judging that from turn 1 with no history is unfair.
 *
 * One signal survives and is worth re-testing properly: find_tool was called
 * 0/12 times even when the needed tool was absent. If that holds up under a
 * valid harness it kills the deferred-loading idea for 35B models. It cannot
 * be trusted at an 8.3% baseline.
 *
 * TO MAKE THIS VALID: build each case's messages from the real system prompt
 * (buildSystemPrompt / the Choom row) plus the actual preceding conversation,
 * and score only the FIRST tool call against the first tool used in the trace.
 */
import { getAllToolsFromSkills } from '../lib/tool-definitions';
import * as fs from 'fs';

const ENDPOINT = process.env.LLM_ENDPOINT || 'http://127.0.0.1:1234/v1';
const MODEL = process.env.EXP_MODEL || 'qwen/qwen3.6-35b-a3b';
const CORE_N = Number(process.env.EXP_CORE || 25);
const CASES = Number(process.env.EXP_CASES || 40);

type Tool = { name: string; description: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } };
type Pair = { msg: string; tools: string[] };

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
  description: 'Search for a tool you need but do not currently have. Call this FIRST whenever no available tool matches the request, then call the tool it returns.',
  parameters: { properties: { query: { type: 'string' } } as never, required: ['query'] },
};

/** LM Studio evicts models under concurrent load (the live Chooms share this
 * endpoint), which surfaces as a 400 "No matching loaded model found". Retry
 * rather than scoring it as a model failure — that would silently corrupt the
 * experiment's headline numbers. */
async function chat(messages: unknown[], tools: unknown[], signalTimeoutMs = 90000, attempt = 0): Promise<{err: string|null; usage: {prompt_tokens?: number}|null; calls: string[]; raw?: any}> {
  const r = await chatOnce(messages, tools, signalTimeoutMs);
  if (r.err && attempt < 3 && /HTTP 4|abort/i.test(r.err)) {
    await new Promise(res => setTimeout(res, 3000 * (attempt + 1)));
    return chat(messages, tools, signalTimeoutMs, attempt + 1);
  }
  return r;
}

async function chatOnce(messages: unknown[], tools: unknown[], signalTimeoutMs = 90000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), signalTimeoutMs);
  try {
    const r = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0.2, max_tokens: 400 }),
    });
    if (!r.ok) { const b = await r.text(); if (!(globalThis as any).__loggedHttp) { (globalThis as any).__loggedHttp = 1; console.error('FIRST HTTP ERR:', r.status, b.slice(0,300)); } return { err: `HTTP ${r.status}`, usage: null, calls: [] as string[] }; }
    const j = await r.json();
    const m = j.choices?.[0]?.message || {};
    return { err: null, usage: j.usage, calls: (m.tool_calls || []).map((c: { function: { name: string } }) => c.function.name), raw: m };
  } catch (e) { const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e); if (!(globalThis as any).__loggedErr) { (globalThis as any).__loggedErr = 1; console.error('FIRST ERROR:', m); } return { err: m, usage: null, calls: [] as string[] }; }
  finally { clearTimeout(to); }
}

async function main() {
  const all = (await getAllToolsFromSkills()) as Tool[];
  const byName = new Map(all.map(t => [t.name, t]));
  const pairs: Pair[] = JSON.parse(fs.readFileSync(
    '/tmp/claude-1000/-home-nuc1-projects-misc-freecad-mcp/7fe77c43-9c75-4fe0-aad8-cf7687b2a7a7/scratchpad/ground_truth.json', 'utf-8'))
    .filter((p: Pair) => p.tools.length > 0 && p.msg.length > 15);

  const freq = new Map<string, number>();
  for (const p of pairs) for (const t of p.tools) freq.set(t, (freq.get(t) || 0) + 1);
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const core = ranked.slice(0, CORE_N).map(n => byName.get(n)).filter(Boolean) as Tool[];
  const coreSet = new Set(core.map(t => t.name));

  // Bias the sample toward cases the core does NOT cover — that is the whole
  // question. A sample dominated by top-25 tools would measure nothing.
  const uncovered = pairs.filter(p => p.tools.some(t => !coreSet.has(t)));
  const covered = pairs.filter(p => p.tools.every(t => coreSet.has(t)));
  const pick = <T,>(a: T[], n: number) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
  const sample = [...pick(uncovered, Math.floor(CASES * 0.7)), ...pick(covered, Math.ceil(CASES * 0.3))];

  const SYS = 'You are a helpful assistant with tools. When the user asks for something a tool can do, call that tool. Do not explain, just call it.';
  const searchDesc = (q: string) => {
    const qs = new Set(q.toLowerCase().match(/[a-z]{3,}/g) || []);
    return all.map(t => {
      const w = new Set(`${t.name.replace(/_/g, ' ')} ${t.description}`.toLowerCase().match(/[a-z]{3,}/g) || []);
      let s = 0; for (const x of qs) if (w.has(x)) s++;
      return { t, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8).map(x => x.t);
  };

  const res = { A: { hit: 0, tok: 0, n: 0, err: 0 }, B: { hit: 0, tok: 0, n: 0, err: 0, searched: 0, foundAfterSearch: 0 }, C: { hit: 0, tok: 0, n: 0, err: 0 } };
  console.log(`model=${MODEL}  core=${CORE_N}  cases=${sample.length} (${Math.floor(CASES*0.7)} needing a non-core tool)\n`);
  console.log('  #  want                          A(all132)      B(core+search)        C(core only)');
  console.log('  ' + '─'.repeat(88));

  for (let i = 0; i < sample.length; i++) {
    const p = sample[i];
    const want = new Set(p.tools);
    const base = [{ role: 'system', content: SYS }, { role: 'user', content: p.msg }];

    const a = await chat(base, wrap(all));
    const aHit = a.calls.some(c => want.has(c));
    if (a.err) res.A.err++; else { res.A.n++; res.A.tok += a.usage?.prompt_tokens || 0; if (aHit) res.A.hit++; }

    const c = await chat(base, wrap(core));
    const cHit = c.calls.some(x => want.has(x));
    if (c.err) res.C.err++; else { res.C.n++; res.C.tok += c.usage?.prompt_tokens || 0; if (cHit) res.C.hit++; }

    let bHit = false, bTok = 0, searched = false;
    const b1 = await chat(base, wrap([...core, FIND_TOOL]));
    bTok += b1.usage?.prompt_tokens || 0;
    if (b1.calls.some(x => want.has(x))) bHit = true;
    else if (b1.calls.includes('find_tool')) {
      searched = true; res.B.searched++;
      const q = (() => { try { return JSON.parse(b1.raw?.tool_calls?.[0]?.function?.arguments || '{}').query || p.msg; } catch { return p.msg; } })();
      const found = searchDesc(String(q));
      const b2 = await chat([...base,
        { role: 'assistant', content: '', tool_calls: b1.raw.tool_calls },
        { role: 'tool', tool_call_id: b1.raw.tool_calls[0].id, name: 'find_tool', content: JSON.stringify({ tools: found.map(t => t.name) }) },
      ], wrap([...core, FIND_TOOL, ...found]));
      bTok += b2.usage?.prompt_tokens || 0;
      if (b2.calls.some(x => want.has(x))) { bHit = true; res.B.foundAfterSearch++; }
    }
    if (b1.err) res.B.err++; else { res.B.n++; res.B.tok += bTok; if (bHit) res.B.hit++; }

    const mark = (h: boolean) => h ? 'HIT ' : 'miss';
    console.log(`  ${String(i + 1).padStart(2)}  ${[...want][0].slice(0, 26).padEnd(28)} ${mark(aHit)}  ${a.usage?.prompt_tokens || 0}`.padEnd(58)
      + `${mark(bHit)}${searched ? '*' : ' '} ${bTok}`.padEnd(22) + `${mark(cHit)} ${c.usage?.prompt_tokens || 0}`);
  }

  const pct = (h: number, n: number) => n ? (100 * h / n).toFixed(1) + '%' : '—';
  console.log('\n' + '='.repeat(90));
  console.log(`A  all 132 tools     : ${pct(res.A.hit, res.A.n)} correct   avg ${Math.round(res.A.tok / Math.max(1,res.A.n))} prompt tok   (errors ${res.A.err})`);
  console.log(`B  core-${CORE_N} + find_tool : ${pct(res.B.hit, res.B.n)} correct   avg ${Math.round(res.B.tok / Math.max(1,res.B.n))} prompt tok   (errors ${res.B.err})`);
  console.log(`     searched when it lacked the tool: ${res.B.searched}/${res.B.n}   recovered after searching: ${res.B.foundAfterSearch}`);
  console.log(`C  core-${CORE_N} only       : ${pct(res.C.hit, res.C.n)} correct   avg ${Math.round(res.C.tok / Math.max(1,res.C.n))} prompt tok   (errors ${res.C.err})`);
  console.log('\n* = model called find_tool. B beating C is the discovery step working.');
}
main();
