import { hasNewAssistantReply, recoverReply, RECOVERY_DELAYS } from '@/lib/stream-recovery';
import type { Message } from '@/lib/types';

const SENT_AT = 1_700_000_000_000;

const msg = (over: Partial<Message>): Message => ({
  id: 'm', chatId: 'c', role: 'assistant', content: 'hi',
  toolCalls: null, toolResults: null, createdAt: new Date(SENT_AT + 1000),
  ...over,
} as Message);

describe('hasNewAssistantReply', () => {
  it('accepts an assistant reply written after we sent', () => {
    expect(hasNewAssistantReply([msg({ createdAt: new Date(SENT_AT + 34_000) })], SENT_AT)).toBe(true);
  });

  it('ignores an assistant reply that predates the send', () => {
    // The reply already on screen when the stream broke must not count.
    expect(hasNewAssistantReply([msg({ createdAt: new Date(SENT_AT - 1) })], SENT_AT)).toBe(false);
  });

  it('ignores the user message echoed back by the server', () => {
    expect(hasNewAssistantReply(
      [msg({ role: 'user', createdAt: new Date(SENT_AT + 5000) })], SENT_AT,
    )).toBe(false);
  });

  it('does not treat an unparseable timestamp as fresh', () => {
    expect(hasNewAssistantReply(
      [msg({ createdAt: 'not-a-date' as unknown as Date })], SENT_AT,
    )).toBe(false);
  });

  it('handles ISO strings, which is what the API actually returns', () => {
    expect(hasNewAssistantReply(
      [msg({ createdAt: new Date(SENT_AT + 1000).toISOString() as unknown as Date })], SENT_AT,
    )).toBe(true);
  });
});

describe('recoverReply', () => {
  const never = () => false;
  const instant = () => Promise.resolve();

  it('returns the messages once the reply lands', async () => {
    const late = [msg({ createdAt: new Date(SENT_AT + 34_000) })];
    let calls = 0;
    const out = await recoverReply({
      sentAt: SENT_AT,
      loadMessages: async () => (++calls < 3 ? [] : late),
      sleep: instant, isStale: never, delays: RECOVERY_DELAYS,
    });
    expect(out).toBe(late);
    expect(calls).toBe(3); // kept polling until it appeared
  });

  it('gives up after the last delay when nothing ever lands', async () => {
    let calls = 0;
    const out = await recoverReply({
      sentAt: SENT_AT,
      loadMessages: async () => { calls++; return []; },
      sleep: instant, isStale: never,
    });
    expect(out).toBeNull();
    expect(calls).toBe(RECOVERY_DELAYS.length);
  });

  it('abandons itself when a newer send supersedes it', async () => {
    // Must not overwrite a turn the user has already moved past.
    let calls = 0;
    const out = await recoverReply({
      sentAt: SENT_AT,
      loadMessages: async () => { calls++; return [msg({})]; },
      sleep: instant, isStale: () => true,
    });
    expect(out).toBeNull();
    expect(calls).toBe(0); // bailed before even reading
  });

  it('keeps trying when a poll throws', async () => {
    const late = [msg({ createdAt: new Date(SENT_AT + 9000) })];
    let calls = 0;
    const out = await recoverReply({
      sentAt: SENT_AT,
      loadMessages: async () => {
        if (++calls === 1) throw new Error('server unreachable');
        return late;
      },
      sleep: instant, isStale: never,
    });
    expect(out).toBe(late);
  });

  it('keeps trying when a poll returns null (non-ok response)', async () => {
    const late = [msg({ createdAt: new Date(SENT_AT + 9000) })];
    let calls = 0;
    const out = await recoverReply({
      sentAt: SENT_AT,
      loadMessages: async () => (++calls === 1 ? null : late),
      sleep: instant, isStale: never,
    });
    expect(out).toBe(late);
  });

  it('discards a result if a newer send starts during the final read', async () => {
    let stale = false;
    const out = await recoverReply({
      sentAt: SENT_AT,
      loadMessages: async () => { stale = true; return [msg({})]; },
      sleep: instant, isStale: () => stale,
    });
    expect(out).toBeNull();
  });
});
