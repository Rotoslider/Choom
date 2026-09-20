/**
 * collapseRepetitions — the 2026-09-20 mic transcript ("Access all of the..."
 * ×~110 after a real paragraph) must come back as the paragraph plus one copy.
 */
import { collapseRepetitions } from '../lib/stt-repetition-guard';

const REAL_HEAD = 'Once I get that installed, you girls will have a much better ability to gather all of the weather data from our homestead.';

describe('collapseRepetitions', () => {
  it('collapses the real looping transcript to a single copy of the phrase', () => {
    const loop = Array(110).fill('Access all of the...').join(' ');
    const r = collapseRepetitions(`${REAL_HEAD} ${loop}`);
    expect(r.text).toBe(`${REAL_HEAD} Access all of the...`);
    expect(r.removed).toBe(109);
    expect(r.phrase).toBe('Access all of the...');
  });

  it('leaves normal speech alone, including a phrase said twice', () => {
    const s = 'No, no, I meant the other one. It should be here by the end of the week. The end of the week is fine.';
    expect(collapseRepetitions(s)).toEqual({ text: s, removed: 0 });
  });

  it('collapses a single-word loop', () => {
    const r = collapseRepetitions('and then we went the the the the the the store');
    expect(r.text).toBe('and then we went the store');
    expect(r.removed).toBe(5);
  });

  it('collapses a multi-sentence loop and keeps what follows', () => {
    const unit = 'Thank you for watching.';
    const r = collapseRepetitions(`Hello there. ${Array(8).fill(unit).join(' ')} Goodbye.`);
    expect(r.text).toBe('Hello there. Thank you for watching. Goodbye.');
    expect(r.removed).toBe(7);
  });

  it('is case and punctuation tolerant when matching copies', () => {
    const r = collapseRepetitions('go go, Go! go. go');
    expect(r.text).toBe('go');
    expect(r.removed).toBe(4);
  });

  it('handles empty and short input', () => {
    expect(collapseRepetitions('')).toEqual({ text: '', removed: 0 });
    expect(collapseRepetitions('hi')).toEqual({ text: 'hi', removed: 0 });
  });
});
