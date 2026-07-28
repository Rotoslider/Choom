/**
 * detectClaimedTool — maps a fabricated-success claim to the tool it claimed.
 *
 * Powers C-32: when a Choom says she did something without calling a tool, the
 * next iteration is narrowed to that ONE tool with tool_choice='required'.
 * Measured on qwen at production context length, the old broad nudge recovered
 * ha_get_camera_snapshot 0/3; single-tool recovered 3/3.
 *
 * The false-positive cases matter as much as the true ones: narrowing to the
 * WRONG tool would force a call the user never asked for. When nothing matches,
 * the loop must fall back to the broad nudge rather than guess.
 */
import { detectClaimedTool } from '../lib/phantom-claim';

const ALL = new Set([
  'ha_get_camera_snapshot', 'create_reminder', 'remember', 'search_memories', 'web_search',
  'generate_image', 'get_weather', 'get_calendar_events', 'send_notification',
  'ha_call_service', 'log_habit', 'workspace_write_file', 'schedule_self_followup',
  'analyze_image',
]);

describe('detectClaimedTool — real phantom phrasings', () => {
  const cases: Array<[string, string]> = [
    ["Got it, my love — I've saved that to memory. The well pump needs a new pressure switch.", 'remember'],
    ['I just pulled up the tower cam! It looks clear out there.', 'ha_get_camera_snapshot'],
    ["I checked for you — it's about 98°F out there right now.", 'get_weather'],
    ["Done! I've set that reminder for 9am tomorrow to call the dentist.", 'create_reminder'],
    ['I looked it up — short cycling is usually a waterlogged pressure tank.', 'web_search'],
    ['Looking back through my memories, I recall the Mount Graham trip.', 'search_memories'],
    ["Here's the selfie I generated for you, standing by the truck.", 'generate_image'],
    ['I checked your calendar — you have two appointments tomorrow.', 'get_calendar_events'],
    ['I turned on the shop lights for you.', 'ha_call_service'],
    ["Logged! That's your third shower this week.", 'log_habit'],
    // User-reported phantom: claims a self-followup that was never queued.
    ["I'll check back with you later tonight to see how the pump held up.", 'schedule_self_followup'],
    ["I've queued a follow-up so I can check in tomorrow.", 'schedule_self_followup'],
    ['I looked at the image you sent — the fitting looks corroded.', 'analyze_image'],
  ];
  test.each(cases)('%s -> %s', (text, expected) => {
    expect(detectClaimedTool(text, ALL)).toBe(expected);
  });
});

describe('must NOT force a tool', () => {
  const noMatch = [
    'I love you too, Donny. Today was a good day.',
    'That sounds really frustrating. Do you want to talk about it?',
    'The truck is blue and parked under the awning.',
    'I think the pressure switch is the likely culprit, based on what you described.',
  ];
  test.each(noMatch)('plain conversation returns null: %s', (t) => {
    expect(detectClaimedTool(t, ALL)).toBeNull();
  });

  it('never returns a tool that is not available this turn', () => {
    // Camera stripped (e.g. noTools mode or a group turn) — must not force it.
    const without = new Set([...ALL].filter(n => n !== 'ha_get_camera_snapshot'));
    expect(detectClaimedTool('I just pulled up the tower cam!', without)).not.toBe('ha_get_camera_snapshot');
  });

  it('returns null when no tools are available at all', () => {
    expect(detectClaimedTool("I've saved that to memory.", new Set())).toBeNull();
  });
});

describe('specificity — camera beats generic checking', () => {
  it('prefers the camera tool over weather for a camera claim', () => {
    expect(detectClaimedTool('I checked the tower cam and it looks hot out there', ALL))
      .toBe('ha_get_camera_snapshot');
  });
  it('prefers reminder over remember for a reminder claim', () => {
    expect(detectClaimedTool("I've set a reminder for you to call the dentist", ALL))
      .toBe('create_reminder');
  });
  it('routes a reminder FOR DONNY to create_reminder, not self-followup', () => {
    // The two are easy to confuse and the distinction matters: one messages
    // Donny, the other queues her own future turn.
    expect(detectClaimedTool('I set a reminder for you to call the dentist tomorrow', ALL))
      .toBe('create_reminder');
  });
});
