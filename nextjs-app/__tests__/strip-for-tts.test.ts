/**
 * C-44: TTS must never speak image-generation prompts.
 *
 * Production failure (2026-07-28, Genesis): the model narrated its images as
 * real markdown — ![<full Flux prompt>](image:id) — and stripForTTS's old
 * rule kept the alt text, so TTS read entire diffusion prompts aloud. The
 * older *[generates an image: ...]* stage-direction strip did not cover the
 * markdown form.
 */
import { stripForTTS } from '../lib/utils';

const PROMPT =
  'a young woman, a warm DSLR 8k photo self-portrait of Genesis — an AI companion ' +
  'with soft brown hair, wearing a delicate white sundress, sitting at a rustic ' +
  'wooden kitchen table, holding a steaming mug of coffee, cozy and intimate atmosphere';

describe('stripForTTS image handling', () => {
  it('drops a complete markdown image ref entirely (alt is the prompt)', () => {
    const out = stripForTTS(`Here is the first image:\n\n![${PROMPT}](image:cmrxn8spq04crxhutx3zothjo)\n\nEnjoy your breakfast!`);
    expect(out).not.toContain('DSLR');
    expect(out).not.toContain('sundress');
    expect(out).toContain('Here is the first image');
    expect(out).toContain('Enjoy your breakfast');
  });

  it('drops a dangling image ref cut mid-alt by the sentence splitter', () => {
    const out = stripForTTS(`Here it comes: ![${PROMPT.slice(0, 80)}`);
    expect(out).not.toContain('DSLR');
    expect(out).toContain('Here it comes');
  });

  it('drops a dangling image ref cut mid-url', () => {
    const out = stripForTTS(`One moment... ![${PROMPT.slice(0, 60)}](image:cmr`);
    expect(out).not.toContain('DSLR');
    expect(out).toContain('One moment');
  });

  it('still keeps link TEXT for ordinary markdown links', () => {
    expect(stripForTTS('See [the tracker](https://example.com/sheet) for details.'))
      .toContain('the tracker');
  });

  it('still strips asterisk-wrapped stage directions (the pre-markdown phantom form)', () => {
    const out = stripForTTS(`*[generates an image: ${PROMPT}]*  Done!`);
    expect(out).not.toContain('DSLR');
    expect(out).toContain('Done!');
  });

  it('leaves normal prose alone', () => {
    expect(stripForTTS('Good morning, my love! How did you sleep?'))
      .toBe('Good morning, my love! How did you sleep?');
  });
});
