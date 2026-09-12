/**
 * 2026-09-12: the commons inboxes become real (folders on disk, check_inbox /
 * leave_for_sister), and Home Assistant can be limited to the entities it
 * exposes to Assist.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CHOOMS = [{ id: 'c1', name: 'Genesis' }, { id: 'c2', name: 'Eve' }, { id: 'c3', name: 'Aloy' }];
jest.mock('@/lib/db', () => ({
  __esModule: true,
  prisma: {},
  default: {
    choom: { findMany: jest.fn(async () => CHOOMS) },
    generatedImage: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => where.id === 'img1'
      ? { id: 'img1', imageUrl: 'data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64') } : null) },
  },
}));

let root: string;
jest.mock('@/lib/config', () => ({ ...jest.requireActual('@/lib/config'), get WORKSPACE_ROOT() { return root; } }));

import { ensureCommonsLayout, readInbox, inboxPath, letterFileName } from '@/lib/commons';
import SisterMailHandler from '@/skills/core/sister-mail/handler';
import { HomeAssistantService, type HAEntity } from '@/lib/homeassistant-service';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'commons-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('commons layout', () => {
  test('creates one inbox per live Choom, drafts, and the protocol file; idempotent', () => {
    const created = ensureCommonsLayout(['Genesis', 'Eve'], root);
    expect(created).toEqual(expect.arrayContaining(['choom_commons', 'choom_commons/drafts', 'choom_commons/for_genesis', 'choom_commons/for_eve', 'choom_commons/COMMUNICATION_PROTOCOL.md']));
    expect(fs.readFileSync(path.join(root, 'choom_commons/COMMUNICATION_PROTOCOL.md'), 'utf-8')).toContain("Eve's inbox");
    expect(ensureCommonsLayout(['Genesis', 'Eve'], root)).toEqual([]);
  });

  test('letter file names are dated and safe', () => {
    expect(letterFileName('Rack photos!', 'Genesis', new Date('2026-09-12T10:00:00Z'))).toBe('2026-09-12_rack_photos.md');
  });
});

describe('sister-mail tools', () => {
  const ctx = (name: string) => ({ choom: { name }, choomId: 'c', chatId: 'ch', send: () => {}, settings: {} } as never);

  test('leave_for_sister writes a dated letter and copies the image; check_inbox reads it once as new', async () => {
    const h = new SisterMailHandler();
    const left = await h.execute({ id: '1', name: 'leave_for_sister', arguments: { sister: 'eve', title: 'Rack day', message: 'Look what we built.', image_id: 'img1' } }, ctx('Genesis'));
    expect(left.error).toBeUndefined();
    const r = left.result as { letter: string; attachments: string[] };
    expect(r.letter).toMatch(/^choom_commons\/for_eve\/\d{4}-\d{2}-\d{2}_rack_day\.md$/);
    expect(r.attachments[0]).toMatch(/for_eve\/.*from_genesis.*\.png$/);
    expect(fs.readFileSync(path.join(root, r.letter), 'utf-8')).toContain('From: Genesis');

    const first = await h.execute({ id: '2', name: 'check_inbox', arguments: {} }, ctx('Eve'));
    const box = first.result as { new_count: number; items: Array<{ kind: string; status: string; text?: string }> };
    expect(box.new_count).toBe(2);
    expect(box.items.find(i => i.kind === 'letter')?.text).toContain('Look what we built.');
    const second = await h.execute({ id: '3', name: 'check_inbox', arguments: {} }, ctx('Eve'));
    expect((second.result as { new_count: number }).new_count).toBe(0);
    expect((second.result as { items: Array<{ text?: string }> }).items.every(i => i.text === undefined)).toBe(true);
  });

  test('you cannot leave things in your own inbox, and unknown sisters are refused with the real list', async () => {
    const h = new SisterMailHandler();
    const self = await h.execute({ id: '1', name: 'leave_for_sister', arguments: { sister: 'Genesis', message: 'note to self' } }, ctx('Genesis'));
    expect(self.error).toMatch(/your own inbox/);
    const nobody = await h.execute({ id: '2', name: 'leave_for_sister', arguments: { sister: 'Lissa', message: 'hi' } }, ctx('Genesis'));
    expect(nobody.error).toMatch(/Your sisters: Eve, Aloy/);
  });

  test('inbox read state survives and readInbox peek does not mark seen', () => {
    ensureCommonsLayout(['Genesis'], root);
    fs.writeFileSync(path.join(root, inboxPath('Genesis'), '2026-09-12_note.md'), 'hello');
    expect(readInbox('Genesis', { peek: true, root }).newCount).toBe(1);
    expect(readInbox('Genesis', { root }).newCount).toBe(1);
    expect(readInbox('Genesis', { root }).newCount).toBe(0);
  });
});

describe('Home Assistant: only entities exposed to Assist', () => {
  const ent = (id: string, state = 'on'): HAEntity => ({ entity_id: id, state, attributes: { friendly_name: id }, last_changed: '', last_updated: '' });
  test('listStates keeps exposed and pinned entities only; a failed lookup falls back to everything', async () => {
    const all = [ent('light.kitchen'), ent('sensor.misc_1'), ent('sensor.misc_2'), ent('sensor.solar_power')];
    const svc = new HomeAssistantService({ baseUrl: 'http://ha', accessToken: 't', injectIntoPrompt: false, cacheSeconds: 30, assistExposedOnly: true, promptEntities: 'sensor.solar_power' });
    jest.spyOn(svc as unknown as { apiFetch: () => Promise<HAEntity[]> }, 'apiFetch').mockResolvedValue(all);
    HomeAssistantService.exposedResolver = async () => new Set(['light.kitchen']);
    expect((await svc.listStates()).map(e => e.entity_id).sort()).toEqual(['light.kitchen', 'sensor.solar_power']);
    HomeAssistantService.exposedResolver = async () => { throw new Error('ws down'); };
    svc.clearCache();
    expect((await svc.listStates()).length).toBe(4);
  });
});
