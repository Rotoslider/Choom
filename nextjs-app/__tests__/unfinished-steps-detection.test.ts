/**
 * C-49: the send_notification "unfinished step" check.
 *
 * Found live (2026-07-28) while testing Eve and Optic in the browser. The
 * old pattern matched a bare "tell me" or "let me know", which is simply how
 * the owner asks for an answer IN THE CHAT he is currently typing in. A
 * routine "use fetch_url and tell me what it says" therefore ended with:
 *   - Eve (qwen) sending an unrequested Signal notification, and
 *   - Optic (gemma) refusing correctly, being re-nudged three times, and
 *     telling the owner she felt "gaslit by a glitchy piece of software".
 *
 * The regex under test is duplicated here deliberately: the route's copy
 * lives inside a 6,000-line request handler and cannot be imported. Keep the
 * two in sync — the tests below encode the intent.
 */
const NOTIFY_RE = /\b(?:send|text|message|ping|notify)\s+(?:me|us|donny)\b|\bsend\s+(?:a\s+)?(?:notification|signal|message|text)\b|\b(?:notification|signal message)\b|\blet me know\b[^.!?]{0,30}\b(?:on|via|over)\b[^.!?]{0,20}\b(?:signal|phone|text)\b/i;

describe('must NOT demand send_notification for ordinary chat requests', () => {
  const chatty = [
    'Tool test please: use fetch_url on https://example.com and tell me in one sentence what that page says.',
    'tell me what the weather is doing',
    'Check the tower cam and tell me if the gate is open',
    'let me know what you think',
    'let me know when the training run finishes',
    'Can you tell me more about terrain-adaptive retargeting?',
    'tell me a story about the homestead',
    'What did you find? Tell me everything.',
  ];
  test.each(chatty)('no notification demanded: %s', (msg) => {
    expect(NOTIFY_RE.test(msg)).toBe(false);
  });
});

describe('still fires when the owner actually asks to be messaged', () => {
  const explicit = [
    'send me a notification when the pump cycles',
    'text me when the UPS truck shows up',
    'ping me if the temperature drops below freezing',
    'notify me when the render is done',
    'send a signal message with the results',
    'send a notification to my phone',
    'grab a snapshot and message me the picture',
    'let me know on Signal when it is finished',
  ];
  test.each(explicit)('notification demanded: %s', (msg) => {
    expect(NOTIFY_RE.test(msg)).toBe(true);
  });
});
