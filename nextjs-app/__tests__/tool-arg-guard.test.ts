/**
 * C-50: required-argument errors must CORRECT the model, not confuse it.
 *
 * upload_to_drive failed 11 of 11 calls in the trace corpus. The model sent
 * `path`, the tool read `workspace_path`, and Node's path.join threw
 * 'The "path" argument must be of type string. Received undefined' — which
 * reads as "your path argument was bad", so the model retried with `path`
 * again. The error taught the wrong name. Verified after the fix: the same
 * call now returns the corrected invocation, and using it uploads
 * successfully.
 */
import { requireStringArg } from '../lib/tool-arg-guard';

describe('requireStringArg', () => {
  it('returns the value when the right parameter is present', () => {
    expect(requireStringArg('upload_to_drive', { workspace_path: 'a/b.png' }, 'workspace_path'))
      .toBe('a/b.png');
  });

  it('names the correct parameter and the exact corrected call for an alias', () => {
    // The real production call, verbatim.
    let msg = '';
    try {
      requireStringArg('upload_to_drive', { path: 'choom_commons/for_aloy/chant.png' }, 'workspace_path');
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('Missing required parameter "workspace_path"');
    expect(msg).toContain('You sent: path');
    expect(msg).toContain('Rename "path" to "workspace_path"');
    // The corrected call must be complete enough to copy verbatim.
    expect(msg).toContain('upload_to_drive with workspace_path="choom_commons/for_aloy/chant.png"');
  });

  it.each(['file_path', 'filepath', 'file', 'filename'])('recognises the alias %s', (alias) => {
    let msg = '';
    try { requireStringArg('upload_to_drive', { [alias]: 'x.png' }, 'workspace_path'); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(`Rename "${alias}" to "workspace_path"`);
  });

  it('falls back to an example when nothing recognisable was sent', () => {
    let msg = '';
    try { requireStringArg('upload_to_drive', { nonsense: 1 }, 'workspace_path', { example: 'choom_commons/report.pdf' }); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('You sent: nonsense');
    expect(msg).toContain('workspace_path="choom_commons/report.pdf"');
  });

  it('handles no arguments at all', () => {
    let msg = '';
    try { requireStringArg('upload_to_drive', {}, 'workspace_path'); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('You sent no arguments');
  });

  it('rejects an empty or whitespace value rather than passing it through', () => {
    expect(() => requireStringArg('t', { workspace_path: '   ' }, 'workspace_path')).toThrow();
    expect(() => requireStringArg('t', { workspace_path: '' }, 'workspace_path')).toThrow();
  });

  it('rejects a non-string value', () => {
    expect(() => requireStringArg('t', { workspace_path: 42 }, 'workspace_path')).toThrow();
  });

  it('supports caller-supplied aliases', () => {
    let msg = '';
    try { requireStringArg('t', { blob: 'x' }, 'workspace_path', { aliases: ['blob'] }); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('Rename "blob"');
  });
});
