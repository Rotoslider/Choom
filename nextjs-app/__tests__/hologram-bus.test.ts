import {
  hologramVoiceActive,
  markViewing,
  requestFromAway,
  setHologramListening,
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

test('Donny typing or talking reaches the hologram as a listening event', () => {
  const { events, off } = capture();
  setHologramListening({ listening: true, source: 'typing', choom: 'Aloy', chatId: 'c1', roomId: null });
  setHologramListening({ listening: false, source: 'typing', choom: 'Aloy', chatId: 'c1', roomId: null });
  off();
  expect(events.map((e) => [e.type, e.listening, e.choom])).toEqual([['listening', true, 'Aloy'], ['listening', false, 'Aloy']]);
});

test('requests through ngrok or from a public address count as away from home', () => {
  const req = (headers: Record<string, string>) => new Request('http://localhost/api/hologram/listening', { headers });
  expect(requestFromAway(req({ host: 'abc.ngrok-free.app' }))).toBe(true);
  expect(requestFromAway(req({ host: 'donnys-mac-studio-3.local:3443', 'x-forwarded-for': '203.0.113.7' }))).toBe(true);
  expect(requestFromAway(req({ host: 'donnys-mac-studio-3.local:3443', 'x-forwarded-for': '192.168.1.20' }))).toBe(false);
  expect(requestFromAway(req({ host: 'localhost:3000' }))).toBe(false);
});

test('a chat turn tells the hologram what Donny said, heartbeats do not', () => {
  const { events, off } = capture();
  startHologramTurn(turn('chat', 'c1'), 'My dog is sick, I am worried.').end();
  startHologramTurn(turn('heartbeat', 'c2'), 'internal heartbeat prompt').end();
  off();
  const starts = events.filter((e) => e.type === 'turn_start');
  expect(starts[0].prompt).toBe('My dog is sick, I am worried.');
  expect(starts[1].prompt).toBeUndefined();
});

test('pictures and delegation reach the hologram with what it needs to show them', () => {
  const { events, off } = capture();
  const t = startHologramTurn({ ...turn('chat', 'c1'), choom: 'Aloy', choomId: 'a' });
  t.event({ type: 'tool_call', toolCall: { id: '1', name: 'generate_image', arguments: { prompt: 'me', self_portrait: true } } });
  t.event({ type: 'image_generated', imageId: 'img1', imageUrl: 'data:image/png;base64,AAAA' });
  t.event({ type: 'tool_call', toolCall: { id: '2', name: 'generate_image', arguments: { prompt: 'a mesa' } } });
  t.event({ type: 'image_generated', imageId: 'img2', imageUrl: 'data:image/png;base64,AAAA' });
  t.event({ type: 'tool_call', toolCall: { id: '3', name: 'ha_get_camera_snapshot', arguments: { entity_id: 'camera.porch' } } });
  t.event({ type: 'image_generated', imageId: 'img3', imageUrl: 'data:image/jpeg;base64,AAAA' });
  t.event({ type: 'tool_call', toolCall: { id: '4', name: 'analyze_image', arguments: { image_id: 'img2' } } });
  t.event({ type: 'tool_call', toolCall: { id: '5', name: 'delegate_to_choom', arguments: { choom_name: 'Genesis', task: 'x' } } });
  t.end();
  off();
  const images = events.filter((e) => e.type === 'image').map((e) => [e.imageId, e.kind]);
  expect(images).toEqual([['img1', 'selfie'], ['img2', 'picture'], ['img3', 'snapshot'], ['img2', 'looking']]);
  expect(events.some((e) => 'imageUrl' in e)).toBe(false); // never the multi-MB image itself
  expect(events.find((e) => e.tool === 'delegate_to_choom')?.target).toBe('Genesis');
});

test("a failed tool reaches the hologram, a working one does not", () => {
  const { events, off } = capture();
  const t = startHologramTurn({ ...turn("chat", "c1"), choom: "Optic", choomId: "o" });
  t.event({ type: "tool_result", toolResult: { toolCallId: "1", name: "generate_image", result: null, error: "ComfyUI timed out" } });
  t.event({ type: "tool_result", toolResult: { toolCallId: "2", name: "ha_get_home_status", result: { success: false, error: "unreachable" } } });
  t.event({ type: "tool_result", toolResult: { toolCallId: "3", name: "get_weather", result: { success: true, temp: 66 } } });
  t.end();
  off();
  expect(events.filter((e) => e.type === "tool_failed").map((e) => e.tool)).toEqual(["generate_image", "ha_get_home_status"]);
});
