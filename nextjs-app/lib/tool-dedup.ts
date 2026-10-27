/**
 * The agentic loop answers a repeated tool call (same name, same arguments) from the turn's cache,
 * so a stuck model can't run the same thing over and over. A read that comes after a change has to
 * run again, though: on 2026-10-26 Genesis cancelled her old trip watch, checked with
 * list_self_followups, and was handed the list from before the cancel. She took it that the routine
 * had re-queued itself and cancelled again, which was answered from the cache too.
 *
 * After a tool that isn't read-only, this drops the cached reads (and their repeat counts) from the
 * given maps, keyed `${toolName}:${args}`. A repeat of the change itself stays cached.
 */
export function dropStaleReads(readOnly: ReadonlySet<string>, tool: string, ...caches: Map<string, unknown>[]): void {
  if (readOnly.has(tool)) return;
  for (const cache of caches) {
    for (const key of [...cache.keys()]) {
      if (readOnly.has(key.slice(0, key.indexOf(':')))) cache.delete(key);
    }
  }
}
