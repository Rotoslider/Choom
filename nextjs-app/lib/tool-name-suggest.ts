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
  const wantedLower = wanted.toLowerCase();
  // Generic tokens carry almost no domain signal: sharing bare "control" with
  // music_control used to make a hallucinated "remote_control" (SSH work!)
  // come back as "Did you mean: music_control?".
  const GENERIC_TOKENS = new Set([
    'control', 'state', 'service', 'list', 'get', 'set', 'run', 'execute',
    'create', 'delete', 'update', 'data', 'info', 'command', 'status', 'manager',
  ]);
  const scored = available
    .map(name => {
      const lower = name.toLowerCase();
      const tokens = lower.split(/[_\-.]/).filter(Boolean);
      const matchedTokens = wantedTokens.filter(wt => tokens.some(t => tokensMatch(wt, t)));
      let qualifies = matchedTokens.length >= 2 || editDistance(wantedLower, lower) <= 2;
      if (!qualifies && matchedTokens.length === 1) {
        // A single DISTINCTIVE shared token still points somewhere real
        // ("read_memory" → search_memories via "memory"); a generic one doesn't.
        const shared = tokens.find(t => matchedTokens.some(wt => wt === t || tokensMatch(wt, t)));
        qualifies = !!shared && !GENERIC_TOKENS.has(shared);
      }
      return { name, matched: matchedTokens.length, len: name.length, qualifies };
    })
    .filter(s => s.qualifies)
    .sort((x, y) => y.matched - x.matched || x.len - y.len);
  return scored.slice(0, 3).map(s => s.name);
}
