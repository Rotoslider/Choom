/**
 * 2026-11-05: the YouTube channel switch did nothing from Brave on the NUC. The server answers
 * 412 to a settings change from any device but its own until the change is confirmed, and the
 * YouTube, Heartbeats and Scheduled Tasks tabs dropped the 412 without a word.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { saveBridgeConfig, resetSaveConfirmation } from '@/lib/save-bridge-config';

type Sent = { headers: Record<string, string>; body: string };

function fakeServer(statuses: number[], body: Record<string, unknown> = { yt_downloader: { channels: [] } }) {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
    const status = statuses[Math.min(sent.length - 1, statuses.length - 1)];
    const confirmed = (init.headers as Record<string, string>)['x-confirm-remote-write'] === 'yes';
    const s = status === 412 && confirmed ? 200 : status;
    return {
      ok: s >= 200 && s < 300,
      status: s,
      json: async () => (s === 200 ? body : { error: 'boom', message: s === 412 ? 'confirm' : 'disk full' }),
    } as Response;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe('saveBridgeConfig', () => {
  beforeEach(() => resetSaveConfirmation());

  test('the server\'s own browser saves without a question', async () => {
    const { sent, fetchImpl } = fakeServer([200]);
    const confirm = jest.fn(() => true);
    const r = await saveBridgeConfig({ a: 1 }, { what: 'YouTube channels', confirm, fetchImpl });
    expect(r).toEqual({ ok: true, config: { yt_downloader: { channels: [] } } });
    expect(confirm).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['x-confirm-remote-write']).toBeUndefined();
  });

  test('another device is asked once, then the change goes confirmed; later saves on the page do not ask', async () => {
    const { sent, fetchImpl } = fakeServer([412]);
    const confirm = jest.fn(() => true);
    const r = await saveBridgeConfig({ a: 1 }, { what: 'YouTube channels', confirm, fetchImpl });
    expect(r.ok).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((confirm.mock.calls[0] as unknown as string[])[0]).toContain('YouTube channels');
    expect(sent.map(s => s.headers['x-confirm-remote-write'])).toEqual([undefined, 'yes']);

    const r2 = await saveBridgeConfig({ a: 2 }, { what: 'YouTube channels', confirm, fetchImpl });
    expect(r2.ok).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sent[2].headers['x-confirm-remote-write']).toBe('yes');
  });

  test('saying no sends nothing more and changes nothing', async () => {
    const { sent, fetchImpl } = fakeServer([412]);
    const r = await saveBridgeConfig({ a: 1 }, { what: 'heartbeats', confirm: () => false, fetchImpl });
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(sent).toHaveLength(1);
  });

  test('any other failure comes back with the server\'s words', async () => {
    const { fetchImpl } = fakeServer([500]);
    const r = await saveBridgeConfig({ a: 1 }, { what: 'scheduled tasks', confirm: () => true, fetchImpl });
    expect(r).toEqual({ ok: false, error: 'disk full' });
  });

  test('the three settings tabs save through it, never with a bare POST', () => {
    const dir = path.join(__dirname, '..', 'components', 'settings');
    for (const f of ['yt-downloader-settings.tsx', 'heartbeat-settings.tsx', 'cron-settings.tsx']) {
      const src = readFileSync(path.join(dir, f), 'utf-8');
      expect(src).toContain("from '@/lib/save-bridge-config'");
      expect(src).toMatch(/saveBridgeConfig\(updated/);
      expect(src).not.toMatch(/fetch\('\/api\/bridge-config',\s*\{\s*method: 'POST'/);
    }
  });
});
