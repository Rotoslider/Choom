import { changedSince, mergeSince, newestSaved, prependOlder } from '@/lib/chat-messages';
import type { Message } from '@/lib/types';

const msg = (id: string, at: string, content = id): Message =>
  ({ id, chatId: 'c', role: 'assistant', content, toolCalls: null, toolResults: null, createdAt: at as unknown as Date });

test('the newest saved message, not a send still on its way', () => {
  expect(newestSaved([])).toBeNull();
  expect(newestSaved([msg('a', '2026-10-28T10:00:00Z'), msg('b', '2026-10-28T10:05:00Z'), msg('temp-1', '2026-10-28T11:00:00Z')]))
    .toBe('2026-10-28T10:05:00.000Z');
});

test('what came since replaces the tail, keeps what came before, and drops the temporary words', () => {
  const current = [msg('a', '2026-10-28T10:00:00Z'), msg('b', '2026-10-28T10:05:00Z', 'old'), msg('temp-1', '2026-10-28T10:06:00Z')];
  const fresh = [msg('b', '2026-10-28T10:05:00Z', 'edited'), msg('u', '2026-10-28T10:06:01Z'), msg('r', '2026-10-28T10:06:30Z')];
  expect(mergeSince(current, fresh, '2026-10-28T10:05:00.000Z').map((m) => `${m.id}:${m.content}`))
    .toEqual(['a:a', 'b:edited', 'u:u', 'r:r']);
  // the server dropped its last message: it goes here too
  expect(mergeSince(current, [], '2026-10-28T10:05:00.000Z').map((m) => m.id)).toEqual(['a']);
});

test('the chat list says when the open chat changed after what is on screen', () => {
  expect(changedSince('2026-10-28T10:06:00Z', '2026-10-28T10:05:00.000Z')).toBe(true);
  expect(changedSince('2026-10-28T10:05:00Z', '2026-10-28T10:05:00.000Z')).toBe(false);
  expect(changedSince('2026-10-28T10:06:00Z', null)).toBe(false);
});

test('earlier messages go in front, without doubling any already there', () => {
  const current = [msg('c', '2026-10-28T10:02:00Z'), msg('d', '2026-10-28T10:03:00Z')];
  const older = [msg('a', '2026-10-28T10:00:00Z'), msg('b', '2026-10-28T10:01:00Z'), msg('c', '2026-10-28T10:02:00Z')];
  expect(prependOlder(current, older).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
});

