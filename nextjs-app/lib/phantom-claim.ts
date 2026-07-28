/**
 * Map a fabricated-success claim to the tool it claimed to have used.
 *
 * When a Choom says "I've saved that to memory" or "I just pulled up the tower
 * cam" without emitting a tool call, nudging with all 132 tools still fails —
 * measured on qwen at production context length, ha_get_camera_snapshot
 * recovered 0/3 that way. Narrowing the array to the ONE claimed tool and
 * forcing tool_choice='required' recovered 3/3 for every tool tested, at both
 * short and long context. With a single option there is nothing else the model
 * can emit.
 *
 * Ordered most-specific first; only ever returns a tool that is actually
 * available this turn.
 */
export function detectClaimedTool(text: string, available: Set<string>): string | null {
  const CLAIMS: Array<[RegExp, string]> = [
    [/\b(?:tower\s*cam|garage\s*cam|camera|webcam|snapshot)\b/i, 'ha_get_camera_snapshot'],
    [/\b(?:set|created|scheduled)\b[^.!?]{0,40}\breminder\b|\bremind(?:ed)? you\b/i, 'create_reminder'],
    [/\b(?:saved|stored|noted|recorded|memoriz\w+|remembered)\b[^.!?]{0,60}\b(?:memory|memories|notes?)\b|\bi(?:'ve| have)?\s*(?:saved|stored|noted|remembered)\s+(?:that|this|it)\b/i, 'remember'],
    [/\b(?:looking|looked|searching|searched)\b[^.!?]{0,40}\b(?:through )?(?:my |your )?memor(?:y|ies)\b/i, 'search_memories'],
    [/\b(?:searched|looked (?:it )?up|googled|web search)\b/i, 'web_search'],
    // Both orders occur in the wild: "generated a selfie" AND "here's the
    // selfie I generated". Only the first was matched originally.
    [/\b(?:generated|created|made|rendered|drew)\b[^.!?]{0,40}\b(?:image|selfie|picture|photo|portrait)\b/i, 'generate_image'],
    [/\b(?:image|selfie|picture|photo|portrait)\b[^.!?]{0,40}\b(?:i |i've |i have )?(?:generated|created|made|rendered|drew)\b/i, 'generate_image'],
    [/\b(?:checked|pulled up|looked at)\b[^.!?]{0,30}\b(?:weather|temperature|forecast)\b|\bit(?:'s| is)\s+(?:about\s+)?-?\d{1,3}\s*(?:°|degrees)/i, 'get_weather'],
    [/\b(?:checked|looked at|pulled up)\b[^.!?]{0,30}\b(?:calendar|schedule)\b/i, 'get_calendar_events'],
    [/\b(?:sent|delivered)\b[^.!?]{0,30}\b(?:notification|alert)\b/i, 'send_notification'],
    [/\b(?:turned (?:on|off)|switched (?:on|off)|activated)\b/i, 'ha_call_service'],
    [/\b(?:logged)\b[^.!?]{0,20}\bhabit\b|^\s*logged[!.]/i, 'log_habit'],
    // Named by the user as a frequent phantom: "I've set myself a reminder to
    // check back", "I'll follow up with you later" — she says it and never
    // queues it. Distinct from create_reminder, which messages DONNY; this one
    // is her own future turn. Ordered AFTER create_reminder so an explicit
    // "reminder for you" still routes there.
    [/\b(?:follow[- ]?up|check back|circle back|ping you|come back to (?:this|you))\b[^.!?]{0,40}\b(?:later|tonight|tomorrow|in \d+|shortly|soon)\b|\bi(?:'ve| have)?\s*(?:queued|scheduled|set)\b[^.!?]{0,30}\b(?:follow[- ]?up|check-?in|reminder to myself)\b/i, 'schedule_self_followup'],
    [/\b(?:analyz|look\w*|examin|check\w*)\w*\b[^.!?]{0,25}\b(?:the |that |this |your )?(?:image|photo|picture|screenshot|snapshot)\b/i, 'analyze_image'],
    [/\b(?:searched|looked)\b[^.!?]{0,30}\b(?:the )?web\b/i, 'web_search'],
    [/\b(?:wrote|saved|created)\b[^.!?]{0,30}\bfile\b/i, 'workspace_write_file'],
  ];
  for (const [re, tool] of CLAIMS) {
    if (re.test(text) && available.has(tool)) return tool;
  }
  return null;
}
