import { sanitizeMessages } from '../lib/llm-client';
import type { ChatMessage } from '../lib/llm-client';

/**
 * Regression tests for the HTTP 400 seen in production:
 *
 *   "Unable to generate parser for this template... Jinja Exception:
 *    System message must be at the beginning."
 *
 * Qwen/ChatML GGUF templates raise on any system turn after index 0. The
 * sanitizer is the single choke point that guarantees the wire format is
 * valid for the strictest consumer.
 */
describe('sanitizeMessages', () => {
  it('hoists a late system message to the front (the reported crash)', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are Optic.' },
      { role: 'user', content: 'play some music' },
      { role: 'system', content: '[Tool guidance] use music_play' },
    ];

    const out = sanitizeMessages(msgs);

    // Exactly one system message, and it is first.
    const systemIdx = out
      .map((m, i) => (m.role === 'system' ? i : -1))
      .filter(i => i >= 0);
    expect(systemIdx).toEqual([0]);
    // Late guidance is preserved, not silently dropped.
    expect(out[0].content).toContain('You are Optic.');
    expect(out[0].content).toContain('[Tool guidance] use music_play');
  });

  it('never emits a system message at a non-zero index, however many there are', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'A' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'B' },
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: 'C' },
      { role: 'user', content: 'bye' },
    ];

    const out = sanitizeMessages(msgs);

    out.forEach((m, i) => {
      if (m.role === 'system') expect(i).toBe(0);
    });
    expect(out[0].content).toBe('A\n\nB\n\nC');
  });

  it('drops empty assistant turns with no tool_calls', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'still there?' },
    ];
    expect(sanitizeMessages(msgs)).toHaveLength(2);
  });

  it('keeps empty assistant turns that carry tool_calls', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
      },
      { role: 'tool', content: '72F', tool_call_id: 't1' },
    ];
    expect(sanitizeMessages(msgs)).toHaveLength(3);
  });

  it('does not end on an assistant turn (providers forcing a generation prompt)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'thinking...' },
    ];
    const out = sanitizeMessages(msgs);
    expect(out[out.length - 1].role).toBe('user');
  });

  it('ignores blank system content rather than emitting an empty head turn', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '   ' },
      { role: 'user', content: 'hi' },
    ];
    const out = sanitizeMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('leaves an already-valid conversation untouched', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are Optic.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'how are you' },
    ];
    expect(sanitizeMessages(msgs)).toEqual(msgs);
  });
});
