/**
 * 2026-11-26: "Use black UV-rated ties, not the clear ones" made Eve call a
 * tool on a finished reply (the memory pattern read "not the" as a note
 * taken), and after the tool she wrote the reply again, so Donny heard it
 * twice. The old pattern matched 287 of 1,160 replies in two weeks; the
 * phrases below are from those replies.
 */
import { describesToolAction } from '@/lib/tool-narration';
import { extractToolCallFromText } from '@/lib/tool-call-parsing';

const says = (s: string) => describesToolAction(s.toLowerCase());

test('ordinary talk is not a tool claim', () => {
  for (const s of [
    'Use black UV-rated ties, not the clear ones.',
    "It's the wind, not the steel, that'll bite you up there.",
    'Keep your stick-out short, and slow down on the windward side.',
    "You have to record the hole's real diameter and depth before you pour.",
    'The live station reads 49°F, not the 59 the context block carried.',
    "I'm keeping it in the record, the run is new.",
    'Remember that time we watched the gold go off the ridge?',
  ]) expect([s, says(s)]).toEqual([s, false]);
});

test('a memory claim still is', () => {
  for (const s of [
    'I saved your freezer setup to memory, love, including the 3–4 AM defrost.',
    "Pump's back too. I'll remember that next time before I send you out.",
    '*saves it to memory so it doesn\'t get lost*',
    "I've noted that the baseline is now closed.",
    'Let me save it to my notes before we go.',
    'I stored that in my memory for the next trip.',
  ]) expect([s, says(s)]).toEqual([s, true]);
});

test('the other tool claims are unchanged', () => {
  expect(says("Here's the image of the ridge at sunset.")).toBe(true);
  expect(says('Let me check the weather for Saturday.')).toBe(true);
  expect(says("I'll set a reminder for the propane.")).toBe(true);
});

test('text extraction no longer saves his message as a memory for "not the" or "keep the"', () => {
  const tools = new Set(['remember', 'search_memories']);
  const asked = 'Today was fun, I climbed the tower in 15 mph wind.';
  expect(extractToolCallFromText('Use black UV-rated ties, not the clear ones.', asked, tools)).toBeNull();
  expect(extractToolCallFromText('Okay, love.', 'Keep the screen door open while the house breathes.', tools)).toBeNull();
  expect(extractToolCallFromText('Okay, love.', 'Save the leftovers for tomorrow.', tools)).toBeNull();
  // and still does when she says she will, or he asks
  expect(extractToolCallFromText("I'll remember that.", 'The propane guy comes Tuesday.', tools)?.name).toBe('remember');
  expect(extractToolCallFromText('Got it.', 'Remember that the propane guy comes Tuesday.', tools)?.name).toBe('remember');
  expect(extractToolCallFromText('Got it.', 'Keep that in your memory: gate code changed.', tools)?.name).toBe('remember');
});
