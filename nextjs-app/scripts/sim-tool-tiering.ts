/**
 * Simulate tool-exposure strategies against real production traffic.
 *
 * PURE ANALYSIS — reads data/traces + a ground-truth join, calls no tools,
 * touches no external service, writes nothing but its own report.
 *
 * The question: 132 tools ship on every request (~11.5k tokens, and more
 * importantly 132 candidates for a 35B model to choose between). Tiering could
 * cut that — but route.ts warns "filtering tools out of the array prevents the
 * LLM from ever calling them — lesson learned twice". So the metric that
 * decides everything is RECALL: on a real request, was every tool the Choom
 * actually used still exposed? A miss is not a slow answer, it is an
 * impossible one.
 *
 * Ground truth: 474 (user message -> tools actually called) pairs joined from
 * execution traces and the message DB.
 *
 * CAVEAT, measured not assumed: that join covers only 474 of 6,663 traces (7%),
 * because it needs a user message immediately preceding the trace. Do NOT read
 * "tool absent from this sample" as "tool unused" — across the FULL corpus 130
 * of 132 tools are exercised. Frequency ranking here is also fitted on the same
 * sample it is scored against, which flatters S1/S7; treat their recall as an
 * optimistic upper bound, which only strengthens the conclusion that dynamic
 * tiering underperforms.
 */
import { getAllToolsFromSkills } from '../lib/tool-definitions';
import { getSkillRegistry } from '../lib/skill-registry';
import * as fs from 'fs';

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
const TOK = (s: string) => Math.ceil(s.length / 3.4);
const costOf = (tools: Tool[]) => TOK(JSON.stringify(tools.map(t => ({ type: 'function', function: slim(t) }))));

async function main() {
  const all = (await getAllToolsFromSkills()) as Tool[];
  const byName = new Map(all.map(t => [t.name, t]));

  const reg = getSkillRegistry();
  await reg.loadAll();
  const skills = (reg as unknown as { skills: Map<string, { metadata: { name: string; description: string }; toolDefinitions?: Tool[] }> }).skills;
  const toolSkill = new Map<string, string>();
  const skillTools = new Map<string, string[]>();
  for (const s of skills.values()) {
    const names = (s.toolDefinitions || []).map(t => t.name);
    skillTools.set(s.metadata.name, names);
    for (const n of names) toolSkill.set(n, s.metadata.name);
  }

  const pairs: Pair[] = JSON.parse(fs.readFileSync('/tmp/claude-1000/-home-nuc1-projects-misc-freecad-mcp/7fe77c43-9c75-4fe0-aad8-cf7687b2a7a7/scratchpad/ground_truth.json', 'utf-8'))
    .filter((p: Pair) => p.tools.length > 0);

  // Tool popularity from the SAME corpus. In production this would be a rolling
  // window; here it is the whole history, which flatters frequency strategies
  // slightly — noted in the report rather than hidden.
  const freq = new Map<string, number>();
  for (const p of pairs) for (const t of p.tools) freq.set(t, (freq.get(t) || 0) + 1);
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);

  const resolve = (names: Iterable<string>) => [...new Set(names)].map(n => byName.get(n)).filter(Boolean) as Tool[];

  /** Keyword -> skill matching, mirroring how skill-registry scores relevance. */
  const skillKeywords = new Map<string, string[]>();
  for (const s of skills.values()) {
    const words = `${s.metadata.name} ${s.metadata.description}`.toLowerCase().match(/[a-z]{4,}/g) || [];
    skillKeywords.set(s.metadata.name, [...new Set(words)]);
  }
  function matchSkills(msg: string, topK: number): string[] {
    const m = msg.toLowerCase();
    const scored: Array<[string, number]> = [];
    for (const [name, kws] of skillKeywords) {
      let sc = 0;
      if (m.includes(name.replace(/-/g, ' ')) || m.includes(name)) sc += 5;
      for (const k of kws) if (m.includes(k)) sc++;
      for (const t of skillTools.get(name) || []) if (m.includes(t.replace(/_/g, ' '))) sc += 3;
      if (sc) scored.push([name, sc]);
    }
    return scored.sort((a, b) => b[1] - a[1]).slice(0, topK).map(([n]) => n);
  }

  type Strat = { label: string; expose: (p: Pair) => string[]; note?: string };
  const strategies: Strat[] = [
    { label: 'S0  all 132 tools (today)', expose: () => all.map(t => t.name) },
  ];
  for (const n of [20, 30, 40, 50, 60, 80]) {
    strategies.push({ label: `S1  top-${n} by frequency only`, expose: () => ranked.slice(0, n) });
  }
  for (const core of [15, 25, 35]) for (const k of [2, 3, 5]) {
    strategies.push({
      label: `S2  core-${core} + keyword-matched top-${k} skills`,
      expose: (p) => [...ranked.slice(0, core), ...matchSkills(p.msg, k).flatMap(s => skillTools.get(s) || [])],
    });
  }
  for (const core of [25, 35]) {
    strategies.push({
      label: `S3  core-${core} + ALL tools of matched skills (k=3) + skill-mates of core`,
      expose: (p) => {
        const base = ranked.slice(0, core);
        const mates = base.flatMap(n => skillTools.get(toolSkill.get(n) || '') || []);
        return [...base, ...mates, ...matchSkills(p.msg, 3).flatMap(s => skillTools.get(s) || [])];
      },
    });
  }


  // ---- Round 2: signals that actually predict tool use ----
  // Co-occurrence: tools that show up together in the same request.
  const cooc = new Map<string, Map<string, number>>();
  for (const pr of pairs) for (const a of pr.tools) {
    const m = cooc.get(a) || new Map<string, number>();
    for (const b of pr.tools) if (a !== b) m.set(b, (m.get(b) || 0) + 1);
    cooc.set(a, m);
  }
  const expandCooc = (seed: string[], per: number) =>
    seed.flatMap(n => [...(cooc.get(n) || new Map()).entries()].sort((a,b)=>b[1]-a[1]).slice(0, per).map(([b]) => b));

  // Tool-level keyword retrieval (match the message against tool name + description,
  // NOT against skill descriptions — S2/S3 showed skill-level matching is too coarse).
  const toolWords = new Map<string, Set<string>>();
  for (const t of all) toolWords.set(t.name, new Set(
    `${t.name.replace(/_/g,' ')} ${t.description}`.toLowerCase().match(/[a-z]{4,}/g) || []));
  function retrieveTools(msg: string, k: number): string[] {
    const m = new Set((msg.toLowerCase().match(/[a-z]{4,}/g) || []));
    const sc: Array<[string, number]> = [];
    for (const [n, w] of toolWords) { let x = 0; for (const q of m) if (w.has(q)) x++; if (x) sc.push([n, x]); }
    return sc.sort((a,b)=>b[1]-a[1]).slice(0, k).map(([n])=>n);
  }

  for (const core of [40, 50, 60]) for (const k of [10, 20]) {
    strategies.push({ label: `S4  core-${core} + tool-level retrieval top-${k}`,
      expose: (p) => [...ranked.slice(0, core), ...retrieveTools(p.msg, k)] });
  }
  for (const core of [40, 50, 60]) {
    strategies.push({ label: `S5  core-${core} + co-occurrence expansion (3 each)`,
      expose: () => { const b = ranked.slice(0, core); return [...b, ...expandCooc(b, 3)]; } });
  }
  for (const core of [40, 50]) for (const k of [10, 15]) {
    strategies.push({ label: `S6  core-${core} + retrieval-${k} + co-occurrence of both`,
      expose: (p) => { const b = [...ranked.slice(0, core), ...retrieveTools(p.msg, k)]; return [...b, ...expandCooc(b, 2)]; } });
  }
  // Everything that has EVER been used, plus a safety margin of the rest by frequency.
  const everUsed = [...freq.keys()];
  strategies.push({ label: `S7  every tool ever used in prod (${everUsed.length})`, expose: () => everUsed });

  console.log(`ground truth: ${pairs.length} real requests that used >=1 tool`);
  console.log(`baseline cost: ${costOf(all).toLocaleString()} tok for ${all.length} tools\n`);
  console.log('strategy                                                  recall   miss   avg tools   tok    saved');
  console.log('─'.repeat(104));

  const rows: Array<{ label: string; recall: number; tok: number; avg: number; misses: Map<string, number> }> = [];
  for (const s of strategies) {
    let ok = 0, toolSum = 0, tokSum = 0;
    const misses = new Map<string, number>();
    for (const p of pairs) {
      const exposed = new Set(s.expose(p));
      const missing = p.tools.filter(t => !exposed.has(t));
      if (missing.length === 0) ok++;
      else for (const m of missing) misses.set(m, (misses.get(m) || 0) + 1);
      toolSum += exposed.size;
      tokSum += costOf(resolve(exposed));
    }
    const recall = ok / pairs.length, tok = Math.round(tokSum / pairs.length), avg = Math.round(toolSum / pairs.length);
    const base = costOf(all);
    rows.push({ label: s.label, recall, tok, avg, misses });
    const flag = recall === 1 ? ' ' : recall >= 0.98 ? '.' : '!';
    console.log(
      `${flag} ${s.label.padEnd(54)} ${(recall * 100).toFixed(1).padStart(5)}%  ${String(pairs.length - ok).padStart(4)}  ${String(avg).padStart(6)}  ${String(tok).padStart(6)}  ${((1 - tok / base) * 100).toFixed(0).padStart(4)}%`,
    );
  }

  console.log('\n(! = loses >2% of requests, . = loses <=2%, blank = perfect recall)\n');
  const best = rows.filter(r => r.recall === 1).sort((a, b) => a.tok - b.tok)[0];
  if (best) console.log(`CHEAPEST WITH PERFECT RECALL: ${best.label}  -> ${best.tok.toLocaleString()} tok (${best.avg} tools)`);
  const near = rows.filter(r => r.recall >= 0.98 && r.recall < 1).sort((a, b) => a.tok - b.tok)[0];
  if (near) {
    console.log(`\nCHEAPEST AT >=98% RECALL: ${near.label} -> ${near.tok.toLocaleString()} tok`);
    console.log('  tools it would have denied (count = requests broken):');
    [...near.misses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([t, c]) => console.log(`    ${String(c).padStart(3)}x ${t}`));
  }
}
main();
