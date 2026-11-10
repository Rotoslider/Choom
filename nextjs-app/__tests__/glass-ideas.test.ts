/**
 * Glass Studio's "Ask her for ideas" (Nov 9, 2026): a request in her follow-up queue, due now, marked
 * from glass_studio, one waiting per look. Runs in a temporary folder: the queue lives under the
 * working directory (data/self_followups), never the real one.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-ideas-'));
const home = process.cwd();
let ideas: typeof import('@/lib/glass-ideas');

beforeAll(() => {
  process.chdir(tmp);
  jest.isolateModules(() => {
    ideas = require('@/lib/glass-ideas');
  });
});
afterAll(() => {
  process.chdir(home);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ask a Choom for ideas from Glass Studio', () => {
  const eve = { id: 'eve-id', name: 'Eve' };
  const about = 'your white spandex workout outfit, head to toe';

  it('asks for glass_wish ideas that come back to where they began, about the look he named', () => {
    const p = ideas.ideasPrompt(about + '.');
    expect(p).toContain('your white spandex workout outfit, head to toe.');
    expect(p).toContain('glass_wish');
    expect(p).toContain('come back to where it began');
    expect(p).not.toMatch(/you(?:'re| are) (?:wearing|in) .* now/i);
  });

  it('queues one request per look, due now, marked as his', () => {
    const now = new Date('2026-11-09T23:30:00Z');
    const first = ideas.queueIdeas(eve, 'full@dayspandex', about, now);
    expect(first.already).toBe(false);
    const file = path.join(tmp, 'data', 'self_followups', 'eve-id', 'pending', `${first.entry.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ from: 'glass_studio', look: 'full@dayspandex', trigger_at: now.toISOString(), choom_name: 'Eve', status: 'pending' });
    const again = ideas.queueIdeas(eve, 'full@dayspandex', about, now);
    expect(again).toEqual({ entry: expect.objectContaining({ id: first.entry.id }), already: true });
    const other = ideas.queueIdeas(eve, 'main@dayspandex', 'your spandex outfit, waist up', now);
    expect(other.already).toBe(false);
    expect(other.entry.id).not.toBe(first.entry.id);
  });
});
