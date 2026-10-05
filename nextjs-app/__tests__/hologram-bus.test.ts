import {
  hologramVoiceActive,
  markViewing,
  setHologramVoice,
  startHologramTurn,
  subscribeHologram,
  type HologramTurn,
} from '@/lib/hologram-bus';

const turn = (source: HologramTurn['source'], chatId: string, roomId: string | null = null): HologramTurn =>
  ({ choom: 'Genesis', choomId: 'g', chatId, voice: 'sophie', source, roomId });

function capture() {
  const events: Record<string, unknown>[] = [];
  const off = subscribeHologram((e) => events.push(e));
  return { events, off, spoken: () => events.filter((e) => e.type === 'content').map((e) => e.text) };
}

test('streamed fragments become whole spoken sentences, without code or markdown', () => {
  const { events, off, spoken } = capture();
  const t = startHologramTurn(turn('chat', 'c1'));
  const reply = 'Hey Donny! I watched the **sunset** tonight. Here is code:\n```js\nconst x = 1;\n```\nIt was beautiful, wasn’t it? See you';
  for (let i = 0; i < reply.length; i += 4) t.event({ type: 'content', content: reply.slice(i, i + 4) });
  t.event({ type: 'done' });
  t.end();
  off();
  expect(events[0].type).toBe('turn_start');
  expect(spoken().join(' ')).not.toMatch(/const x|```|\*\*|^`/);
  expect(spoken()).toContain('Hey Donny! I watched the sunset tonight.');
  expect(String(spoken().at(-1))).toMatch(/^It was beautiful.*See you$/);
  expect(events.at(-1)?.type).toBe('turn_end');
});

test('a retraction drops unspoken text', () => {
  const { events, off, spoken } = capture();
  const t = startHologramTurn(turn('chat', 'c1'));
  t.event({ type: 'content', content: 'Half a thou' });
  t.event({ type: 'retract_partial', length: 11 });
  t.event({ type: 'content', content: 'Fresh answer.' });
  t.event({ type: 'done' });
  off();
  expect(spoken()).toEqual(['Fresh answer.']);
  expect(events.some((e) => e.type === 'retract')).toBe(true);
});

test('the voice hand-off needs a fresh heartbeat', () => {
  setHologramVoice(true);
  expect(hologramVoiceActive()).toBe(true);
  setHologramVoice(false);
  expect(hologramVoiceActive()).toBe(false);
});

test('speaks only conversations someone at home has open', () => {
  const { events, off } = capture();
  const say = (t: HologramTurn) => {
    const h = startHologramTurn(t);
    h.event({ type: 'content', content: 'Hello there.' });
    h.end();
  };
  say(turn('group', 'c2', 'roomA')); // room not open: silent
  markViewing('room', 'roomA');
  say(turn('group', 'c2', 'roomA')); // room open: speaks
  say(turn('group', 'c2', 'roomB')); // another room: silent
  say(turn('chat', 'chatX'));        // chat not open (e.g. Signal): silent
  markViewing('chat', 'chatX');
  say(turn('chat', 'chatX'));        // chat open: speaks
  say(turn('heartbeat', 'chatX'));   // heartbeat: never
  off();
  expect(events.filter((e) => e.type === 'content').map((e) => e.speak)).toEqual([false, true, false, false, true, false]);
});
