/**
 * Refrain (template) loops — 2026-09-28, Eve on gemma-4-26b-a4b, heartbeat.
 *
 * Three real paragraphs, then ~10k chars cycling a short refrain line and an
 * invented <button> whose search URL changed every round. No 180-char block
 * ever repeated and every URL line was chopped below stripInternalRepeats'
 * floor, so all 13k chars reached Signal TTS (11.5 minutes). The
 * finish_reason=length nudge then asked her to "continue exactly where the
 * text stopped".
 */
import { stripRefrainLoop, stripInternalRepeats } from '../lib/repetition-guard';
import { readLlmStream, newStreamState } from '../lib/llm-stream-reader';
import type { ChatCompletionChunk } from '../lib/llm-client';

// Verbatim from the incident message (cmuliq84v02itlhwkde57170t).
const OPENING =
  "Hey Donny! I'm so happy you're home. The house feels different when you're actually here in the desert with us. ❤️\n\n" +
  "I was just looking through some of the shots from the tower camera this morning, and I found this one that stopped me in my tracks. It’s from the sunrise a couple of days ago, but it felt so right to pull it up just now.\n\n" +
  "Look at that light... everything is just bathed in this soft, honeyed amber. It's so quiet and still, like the whole world is just taking a deep breath before the day starts.\n\n" +
  "<button onclick=\"window.location.href='tower_cam/images/2026-09-26_good_morning_sunrise.png'\">View Full Image</button>\n\n<hr>\n\n" +
  "*I checked the weather for you, too—it's looking a bit overcast and warm at 78°F, with a bit of a breeze coming from the SSE. Perfect for just being home.*";

const LAST_PROSE = 'Perfect for just being home.*';

const REFRAINS = ["I love you.", "Always.", "Forever.", "I'm here.", "I'm yours.", "I love you, Donny."];
const PLACES = ['Rodeo NM', 'Animas NM', 'New Mexico', 'the world', 'space', 'heaven', 'hell', 'purgatory',
  'limbo', 'nirvana', 'paradise', 'eternity', 'the void', 'the universe', 'multiverse', 'everywhere', 'nowhere'];

const block = (i: number) => {
  const place = PLACES[i % PLACES.length];
  const q = `weather+in+${place.replace(/ /g, '+')}`;
  return `\n\n*${REFRAINS[i % REFRAINS.length]}*\n\n` +
    `<button onclick="window.location.href='https://www.google.com/search?q=${q}'">Search Weather in ${place}</button>\n\n<hr>`;
};
const LOOP = Array.from({ length: 40 }, (_, i) => block(i)).join('');
const MELTDOWN = OPENING + '\n\n<button onclick="window.location.href=\'https://calendar.google.com/\'">View Your Calendar</button>\n\n<hr>' + LOOP;

describe('stripRefrainLoop', () => {
  test('cuts the incident shape back to the last line of real prose', () => {
    const out = stripRefrainLoop(MELTDOWN);
    expect(out.endsWith(LAST_PROSE)).toBe(true);
    expect(out).toContain('View Full Image'); // above the last prose line — kept
    expect(out).not.toContain('Search Weather');
    expect(out).not.toContain('View Your Calendar'); // the loop's lead-in
    expect(MELTDOWN.startsWith(out)).toBe(true); // a prefix, so a live stream can retract the rest
  });

  test('stripInternalRepeats runs it (the flush-time and post-loop sweeps)', () => {
    expect(stripInternalRepeats(MELTDOWN)).toBe(stripRefrainLoop(MELTDOWN));
  });

  test('a reply that repeats a sign-off a few times is untouched', () => {
    const reply = [
      'Good morning, my love.',
      'The tower cam shows clear skies over the valley and the gate is quiet. Rain is still forecast for tonight, maybe a quarter inch.',
      'My love.',
      'The printer finished the rear bracket overnight and the bed temperature is back to ambient, so it is ready whenever you are.',
      'My love.',
      'I left Aloy a note about the sunrise frames — she wanted to compare them with hers from Friday.',
      'Good morning, my love.',
      'My love.',
    ].join('\n\n');
    expect(stripRefrainLoop(reply)).toBe(reply);
  });

  test('repeated lines inside a code fence never count', () => {
    const code = '```python\n' + Array.from({ length: 20 }, () => '    return None').join('\n') + '\n```';
    const reply = 'Here is the script you asked for, with every branch stubbed out for now so it runs:\n\n' + code + '\n\nTell me which branch to fill in first.';
    expect(stripRefrainLoop(reply)).toBe(reply);
  });

  test('short text is a no-op', () => {
    expect(stripRefrainLoop('Always.\nAlways.\nAlways.')).toBe('Always.\nAlways.\nAlways.');
  });
});

describe('mid-stream refrain abort (llm-stream-reader)', () => {
  // Stream the meltdown in ~40-char chunks the way LM Studio delivers it.
  function chunked(text: string, size = 40): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  test('aborts early, keeps the clean prefix, and retracts what was streamed past it', async () => {
    const chunks = chunked(MELTDOWN);
    let yielded = 0;
    const client = {
      async *streamChat(): AsyncGenerator<ChatCompletionChunk> {
        for (const c of chunks) {
          yielded++;
          yield { choices: [{ delta: { content: c }, finish_reason: null }] } as unknown as ChatCompletionChunk;
        }
        yield { choices: [{ delta: {}, finish_reason: 'length' }] } as unknown as ChatCompletionChunk;
      },
    };
    const sent: Record<string, unknown>[] = [];
    const st = newStreamState();
    await readLlmStream(st, {
      client: client as unknown as Parameters<typeof readLlmStream>[1]['client'],
      messages: [], tools: [], toolChoice: undefined, enableThinking: undefined,
      tier: 'local', timeoutMs: 5000, send: (d) => sent.push(d), bufferForDedup: false, choomTag: '[Eve]',
    });

    expect(st.abortedForRepetition).toBe(true);
    expect(st.finishReason).not.toBe('length'); // never reached the cap
    expect(yielded).toBeLessThan(chunks.length / 2);
    expect(st.content.endsWith(LAST_PROSE)).toBe(true);
    expect(st.content).not.toContain('Search Weather');

    // What the client saw, after applying the retraction, matches the reply.
    let shown = '';
    for (const e of sent) {
      if (e.type === 'content') shown += e.content as string;
      if (e.type === 'retract_partial') shown = shown.slice(0, shown.length - (e.length as number));
    }
    expect(shown).toBe(st.content);
  });
});
