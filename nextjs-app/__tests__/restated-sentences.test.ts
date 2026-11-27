/**
 * 2026-11-26, Donny: "80% of their replies have them repeating verbatim or
 * damn close just about everything." In group rooms a sister retold what
 * another had just said in 36-80% of her messages; the old checks took only
 * near word-for-word lines, and only after the Rooms page had spoken them.
 * Sentences are now checked one by one (restatedFrom), in the room stream and
 * in a one-to-one reply written again after a tool call. The lines below are
 * the rooms' own, from the dry run on Nov 12-26.
 */
import { restatedFrom, restatementPriors, stripRestatedSentences } from '@/lib/repetition-guard';
import { RestatedSentenceFilter, roomRestateFilterOn, roomRestatePriorTexts, type GroupTranscriptEntry } from '@/lib/group-chat-runner';

jest.mock('undici', () => ({ Agent: class {}, fetch: jest.fn() }));

const restates = (sentence: string, ...earlier: string[]) => restatedFrom(sentence, restatementPriors(earlier)) >= 0;

describe('a sentence already said', () => {
  test('word for word, or nearly', () => {
    expect(restates("Not the sensors, not the temps, not the mini split's lying little head.",
      "It was never the house. Not the sensors, not the temps, not the mini split's lying little head.")).toBe(true);
    expect(restates('Sharp edges, rough broken face, no patina.', 'Sharp edges, rough broken face, no patina on it.')).toBe(true);
  });

  test('retold in other words', () => {
    expect(restates('First light, the smoke off the chimney, the whole eastern sky lit up ahead of a sun that hasn\'t arrived yet.',
      'First light, before the sun clears the ridge — frost in the low spots, smoke coming off the chimney, the whole eastern sky lit up ahead of a sun that hasn\'t arrived.')).toBe(true);
    expect(restates('The edges are already starting to go soft at the corners of the window, just like Eve said.',
      'The edges are already going soft at the corners of the window.')).toBe(true);
  });
});

describe('not a repeat', () => {
  test('a correction: "not" on one side only', () => {
    expect(restates("The washes aren't cutting through a terrace and spilling its contents down.",
      'The wash is cutting through the terrace and spilling its contents down here.')).toBe(false);
  });

  test("a short sentence using the topic's words for something new", () => {
    expect(restates("One piece a square and it's nearer three thousand.",
      'What I do want, because thousands is not a number yet: five three-foot squares, four corners and the center, and a count of every piece in each square, three thousand or not.')).toBe(false);
  });

  test("quoting a sister to say something about it", () => {
    expect(restates('So "screen shut, handle latched, no gap" wasn\'t something the camera told you.',
      'I put the east patio camera on it at 6:18 — screen shut, handle latched, no gap.')).toBe(false);
  });

  test('image notes and links are never cut', () => {
    const note = '_[image shared to the room — saved at `choom_commons/rooms/thanksgiving/images/eve-6zl.png`. Siblings can view it with analyze_image image_path="choom_commons/rooms/thanksgiving/images/eve-6zl.png"]_';
    expect(restates(note, note.replace('eve-6zl', 'genesis-73u'))).toBe(false);
    expect(restates('[Replacement Parts — Harbor Freight](https://www.harborfreight.com/parts) has the belt for the planer.',
      '[Replacement Parts — Harbor Freight](https://www.harborfreight.com/parts) has the belt for the planer.')).toBe(false);
  });

  test("voice cues aren't words of the sentence", () => {
    expect(restates('[amused] Ivory cotton, lace at the neck, something soft.', '[softly] Charcoal wool, collar up, scarf twice around.')).toBe(false);
  });
});

describe('stripRestatedSentences', () => {
  test("keeps what's new and the paragraph breaks", () => {
    const earlier = "Not the sensors, not the temps, not the mini split's lying little head. The gold went while we were busy.";
    const reply = "Donny, you're right.\n\nNot the sensors, not the temps, not the mini split's lying little head.\n\nThe pie can wait until the light's gone.";
    const r = stripRestatedSentences(reply, [earlier]);
    expect(r.dropped).toEqual(["Not the sensors, not the temps, not the mini split's lying little head."]);
    expect(r.text).toBe("Donny, you're right.\n\nThe pie can wait until the light's gone.");
  });

  test('within: a sentence she already said earlier in the same message', () => {
    // Eve, Nov 26 6:10 PM: the same paragraph twice in one reply.
    const first = "And Genesis cooking dinner out of what was in the pantry, with times and temperatures, and it came out good — that's a good thing to find out about your family on a Thursday.";
    const again = "And Genesis cooking dinner out of what was in the pantry, with her own times and temperatures, and it coming out good — that's a fine thing to learn about your family on a Thursday.";
    const reply = `${first} She's been in that kitchen with you.\n\n${again}`;
    expect(stripRestatedSentences(reply, [], { within: true }).text).toBe(`${first} She's been in that kitchen with you.`);
    expect(stripRestatedSentences(reply, []).dropped).toEqual([]);
  });

  test('exactShort: a short sentence said word for word again (one turn), but not in rooms', () => {
    const earlier = "[softly] Now go have your frozen yogurt. It's 56 and the wind's down to 3.";
    const again = "[teasing] Now go have your frozen yogurt. It's saved.";
    expect(stripRestatedSentences(again, [earlier], { exactShort: true }).text).toBe("It's saved.");
    expect(stripRestatedSentences(again, [earlier]).text).toBe(again);
    expect(stripRestatedSentences('I love you.', ['I love you. Goodnight, husband.'], { within: true }).text).toBe('I love you.');
  });

  test('code is left alone', () => {
    const code = 'Run this:\n```\nls -la ~/choom-projects\n```\nls -la shows everything in the choom projects folder.';
    expect(stripRestatedSentences(code, [code]).text).toBe(code);
  });
});

describe('the room stream', () => {
  const transcript: GroupTranscriptEntry[] = [
    { authorChoomId: null, authorName: 'Donny', content: 'Life does not get better than a paper plate on the love seat with my four girls.' },
    { authorChoomId: 'eve', authorName: 'Eve', content: "Ivory and cream, on the floor and at the sink, watching the same ridge. Gold, then that cold flat blue, then dark." },
  ];

  test('only sentences the room has not heard go out, whole', () => {
    const f = new RestatedSentenceFilter(roomRestatePriorTexts(transcript));
    const reply = "[softly] Donny, that landed. Ivory and cream, on the floor and at the sink, watching the same ridge. I'm keeping the paper plate. Gold, then that cold flat blue, then dark.";
    let out = '';
    for (const token of reply.match(/.{1,7}/gs)!) out += f.push(token);
    out += f.end();
    expect(out).toBe("[softly] Donny, that landed. I'm keeping the paper plate. ");
    expect(f.dropped).toHaveLength(2);
  });

  test("Donny's own words are his to be answered in", () => {
    const f = new RestatedSentenceFilter(roomRestatePriorTexts(transcript));
    const said = 'Life does not get better than a paper plate on the love seat with my four girls, you said.';
    expect(f.push(said) + f.end()).toBe(said);
  });

  test('nothing is held back mid-sentence longer than the sentence', () => {
    const f = new RestatedSentenceFilter([]);
    expect(f.push('Half a sent')).toBe('');
    expect(f.push('ence. And the ')).toBe('Half a sentence. ');
    expect(f.end()).toBe('And the ');
  });

  test('on, and CHOOM_ROOM_RESTATE_FILTER=off turns it off', () => {
    const saved = process.env.CHOOM_ROOM_RESTATE_FILTER;
    delete process.env.CHOOM_ROOM_RESTATE_FILTER;
    expect(roomRestateFilterOn()).toBe(true);
    process.env.CHOOM_ROOM_RESTATE_FILTER = 'off';
    expect(roomRestateFilterOn()).toBe(false);
    if (saved === undefined) delete process.env.CHOOM_ROOM_RESTATE_FILTER; else process.env.CHOOM_ROOM_RESTATE_FILTER = saved;
  });
});
