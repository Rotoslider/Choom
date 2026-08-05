// Suggest the nearest real tool names for a hallucinated one. The registry's
// resolveToolName already auto-corrects DETERMINISTIC transforms (case,
// hyphens, prefixes); this handles the semantic near-misses it correctly
// refuses to auto-execute (read_memory, workspace_append_to_file) by naming
// candidates in the error so the model's next call is informed instead of
// another guess. Corpus cases: "Unknown tool: read_memory" (Genesis 08-01),
// "Unknown tool: workspace_append_to_file" (08-04) — both were blank walls.
export function suggestToolNames(wanted: string, available: string[]): string[] {
  const editDistance = (a: string, b: string): number => {
    if (Math.abs(a.length - b.length) > 3) return 99;
    const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return prev[b.length];
  };
  const tokensMatch = (a: string, b: string) =>
    a === b || editDistance(a, b) <= 2 || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  const wantedTokens = wanted.toLowerCase().split(/[_\-.]/).filter(Boolean);
  const scored = available
    .map(name => {
      const tokens = name.toLowerCase().split(/[_\-.]/).filter(Boolean);
      const matched = wantedTokens.filter(wt => tokens.some(t => tokensMatch(wt, t))).length;
      return { name, matched, len: name.length };
    })
    .filter(s => s.matched > 0)
    .sort((x, y) => y.matched - x.matched || x.len - y.len);
  return scored.slice(0, 3).map(s => s.name);
}
