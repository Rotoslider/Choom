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

/** Tools that take something back: cancel_self_followup, delete_memory, update_calendar_event, … */
const UNDOES = /(?:^|_)(?:cancel|delete|remove|clear|edit|update|unschedule)(?:_|$)/;

export function undoesSomething(tool: string): boolean {
  return UNDOES.test(tool);
}

/**
 * A change that takes something back also makes the cached answers of the changes before it
 * stale. On 2026-11-05 Genesis cancelled her 8:40 and 10:40 routines to reword them and sent the
 * same schedule calls again; the cache answered "already scheduled" from before the cancels, so
 * nothing was queued and she called them cached copies.
 *
 * After an undoing tool (cancel/delete/remove/clear/edit/update), this drops the cached changes
 * of the same skill (`familyOf`, e.g. the skill a tool belongs to) and their repeat counts, so a
 * schedule → cancel → schedule really schedules again. It keeps `keptKey` (the call just made),
 * reads (dropStaleReads handles those), and everything else: a remember or a send_notification
 * repeated with nothing undone in between is still answered from the cache.
 */
export function dropUndoneChanges(
  readOnly: ReadonlySet<string>,
  tool: string,
  keptKey: string,
  familyOf: (tool: string) => string | undefined,
  ...caches: Map<string, unknown>[]
): void {
  if (readOnly.has(tool) || !undoesSomething(tool)) return;
  const family = familyOf(tool);
  if (!family) return;
  for (const cache of caches) {
    for (const key of [...cache.keys()]) {
      if (key === keptKey) continue;
      const name = key.slice(0, key.indexOf(':'));
      if (!readOnly.has(name) && familyOf(name) === family) cache.delete(key);
    }
  }
}
