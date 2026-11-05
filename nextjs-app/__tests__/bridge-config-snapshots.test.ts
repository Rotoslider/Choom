/**
 * The Restore panel's pre-change snapshots (2026-11-05). The app names its snapshots in UTC
 * ("bridge-config_2026-11-05T14-43-30.json"), the Signal bridge in local time
 * ("bridge-config_20261101_205003.json"), in the same folder, and both pruned to 10 by plain name
 * order. "20261101" sorts above "2026-11-05", so every snapshot the app wrote was deleted the
 * moment it was made: none was kept from Nov 1 to Nov 5.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The bridge's ten, as they were in data/backups/bridge-config on Nov 5.
const BRIDGE_TEN = [
  'bridge-config_20261026_090011.json', 'bridge-config_20261026_170259.json',
  'bridge-config_20261026_212232.json', 'bridge-config_20261026_212235.json',
  'bridge-config_20261030_063003.json', 'bridge-config_20261101_074623.json',
  'bridge-config_20261101_074625.json', 'bridge-config_20261101_090009.json',
  'bridge-config_20261101_090058.json', 'bridge-config_20261101_205003.json',
];
const OTHER = ['20260916-111527-model-cleanup.json', '20260916-120132-cleanup2.json'];

describe('config snapshots are kept by when they were taken', () => {
  let tmp: string; let prevCwd: string;
  let store: typeof import('@/lib/bridge-config-store');
  const dir = () => path.join(tmp, 'data', 'backups', 'bridge-config');

  // The store resolves its paths from cwd at load, so it is imported after chdir.
  beforeAll(async () => {
    prevCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-snap-'));
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, 'services', 'signal-bridge'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'services', 'signal-bridge', 'bridge-config.json'), '{"yt_downloader":{"channels":[]}}');
    fs.mkdirSync(dir(), { recursive: true });
    for (const f of [...BRIDGE_TEN, ...OTHER]) fs.writeFileSync(path.join(dir(), f), '{}');
    store = await import('@/lib/bridge-config-store');
  });
  afterAll(() => { process.chdir(prevCwd); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('names read as the right instant: the app\'s in UTC, the bridge\'s in local time', () => {
    expect(store.snapshotNameTime('bridge-config_2026-11-05T14-43-30.json')).toEqual({ ms: Date.UTC(2026, 10, 5, 14, 43, 30), label: '' });
    expect(store.snapshotNameTime('bridge-config_2026-11-05T14-43-30_pre-restore.json')?.label).toBe('pre-restore');
    expect(store.snapshotNameTime('bridge-config_20261101_205003.json')?.ms).toBe(new Date(2026, 10, 1, 20, 50, 3).getTime());
    expect(store.snapshotNameTime('20260916-111527-model-cleanup.json')).toBeNull();
  });

  test('a new app snapshot is the one that stays; the oldest bridge one goes; other files are left', async () => {
    await store.snapshotConfig();
    const left = fs.readdirSync(dir());
    const mine = left.filter(f => /^bridge-config_\d{4}-\d{2}-\d{2}T/.test(f));
    expect(mine).toHaveLength(1);
    expect(left).not.toContain('bridge-config_20261026_090011.json');
    expect(left).toContain('bridge-config_20261101_205003.json');
    expect(left.filter(f => f.startsWith('bridge-config_'))).toHaveLength(10);
    for (const f of OTHER) expect(left).toContain(f);
  });

  test('the Restore list puts it first, in local time', async () => {
    const list = (await store.listSnapshots()).filter(s => s.source === 'snapshot');
    expect(list[0].id).toMatch(/^bridge-config_\d{4}-\d{2}-\d{2}T/);
    const shown = new Date(list[0].takenAt).getTime(); // a local wall-clock string, as the panel reads it
    expect(Math.abs(shown - Date.now())).toBeLessThan(60_000);
    expect(list[1].id).toBe('bridge-config_20261101_205003.json');
    expect(list[1].takenAt).toBe('2026-11-01T20:50:03');
  });
});
