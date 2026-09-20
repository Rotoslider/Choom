/**
 * repairMissingRequiredArg — the wrong-NAME repair (as opposed to the
 * camelCase/hyphen spelling normalizer). Both primary cases are verbatim
 * from Aloy's 2026-09-20 trace (DeepSeek V4 Flash): music_play({uri}) and
 * music_control({command}).
 */
import { repairMissingRequiredArg } from '../lib/tool-arg-repair';

const musicPlay = {
  properties: { media: {}, player: {}, enqueue: {} },
  required: ['media'],
};
const musicControl = {
  properties: { action: {}, player: {}, value: {} },
  required: ['action'],
};

describe('repairMissingRequiredArg', () => {
  it('moves the lone unknown key onto the lone missing required param (uri → media)', () => {
    const r = repairMissingRequiredArg({ uri: 'library://track/90108' }, musicPlay);
    expect(r.renamed).toEqual({ from: 'uri', to: 'media' });
    expect(r.args).toEqual({ media: 'library://track/90108' });
  });

  it('keeps known keys alongside the rename (command → action, player untouched)', () => {
    const r = repairMissingRequiredArg({ command: 'play', player: 'Home Assistant Voice 0a567a' }, musicControl);
    expect(r.renamed).toEqual({ from: 'command', to: 'action' });
    expect(r.args).toEqual({ action: 'play', player: 'Home Assistant Voice 0a567a' });
  });

  it('does nothing when the required param is present', () => {
    const r = repairMissingRequiredArg({ media: 'jazz', uri: 'x' }, musicPlay);
    expect(r.renamed).toBeNull();
    expect(r.args).toEqual({ media: 'jazz', uri: 'x' });
  });

  it('does nothing when two unknown keys make the mapping ambiguous', () => {
    const r = repairMissingRequiredArg({ uri: 'a', query: 'b' }, musicPlay);
    expect(r.renamed).toBeNull();
  });

  it('does nothing when two required params are missing', () => {
    const schema = { properties: { path: {}, content: {} }, required: ['path', 'content'] };
    const r = repairMissingRequiredArg({ filename: 'a.txt' }, schema);
    expect(r.renamed).toBeNull();
  });

  it('treats an empty-string required param as missing', () => {
    const r = repairMissingRequiredArg({ media: '', track: 'Ave Maria' }, musicPlay);
    expect(r.renamed).toEqual({ from: 'track', to: 'media' });
    expect(r.args).toEqual({ media: 'Ave Maria' });
  });

  it('ignores schemas without required params', () => {
    const r = repairMissingRequiredArg({ foo: 1 }, { properties: {} });
    expect(r.renamed).toBeNull();
  });
});
