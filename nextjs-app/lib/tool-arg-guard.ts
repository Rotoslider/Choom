/**
 * Required-argument validation that CORRECTS the model instead of confusing it.
 *
 * The failure this exists for (C-50): upload_to_drive failed 11 of 11 calls.
 * The model passed `path`, the tool read `workspace_path`, and Node's
 * path.join then threw:
 *
 *   The "path" argument must be of type string. Received undefined
 *
 * To a 31-35B model that reads as "your path argument was bad" — so it
 * retried with `path` again, and again. The error text actively taught the
 * wrong parameter name. A 100% failure rate that looked like a broken
 * integration was really a naming mismatch nobody could see.
 *
 * Per the small-model principle: the error must carry the correction inline —
 * the right parameter name, what was actually received, and the exact call to
 * make next. A model that cannot infer the fix will otherwise loop until the
 * per-tool cap locks it out.
 */

/** Common wrong names, by the parameter they are usually meant for. */
const ALIASES: Record<string, string[]> = {
  workspace_path: ['path', 'file_path', 'filepath', 'file', 'filename', 'source_path'],
  image_path: ['path', 'file_path', 'filepath', 'image', 'img', 'file'],
  path: ['file_path', 'filepath', 'workspace_path', 'file'],
  query: ['q', 'search', 'search_query', 'text'],
  message: ['text', 'body', 'content', 'msg'],
};

export interface RequireStringArgOptions {
  /** Shown when nothing usable was sent, e.g. 'choom_commons/report.pdf'. */
  example?: string;
  /** Extra alias names beyond the built-in list. */
  aliases?: string[];
}

/**
 * Return the value of a required string argument, or throw an error written
 * for a small model to act on.
 *
 * @param toolName    for the corrected example call
 * @param args        the tool call's arguments
 * @param name        the parameter the tool actually reads
 */
export function requireStringArg(
  toolName: string,
  args: Record<string, unknown> | undefined,
  name: string,
  opts: RequireStringArgOptions = {},
): string {
  const value = args?.[name];
  if (typeof value === 'string' && value.trim()) return value;

  const provided = Object.keys(args || {});
  const candidates = [...(opts.aliases || []), ...(ALIASES[name] || [])];
  const aliased = candidates.find(k => typeof args?.[k] === 'string' && (args[k] as string).trim());

  const sent = provided.length ? ` You sent: ${provided.join(', ')}.` : ' You sent no arguments.';
  const fix = aliased
    ? ` Rename "${aliased}" to "${name}" and call again: ${toolName} with ${name}="${args![aliased] as string}".`
    : opts.example
      ? ` Pass it like: ${toolName} with ${name}="${opts.example}".`
      : ` Pass "${name}" as a string.`;

  throw new Error(`Missing required parameter "${name}" for ${toolName}.${sent}${fix}`);
}
