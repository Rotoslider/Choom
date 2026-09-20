/**
 * Last-resort argument-name repair for tool calls.
 *
 * The camelCase/hyphen normalizer in tool-execution.ts handles spelling
 * variants of the RIGHT name. This handles the WRONG name: a model that sends
 * {uri: "library://track/90108"} to music_play (schema: media) or
 * {command: "play"} to music_control (schema: action). Both happened back to
 * back on 2026-09-20 (Aloy, DeepSeek V4 Flash) and burned four iterations.
 *
 * Rule, kept deliberately narrow so it cannot silently misroute a value:
 *   exactly ONE required parameter is missing, and
 *   exactly ONE supplied key is not in the schema at all
 *   → move that value onto the missing required name.
 * Anything more ambiguous is left alone; the handler's own error tells the
 * model what to fix.
 */

export interface ToolParamSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ArgRepair {
  args: Record<string, unknown>;
  /** `from → to` when a rename happened, else null. */
  renamed: { from: string; to: string } | null;
}

export function repairMissingRequiredArg(
  args: Record<string, unknown>,
  schema: ToolParamSchema | undefined,
): ArgRepair {
  const props = schema?.properties;
  const required = schema?.required;
  if (!props || !Array.isArray(required) || required.length === 0) return { args, renamed: null };

  const isPresent = (k: string) => {
    const v = args[k];
    return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
  };
  const missing = required.filter(k => !isPresent(k));
  if (missing.length !== 1) return { args, renamed: null };

  const unknown = Object.keys(args).filter(k => !(k in props) && isPresent(k));
  if (unknown.length !== 1) return { args, renamed: null };

  const [from] = unknown;
  const [to] = missing;
  const repaired: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === from) repaired[to] = v;
    else if (k !== to) repaired[k] = v;
  }
  return { args: repaired, renamed: { from, to } };
}
