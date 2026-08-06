/**
 * Room-slug path redirect (2026-08-06 duplicate-folder incident).
 *
 * Chooms address group rooms by bare slug ("d1-robot-project-9bnsb5" — the
 * `room` arg of talk_with_sisters), but the folder lives at
 * choom_commons/rooms/<slug>. resolveSafe used to resolve the bare slug at
 * the workspace root, where write's auto-mkdir silently created a duplicate
 * room tree: Edyta wrote the D1 power-up protocol into a phantom root copy,
 * Optic then "reorganized" inside the same phantom, and listFiles of the
 * nonexistent root slug returned [] ("the shared folder appears empty").
 */
import { WorkspaceService } from '@/lib/workspace-service';
import { mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

const ROOT = path.join(os.tmpdir(), 'choom-test-room-redirect-' + Date.now());
const ROOM = 'd1-robot-project-9bnsb5';

describe('resolveSafe room-slug redirect', () => {
  beforeAll(() => {
    mkdirSync(path.join(ROOT, 'choom_commons', 'rooms', ROOM), { recursive: true });
    mkdirSync(path.join(ROOT, 'Trash_Panda'), { recursive: true });
  });

  afterAll(() => {
    try {
      const { execSync } = require('child_process');
      execSync(`rm -rf "${ROOT}"`);
    } catch { /* ignore */ }
  });

  const ws = () => new WorkspaceService(ROOT, 1024, ['.md']);

  test('bare room slug redirects into choom_commons/rooms/', () => {
    expect(ws().resolveSafe(`${ROOM}/first_power_up_gate_protocol.md`))
      .toBe(path.join(ROOT, 'choom_commons', 'rooms', ROOM, 'first_power_up_gate_protocol.md'));
  });

  test('slug with subpath redirects too (Optic’s docs/ move)', () => {
    expect(ws().resolveSafe(`${ROOM}/docs/first_power_up_gate_protocol.md`))
      .toBe(path.join(ROOT, 'choom_commons', 'rooms', ROOM, 'docs', 'first_power_up_gate_protocol.md'));
  });

  test('case drift in the slug still redirects', () => {
    expect(ws().resolveSafe(`D1-Robot-Project-9bnsb5/notes.md`))
      .toBe(path.join(ROOT, 'choom_commons', 'rooms', ROOM, 'notes.md'));
  });

  test('existing root project is never shadowed by the redirect', () => {
    expect(ws().resolveSafe('Trash_Panda/TECHNICAL_NOTES.md'))
      .toBe(path.join(ROOT, 'Trash_Panda', 'TECHNICAL_NOTES.md'));
  });

  test('unknown top folder is untouched (new projects still creatable at root)', () => {
    expect(ws().resolveSafe('brand_new_project/notes.md'))
      .toBe(path.join(ROOT, 'brand_new_project', 'notes.md'));
  });

  test('full canonical path is untouched', () => {
    expect(ws().resolveSafe(`choom_commons/rooms/${ROOM}/notes.md`))
      .toBe(path.join(ROOT, 'choom_commons', 'rooms', ROOM, 'notes.md'));
  });
});
