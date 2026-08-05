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
    // 'updated' is in the verb list because "I have updated my memory with
    // the details" is a phantom observed in production (C-43) that the
    // original list missed — it fell through to the broad nudge.
    [/\b(?:saved|stored|noted|recorded|updated|memoriz\w+|remembered)\b[^.!?]{0,60}\b(?:memory|memories|notes?)\b|\bi(?:'ve| have)?\s*(?:saved|stored|noted|remembered)\s+(?:that|this|it)\b/i, 'remember'],
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
    // "I just ran the scan — here's the breakdown of the workspace root" with
    // an invented listing was the C-52 incident: no listing claim was in this
    // table, so the zero-tool turn had nothing to narrow to.
    [/\b(?:ran|run|did|completed|finished)\b[^.!?]{0,30}\b(?:the )?(?:scan|listing|file list)\b|\b(?:listed|scanned)\b[^.!?]{0,40}\b(?:files?|folders?|workspace|director(?:y|ies))\b|\bworkspace root\b/i, 'workspace_list_files'],
    [/\b(?:read|opened|pulled up)\b[^.!?]{0,30}\b(?:the |your |that )?(?:file|document|pdf)\b/i, 'workspace_read_file'],
  ];
  for (const [re, tool] of CLAIMS) {
    if (re.test(text) && available.has(tool)) return tool;
  }
  return null;
}

/**
 * Structural phantom signal: markdown image refs whose ids exist nowhere in
 * the prior conversation. A real ![...](image:id) always carries an id that
 * either came back from generate_image THIS turn (callers must exclude that
 * case) or was echoed from an earlier message in context. A fabricated ref
 * carries an id the model invented — in production it mutates a real id from
 * context (C-45: real cmrxn8spq... became fake cmrxp8spq...). Unlike the
 * linguistic claim patterns above, this cannot false-positive: presenting
 * image markdown with an id that has never existed IS the fabrication.
 */
export function findFabricatedImageRefs(text: string, priorContents: string[]): string[] {
  const ids = [...text.matchAll(/\]\(image:([a-zA-Z0-9_-]+)\)/g)].map(m => m[1]);
  if (ids.length === 0) return [];
  return ids.filter(id => !priorContents.some(c => c && c.includes(`image:${id}`)));
}

// A completed-action claim about THIS turn ("I just ran the scan", "I've
// checked the weather", "here's the breakdown"). Deliberately requires an
// immediacy shape — bare narration ("let me check…") and future intent stay
// out; those are the planning nudge's territory.
const THIS_TURN_CLAIM = /\bi(?:'ve| have)? (?:just |now )?(?:ran|run|called|executed|checked|scanned|pulled(?: up)?|fetched|queried|listed|looked up|searched|grabbed|retrieved|updated|saved|stored|noted|logged)\b[^.!?\n]{0,80}|\bjust (?:ran|did|finished|completed|pulled|checked|scanned)\b[^.!?\n]{0,60}|\bhere(?:'s| is) (?:the|what) (?:breakdown|results?|listing|scan|report|readout)\b/i;

// Honest recaps of PAST actions anchor themselves in time ("I already sent
// that yesterday", "when I checked earlier"). A claim whose own sentence
// carries a past anchor is conversation, not a fabrication of this turn.
const PAST_ANCHOR = /\b(?:yesterday|earlier(?: today)?|last (?:night|week|month|time)|this morning|the other day|a while (?:ago|back)|previously|before(?: that)?|back (?:then|when)|already (?:did|done|sent|took)|when (?:we|you|i) (?:talked|spoke|did|were))\b/i;

/**
 * Zero-tool fabricated-success detector (C-52). The C-46 zero-tool check only
 * catches IMAGE fabrication; a turn that claims "I just ran the scan" and
 * presents an invented file listing sailed through with zero nudges (observed
 * live at 82k prompt tokens). This is its linguistic counterpart, triple-gated
 * to protect ordinary conversation:
 *   1. the text must contain a completed-THIS-TURN action claim,
 *   2. that claim's own sentence must not be anchored in the past,
 *   3. the claim window must map to a specific available tool
 *      (detectClaimedTool) — otherwise there is nothing to force and the
 *      match is treated as conversation.
 * Measured before wiring (2026-08-04): on all 333 real assistant messages in
 * the DB, the only zero-tool turn it fires on is the actual fabrication
 * incident; 0 false positives on honest past-recap sentences.
 */
export function detectZeroToolClaim(text: string, available: Set<string>): string | null {
  const m = text.match(THIS_TURN_CLAIM);
  if (!m || m.index === undefined) return null;
  const idx = m.index;
  const sentStart = Math.max(text.lastIndexOf('.', idx), text.lastIndexOf('!', idx), text.lastIndexOf('?', idx), text.lastIndexOf('\n', idx)) + 1;
  const ends = [text.indexOf('.', idx), text.indexOf('!', idx), text.indexOf('?', idx), text.indexOf('\n', idx)].filter(i => i >= 0);
  const sentEnd = ends.length ? Math.min(...ends) + 1 : text.length;
  const sentence = text.slice(sentStart, sentEnd);
  if (PAST_ANCHOR.test(sentence)) return null;
  // Tool mapping is scoped to the claim's neighborhood so an unrelated
  // keyword three paragraphs away can't select the wrong tool.
  const window = sentence.length >= 200 ? sentence : text.slice(sentStart, idx + 200);
  return detectClaimedTool(window, available);
}
