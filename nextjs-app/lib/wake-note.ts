/**
 * The note a self-followup wake-up carries, without the scheduler's awareness
 * block (time, presence, note age, grounding instructions). The scheduler
 * always closes that block with the "[Scheduling is housekeeping …]" line, so
 * everything after it is the note she wrote; a message without that line is
 * returned unchanged.
 *
 * Two readers must see only the note: the unfinished-steps heuristic (the
 * grounding sentence read as an owed "read file" step — 43 of 44 nudges on
 * 2026-09-27/28) and the wake-up's memory auto-recall, which embedded the
 * boilerplate and recalled the same "how I self-schedule" memories on every
 * wake-up instead of anything the note was about.
 */
export function wakeNoteTask(message: string): string {
  const housekeeping = message.match(/\[Scheduling is housekeeping[^\]]*\]/i);
  if (housekeeping?.index === undefined) return message;
  return message.slice(housekeeping.index + housekeeping[0].length).replace(/^\s+/, '');
}
