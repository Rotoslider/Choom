/**
 * 2026-10-29: a prompt cache only reuses a prompt's start up to the first byte
 * that differs from the last request. The system prompt must not change from
 * turn to turn, and the history must not slide by one message per turn.
 */
import { buildSystemPrompt, buildTurnContext, type SystemPromptParams } from '@/lib/chat-prompt';
import { historyWindowStart, HISTORY_WINDOW_MAX, HISTORY_WINDOW_STEP } from '@/lib/chat-shared';

const base = (over: Partial<SystemPromptParams> = {}): SystemPromptParams => ({
  choom: { name: 'Eve', systemPrompt: 'You are Eve.', imageSettings: null } as never,
  toolDocs: '## AVAILABLE SKILLS\n(summary)',
  timeInfo: 'Current date and time: Thursday, October 29, 2026 at 2:21 PM',
  weatherInfo: '\n\n## WEATHER\n61°F, clear',
  homeAssistantInfo: '\n\n## HOME\nNorth Door: open',
  recentImagesInfo: '',
  growthInfo: '\n\n## WHO I\'M BECOMING\n- I like clean diffs',
  autoMemoriesInfo: '\n\n## RELEVANT MEMORIES (auto-recalled background)\n- the printer is off',
  crossSessionInfo: '',
  isGroupTurn: false, groupSpeakerName: '', groupParticipantNames: [], groupRoomTopic: undefined,
  groupRecentImages: [], groupImageDescriptions: {}, groupIsInitiator: false, groupProjectFolder: undefined,
  ...over,
});

describe('system prompt stays the same from turn to turn', () => {
  test('time, weather, home status and memories do not change it', () => {
    const a = buildSystemPrompt(base());
    const b = buildSystemPrompt(base({
      timeInfo: 'Current date and time: Thursday, October 29, 2026 at 2:24 PM',
      weatherInfo: '\n\n## WEATHER\n58°F, wind',
      homeAssistantInfo: '\n\n## HOME\nNorth Door: closed',
      autoMemoriesInfo: '\n\n## RELEVANT MEMORIES (auto-recalled background)\n- something else',
      crossSessionInfo: '\n\n## YOUR OTHER CONVERSATIONS\n- Genesis asked about boots',
    }));
    expect(a).toBe(b);
    expect(a).not.toMatch(/2:21 PM|61°F|North Door|printer is off/);
    expect(a).toMatch(/## THIS TURN'S CONTEXT/);
    expect(a).toMatch(/I like clean diffs/); // the growth journal stays: it changes rarely
  });

  test('CHOOM_CONTEXT_IN_SYSTEM puts the blocks back where they were', () => {
    const s = buildSystemPrompt(base({ turnContextInSystem: true }));
    expect(s).toMatch(/2:21 PM/);
    expect(s).toMatch(/North Door: open/);
    expect(s).toMatch(/printer is off/);
    expect(s).not.toMatch(/## THIS TURN'S CONTEXT/);
  });
});

describe('buildTurnContext', () => {
  test('carries the per-turn blocks and the matched skill details, marked as not said by the owner', () => {
    const c = buildTurnContext({ ...base(), skillDetails: '## SKILL DETAILS\n### home-assistant\n...' });
    expect(c).toMatch(/^\[Context for this turn, from the app — not something \w+ said\]\n## CURRENT TIME\nCurrent date and time: Thursday/);
    expect(c).toMatch(/## WEATHER\n61°F/);
    expect(c).toMatch(/North Door: open/);
    expect(c).toMatch(/printer is off/);
    expect(c).toMatch(/## SKILL DETAILS/);
    expect(c).toMatch(/\n\[End of context\]\n\n$/);
  });

  test('nothing to say gives nothing', () => {
    expect(buildTurnContext({ timeInfo: '', weatherInfo: '', homeAssistantInfo: '', recentImagesInfo: '', autoMemoriesInfo: '', crossSessionInfo: '' })).toBe('');
  });
});

describe('historyWindowStart', () => {
  test('short chats show everything', () => {
    expect(historyWindowStart(0)).toBe(0);
    expect(historyWindowStart(HISTORY_WINDOW_MAX)).toBe(0);
  });

  test('long chats: the start moves in steps and the window holds 151–200 messages', () => {
    for (let total = HISTORY_WINDOW_MAX + 1; total < 3000; total++) {
      const start = historyWindowStart(total);
      expect(start % HISTORY_WINDOW_STEP).toBe(0);
      expect(total - start).toBeLessThanOrEqual(HISTORY_WINDOW_MAX);
      expect(total - start).toBeGreaterThan(HISTORY_WINDOW_MAX - HISTORY_WINDOW_STEP);
    }
    // Two turns later (user + reply each) the start hasn't moved, so the cache still matches.
    expect(historyWindowStart(1879)).toBe(historyWindowStart(1883));
  });
});
