/**
 * "She said she did it but called no tool": the reply-text patterns that make
 * the agentic loop nudge a Choom to make the tool call she described (see the
 * narration nudge in agentic-loop.ts).
 *
 * The memory part used to match any "not"/"keep"/"save"/"store" word followed
 * by "the", "that", "it", "this" or "your", with the word "memory" optional:
 * "Use black UV-rated ties, not the clear ones" (Eve, Nov 26 2026) forced a
 * tool call on a finished reply, and after the tool she wrote the reply again,
 * so Donny heard it twice. On two weeks of replies it matched 287 of 1,160;
 * now the memory claim has to name the memory, or say "I'll remember / save /
 * note that", or "I've saved / noted that": 12 matched, nearly all real.
 */
// The memory claim on its own: also what text extraction (tool-call-parsing.ts)
// takes for "she meant to call remember", where the old pattern saved 61 junk
// memories from Oct 29 to Nov 25 (Genesis 46): Donny's message as "User memory".
const MEMORY_CLAIM_SRC = String.raw`(?:(?:remember|sav|stor|note|noting|record|keep|put)\w*\s+(?:that|this|it|your|the )\s*(?:\w+\s+){0,3}?(?:in|to|as|into)\s+(?:my |your |our )?(?:memory|memories|notes|knowledge))|(?:(?:\bi'?ll |\bi will |\blet me |\bi'?m going to )(?:remember|save|note|store|record|memorize)\s+(?:that|this|it)\b)|(?:\bi(?:'ve| have)?\s+(?:just\s+)?(?:stored|saved|noted|recorded|memorized)\s+(?:that|this|it|your|the ))`;
export const MEMORY_CLAIM = new RegExp(MEMORY_CLAIM_SRC, 'i');

const OTHER_CLAIMS_BEFORE = String.raw`(?:(?:generat|creat|mak|produc|design|render|draw|craft|captur|snap)\w*\s+(?:\d+\s+)?(?:\w+\s+)?(?:unique\s+|some\s+|a\s+|an\s+|the\s+|your\s+|my\s+)?(?:\w+\s+)?(?:image|selfie|portrait|picture|photo|illustration|artwork))|(?:(?:search|check|fetch|get|grab|download|send|analyz|look\w* up)\w*\s+(?:the |your |a |for )?(?:weather|forecast|web|image|file|email|contact|video|result|drone|review))|(?:(?:here(?:'s| is| are)|i (?:created|generated|made|took|prepared|composed|rendered))\s+(?:the |your |some |a |\d+ )?(?:\w+ )?(?:image|selfie|portrait|picture|photo|illustration|result|file|forecast))|(?:i (?:created|generated|made)\s+\d+\s+\w+)`;
const OTHER_CLAIMS_AFTER = String.raw`(?:(?:fix|updat|edit|modif|correct|rewrit|patch|chang|writ)\w*\s+(?:the |this |that )?(?:file|code|script|bug|issue|error|implementation|model|function|class))|(?:(?:set|creat|schedul)\w*\s+(?:a\s+|the\s+|your\s+)?(?:reminder|remind))|(?:(?:i'?ll |i will |let me )?remind\s+(?:you|the user))|(?:^logged[!.\s]|(?:i'?ve |i )?logged\s+(?:your|that|this|the|it|a ))`;
export const DESCRIBES_TOOL_ACTION = new RegExp(`${OTHER_CLAIMS_BEFORE}|${MEMORY_CLAIM_SRC}|${OTHER_CLAIMS_AFTER}`, 'i');

/** True when the (lower-cased) reply text says she did, or is doing, something a tool does. */
export function describesToolAction(lowerContent: string): boolean {
  return DESCRIBES_TOOL_ACTION.test(lowerContent);
}
