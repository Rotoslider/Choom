// Pivot Hint Builder
// When a tool call fails, augment the error returned to the model with a
// concrete list of sibling tools in the same skill plus a heuristic
// suggestion. Closes the gap between "the prompt tells the model to try
// alternatives" and "the model knows what alternatives actually exist".

import type { SkillRegistry } from './skill-registry';

export type ToolErrorClass =
  | 'config'
  | 'param'
  | 'gpu_busy'
  | 'no_data'
  | 'path'
  | 'other'
  | undefined;

export interface BuildPivotHintOpts {
  failedTool: string;
  errorMessage: string;
  errorClass: ToolErrorClass;
  registry: SkillRegistry;
  /** Names of tools already attempted in this request (incl. the failed one).
   *  Used to deprioritize re-suggesting tools the model has already exhausted. */
  alreadyTried?: Set<string>;
}

/**
 * Produce a structured hint string to append to the model-visible error.
 * Returns null when no useful pivot exists (param errors the model can
 * self-fix, config errors that block the tool entirely, lone-tool skills,
 * and informational no_data results).
 */
export function buildPivotHint(opts: BuildPivotHintOpts): string | null {
  const { failedTool, errorMessage, errorClass, registry, alreadyTried } = opts;

  // Don't hint for cases where alternatives don't help:
  // - param: model just needs to fix arguments on its next call
  // - config: tool is broken (auth, endpoint missing); siblings likely same issue
  // - no_data: informational, not a failure
  if (errorClass === 'param' || errorClass === 'config' || errorClass === 'no_data') {
    return null;
  }

  const skill = registry.getSkillForTool(failedTool);
  if (!skill) return null;

  const skillName = skill.metadata.name;
  const siblingDefs = (skill.toolDefinitions || []).filter(t => t.name !== failedTool);
  if (siblingDefs.length === 0) return null;

  // Rank: tools NOT already tried first, then tools already tried (still listed
  // so the model knows what's been exhausted).
  const tried = alreadyTried || new Set<string>();
  const fresh = siblingDefs.filter(t => !tried.has(t.name));
  const exhausted = siblingDefs.filter(t => tried.has(t.name));

  const lines: string[] = [];
  lines.push(`(Pivot hint) "${failedTool}" is in the "${skillName}" skill. Other tools in the same skill:`);
  for (const t of fresh.slice(0, 8)) {
    const desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    lines.push(`  - ${t.name}: ${desc}`);
  }
  if (exhausted.length > 0) {
    lines.push(`Already tried this request: ${exhausted.map(t => t.name).join(', ')}`);
  }

  // Heuristic next-step suggestion based on the error pattern.
  const lowerErr = (errorMessage || '').toLowerCase();
  let suggestion: string | null = null;

  // Pattern: name/path/entity not found → use a list/discovery tool to find correct name
  const looksLikeNotFound =
    errorClass === 'path' ||
    /\bnot found\b|404|enoent|no such|does not exist|unknown entity|invalid entity/.test(lowerErr);
  if (looksLikeNotFound) {
    const discoveryTool = fresh.find(t =>
      /list|search|find|browse|discover|enumerate/i.test(t.name) ||
      /list|search|find|browse|discover|enumerate/i.test(t.description || ''),
    );
    if (discoveryTool) {
      suggestion = `Suggested next: ${discoveryTool.name} — the failure looks like a name/path mismatch. List/search to confirm the correct identifier, then retry the original tool with the corrected value.`;
    }
  }

  if (!suggestion && /rate.?limit|429|too many requests|quota/.test(lowerErr)) {
    suggestion = `Suggested next: pause or switch providers. Rate-limited services often have alternative providers configured (e.g. brave_search → searxng, serpapi). Try a different tool in this skill or wait and retry.`;
  }

  if (!suggestion && errorClass === 'gpu_busy') {
    suggestion = `Suggested next: do not retry the same tool — GPU is temporarily busy. Move on to a different sub-task or inform the user.`;
  }

  if (!suggestion && /timeout|timed.?out|deadline/.test(lowerErr)) {
    suggestion = `Suggested next: try a narrower scope (smaller query, fewer items, single entity) or a different tool above. Don't retry the same call with the same shape.`;
  }

  if (suggestion) lines.push(suggestion);
  else lines.push(`If a sibling tool above can reach the same goal differently, try it. Don't repeat the failing call with the same arguments.`);

  return lines.join('\n');
}

/**
 * Append the pivot hint to a tool result's error string in-place. No-op
 * if the result has no error or no useful hint can be built.
 */
export function attachPivotHintToError(
  result: { error?: string },
  opts: BuildPivotHintOpts,
): void {
  if (!result.error) return;
  const hint = buildPivotHint(opts);
  if (!hint) return;
  // Preserve the original error verbatim so the model still sees the raw signal.
  result.error = `${result.error}\n\n${hint}`;
}
