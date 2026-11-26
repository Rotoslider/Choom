/**
 * 2026-11-26.
 *  - ha_get_history gave numeric sensors only min/max/avg/trend, no curve.
 *    Eve wanted the temperature through the night, found Home Assistant's key
 *    in the bridge settings and fetched the raw history herself (Nov 22). It
 *    now returns the curve (averages per step) and when the min and max were.
 *  - After HA restarted (Nov 24 06:38) about 150 entities showed that minute
 *    as their last_changed. The Chooms read the east screen door's "on since
 *    Tue 06:38" as a stuck sensor and spent the Thanksgiving room on it. The
 *    tools now say when a change time is a restart, and how long the state
 *    really held; and the screen door carries Donny's note wherever it shows.
 *  - HA's history API stops one day after the start unless end_time is sent,
 *    so every ha_get_history past 24 hours had only the first day of its window.
 *  - Donny's rule for a door and its screen: one of them open is fine, both
 *    open for more than a minute or so lets rattlesnakes in. Results that show
 *    a doorway now say which it is (doorways_now).
 */
import { HomeAssistantService, type HAEntity } from '@/lib/homeassistant-service';

jest.mock('@/skills/core/image-analysis/handler', () => ({ __esModule: true, default: class {} }));
jest.mock('@/lib/db', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/captured-images', () => ({
  cameraSnapshotFolder: (slug: string) => `selfies_${slug}/camera`,
  pruneExpiredCaptures: jest.fn(async () => undefined),
  CAPTURE_RETENTION_HOURS: 72,
}));
jest.mock('@/lib/glass-camera', () => ({ askGlassCamera: jest.fn(), isGlassCameraName: () => false }));
// The bridge settings' door list, in a file of the test's own (never the real settings).
jest.mock('@/lib/bridge-config-store', () => ({
  CONFIG_PATH: require('path').join(require('os').tmpdir(), `ha-doorways-${process.pid}.json`),
}));

import fs from 'fs';
import { CONFIG_PATH } from '@/lib/bridge-config-store';
import HomeAssistantHandler, { houseNotesFor, doorwayVerdict, type Doorway } from '@/skills/core/home-assistant/handler';

const HOUR = 3600 * 1000;
const SCREEN = 'binary_sensor.kitchen1_home_east_screen_door_east_screen_door';
const EAST_DOOR = 'binary_sensor.kitchen1_home_east_door_window';
const EAST: Doorway = { name: 'east door', door: EAST_DOOR, screen: SCREEN, leads: 'outside' };
beforeAll(() => fs.writeFileSync(CONFIG_PATH, JSON.stringify({ homeAssistant: { doors: [
  EAST,
  { name: 'north door', door: 'binary_sensor.north_door', screen: 'binary_sensor.north_screen_door' },
  { name: 'shop door', door: 'binary_sensor.shop_door' },
] } })));
afterAll(() => fs.rmSync(CONFIG_PATH, { force: true }));
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const restart = Math.floor((now - 50 * HOUR) / 60000) * 60000 + 27_000; // 50 h ago, 27 s past the minute

// The house: 60 entities restored by the restart, a few busy ones, the screen door.
function house(): HAEntity[] {
  const list: HAEntity[] = [];
  for (let i = 0; i < 60; i++) {
    list.push({ entity_id: `sensor.thing_${i}`, state: '1', attributes: {}, last_changed: iso(restart + i * 10), last_updated: iso(restart) });
  }
  for (let i = 0; i < 40; i++) {
    list.push({ entity_id: `sensor.busy_${i}`, state: String(i), attributes: {}, last_changed: iso(now - 60_000), last_updated: iso(now - 60_000) });
  }
  list.push({ entity_id: SCREEN, state: 'on', attributes: { device_class: 'door', friendly_name: 'East Screen door' }, last_changed: iso(restart + 500), last_updated: iso(restart + 500) });
  list.push({ entity_id: EAST_DOOR, state: 'off', attributes: { device_class: 'door', friendly_name: 'East door' }, last_changed: iso(now - 2 * HOUR), last_updated: iso(now - 2 * HOUR) });
  list.push({
    entity_id: 'sensor.house_temperature', state: '63.5', last_changed: iso(now - 5 * 60_000), last_updated: iso(now - 5 * 60_000),
    attributes: { device_class: 'temperature', unit_of_measurement: '°F', friendly_name: 'House temperature' },
  });
  return list;
}

// Temperature: one reading per 30 min, coldest 6 h ago.
function temperatureHistory(startMs: number, endMs: number): Array<Partial<HAEntity>> {
  const rows: Array<Partial<HAEntity>> = [];
  for (let t = startMs; t < endMs; t += 30 * 60_000) {
    const hoursAgo = (now - t) / HOUR;
    rows.push({ state: String(Math.round((60 + Math.abs(hoursAgo - 6)) * 10) / 10), last_changed: iso(t) });
  }
  rows[0] = { ...rows[0], entity_id: 'sensor.house_temperature', attributes: { friendly_name: 'House temperature' } };
  return rows;
}

const settings = { baseUrl: 'http://ha.example:8123', accessToken: 'test-token', injectIntoPrompt: false, cacheSeconds: 30 };

beforeEach(() => {
  new HomeAssistantService(settings).clearCache();
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (data: unknown) => ({ ok: true, json: async (): Promise<unknown> => data, text: async (): Promise<string> => JSON.stringify(data) });
    if (url.endsWith('/api/states')) return json(house());
    const one = url.match(/\/api\/states\/(.+)$/);
    if (one) return json(house().find(e => e.entity_id === decodeURIComponent(one[1])));
    const hist = url.match(/\/api\/history\/period\/([^?]+)\?filter_entity_id=([^&]+)/);
    if (hist) {
      const start = Date.parse(decodeURIComponent(hist[1]));
      // As HA does: with no end_time, one day from the start.
      const endParam = url.match(/[?&]end_time=([^&]+)/);
      const end = endParam ? Date.parse(decodeURIComponent(endParam[1])) : Math.min(now, start + 24 * HOUR);
      if (hist[2] === SCREEN) {
        // On the whole week: the start-of-window state, and the restart's own row.
        return json([[
          { entity_id: SCREEN, state: 'on', attributes: {}, last_changed: iso(start), last_updated: iso(start) },
          { state: 'unavailable', last_changed: iso(restart - 30_000) },
          { state: 'on', last_changed: iso(restart + 500) },
        ]]);
      }
      return json([temperatureHistory(start, end)]);
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async (): Promise<string> => '' };
  }) as unknown as typeof fetch;
});

describe('the curve', () => {
  test('24 h at the default 36 points is one average per hour, and the coldest hour is named', async () => {
    const h = await new HomeAssistantService(settings).getHistory('sensor.house_temperature', 24, 36);
    expect(h.curveStep).toMatch(/^1 hour averages/);
    expect(h.curve!.length).toBeGreaterThanOrEqual(24);
    expect(h.curve!.length).toBeLessThanOrEqual(25);
    expect(h.curve![0]).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:00 (AM|PM) \d+(\.\d+)?$/);
    expect(h.min).toBe(60);
    expect(Math.abs(Date.parse(h.minAt!) - (now - 6 * HOUR))).toBeLessThanOrEqual(30 * 60_000);
  });

  test('points sets the step, and 0 gives no curve', async () => {
    const ha = new HomeAssistantService(settings);
    expect((await ha.getHistory('sensor.house_temperature', 24, 100)).curveStep).toMatch(/^15 minutes/);
    expect((await ha.getHistory('sensor.house_temperature', 24, 0)).curve).toBeUndefined();
  });

  test('a week is the whole week, not its first day', async () => {
    // HA gives one day from the start unless end_time is sent: a 168 h history
    // stopped six days ago and the curve carried that day's last value on.
    const h = await new HomeAssistantService(settings).getHistory('sensor.house_temperature', 168, 36);
    expect(Number(h.last)).toBeLessThan(67); // the reading of the last half hour, not that of six days ago (~198)
    expect(Math.abs(Date.parse(h.minAt!) - (now - 6 * HOUR))).toBeLessThanOrEqual(30 * 60_000);
    const histUrls = (global.fetch as jest.Mock).mock.calls.map(c => String(c[0])).filter(u => u.includes('/api/history/period/'));
    expect(histUrls.every(u => /[?&]end_time=/.test(u))).toBe(true);
  });

  test('a step with no reading of its own carries the last one on', async () => {
    const h = await new HomeAssistantService(settings).getHistory('sensor.house_temperature', 24, 200); // 10-minute steps, readings every 30
    const values = h.curve!.map(p => p.split(' ').pop());
    expect(values.length).toBeGreaterThan(140);
    expect(values.every(v => v !== undefined && !Number.isNaN(Number(v)))).toBe(true);
  });
});

describe('change times reset by a restart', () => {
  test('the crowd at one minute is found; busy sensors of the last half hour are not', async () => {
    const resets = await new HomeAssistantService(settings).massResetTimes();
    expect(resets).toEqual([{ at: iso(Math.floor(restart / 60000) * 60000), entities: 61 }]);
  });

  const handler = new HomeAssistantHandler();
  const ctx = () => ({
    choom: { name: 'Genesis' }, choomId: 'c1', send: jest.fn(),
    sessionFileCount: { created: 0, maxAllowed: 50 },
    settings: { homeAssistant: settings },
  }) as unknown as Parameters<HomeAssistantHandler['execute']>[1];
  const call = (name: string, args: Record<string, unknown>) =>
    handler.execute({ id: 't1', name, arguments: args }, ctx()).then(r => r.result as Record<string, unknown>);

  test('ha_get_state says the time is the restart and how long it really held', async () => {
    const r = await call('ha_get_state', { entity_id: SCREEN });
    expect(String(r.last_changed_note)).toMatch(/61 entities show this same minute: Home Assistant restarted or reloaded then/);
    expect(String(r.last_changed_note)).toMatch(/Its history shows on for the whole 7 days, since at least/);
    expect(r.really_since).toBeDefined();
  });

  test("ha_get_history on the door says it didn't change, and what on means", async () => {
    const r = await call('ha_get_history', { entity_id: SCREEN, hours: 168 });
    expect(r.held).toBe("on the whole 168 hours: it didn't change in that time.");
    expect(r.on_means).toBe('open');
    expect(r.friendly_name).toBe('East Screen door');
  });

  test('a template that prints change times gets the restart named', async () => {
    jest.spyOn(HomeAssistantService.prototype, 'renderTemplate').mockResolvedValue('East Screen door = on');
    const r = await call('ha_render_template', { template: "{{ states.binary_sensor.x.state }} {{ states.binary_sensor.x.last_changed }}" });
    expect(String(r.times_note)).toMatch(/reset many entities' change times at once at .+ \(61 entities\)/);
    const plain = await call('ha_render_template', { template: '{{ states("sensor.house_temperature") }}' });
    expect(plain.times_note).toBeUndefined();
  });

  test('when the history\'s last row disagrees with the live state, "now" is the live state', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/history/period/') && url.includes(SCREEN)) {
        return { ok: true, json: async (): Promise<unknown> => [[
          { entity_id: SCREEN, state: 'on', attributes: {}, last_changed: iso(now - 160 * HOUR), last_updated: '' },
          { state: 'off', last_changed: iso(now - 140 * HOUR) },
        ]], text: async (): Promise<string> => '' };
      }
      return (realFetch as unknown as (i: RequestInfo | URL) => Promise<unknown>)(input);
    }) as unknown as typeof fetch;
    const h = await call('ha_get_history', { entity_id: SCREEN, hours: 168 });
    expect(String(h.held)).toMatch(/^on now\. Home Assistant has had it on since .+ \(its restart or reload: 61 entities show that minute\); the last change its history recorded was to off at /);
    const st = await call('ha_get_state', { entity_id: SCREEN });
    expect(String(st.last_changed_note)).toMatch(/The last change its history recorded was to off at .+; Home Assistant has had it on since the restart\./);
    expect(st.really_since).toBeUndefined();
    global.fetch = realFetch;
  });

  test('a door that changed more than 100 times says how many, not 99', async () => {
    // The east screen door on Nov 20: closed, then a few seconds open over and over.
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/history/period/') && url.includes(SCREEN)) {
        const rows: Array<Partial<HAEntity>> = [{ entity_id: SCREEN, state: 'on', attributes: {}, last_changed: iso(now - 160 * HOUR) }];
        for (let i = 1; i <= 150; i++) rows.push({ state: i % 2 ? 'off' : 'on', last_changed: iso(now - 140 * HOUR + i * 60_000) });
        return { ok: true, json: async (): Promise<unknown> => [rows], text: async (): Promise<string> => '' };
      }
      return (realFetch as unknown as (i: RequestInfo | URL) => Promise<unknown>)(input);
    }) as unknown as typeof fetch;
    const h = await call('ha_get_history', { entity_id: SCREEN, hours: 168 });
    expect(String(h.held)).toMatch(/^on now, since .+; it changed 150 times in 168 hours \(changes lists the last 100\)\.$/);
    expect((h.changes as unknown[]).length).toBe(100);
    global.fetch = realFetch;
  });

  test('a state read of an ordinary entity carries no note', async () => {
    const r = await call('ha_get_state', { entity_id: 'sensor.house_temperature' });
    expect(r.last_changed_note).toBeUndefined();
  });
});

describe("Donny's note on the east screen door", () => {
  test('rides along wherever the door shows, by id or by name', async () => {
    expect(houseNotesFor({ entity_id: SCREEN })).toHaveLength(1);
    expect(houseNotesFor({ alerts: ['Office Occupancy: motion', 'East Screen door: open'] })[0]).toMatch(/retractable screen door/);
    expect(houseNotesFor({ alerts: ['North Screen door: open'] })).toHaveLength(0);
    const r = await (new HomeAssistantHandler()).execute(
      { id: 't2', name: 'ha_get_home_status', arguments: {} },
      { choom: { name: 'Aloy' }, choomId: 'c1', send: jest.fn(), sessionFileCount: { created: 0, maxAllowed: 50 }, settings: { homeAssistant: settings } } as unknown as Parameters<HomeAssistantHandler['execute']>[1],
    );
    const note = (r.result as { house_notes?: string[] }).house_notes?.[0];
    expect(note).toMatch(/he normally keeps it open/);
    expect(note).toMatch(/opens the East door and closes the screen to let the house breathe; that's fine too/);
    expect(note).toMatch(/Only both open for more than a minute or so is a problem: rattlesnakes can get in/);
    expect((r.result as { doorways_now?: string[] }).doorways_now).toEqual(['East door: fine. The screen is open and the door is closed.']);
  });
});

describe("Donny's rule for a door and its screen", () => {
  const t = Date.parse('2026-11-26T20:00:00Z');
  const ent = (id: string, state: string, changedMsAgo: number): HAEntity =>
    ({ entity_id: id, state, attributes: {}, last_changed: iso(t - changedMsAgo), last_updated: iso(t - changedMsAgo) });

  test('one of the two open is fine, either way round', () => {
    expect(doorwayVerdict(EAST, ent(EAST_DOOR, 'off', HOUR), ent(SCREEN, 'on', 50 * HOUR), t)).toBe('East door: fine. The screen is open and the door is closed.');
    expect(doorwayVerdict(EAST, ent(EAST_DOOR, 'on', HOUR), ent(SCREEN, 'off', HOUR), t)).toBe('East door: fine. The door is open and its screen is closed (letting the house breathe).');
    expect(doorwayVerdict(EAST, ent(EAST_DOOR, 'off', HOUR), ent(SCREEN, 'off', HOUR), t)).toBe('East door: fine. The door and its screen are both closed.');
  });

  test('both open for a few seconds is someone going through', () => {
    // Nov 20: the East door open all afternoon, the screen open 3-9 s at a time
    const v = doorwayVerdict(EAST, ent(EAST_DOOR, 'on', 3 * HOUR), ent(SCREEN, 'on', 6_000), t)!;
    expect(v).toBe('East door: the door and its screen are both open right now (6 seconds): someone going through, most likely. Only a problem if it lasts more than a minute or so.');
  });

  test('both open past a minute is the problem, counted from the later of the two', () => {
    const v = doorwayVerdict(EAST, ent(EAST_DOOR, 'on', 3 * HOUR), ent(SCREEN, 'on', 4 * 60_000), t)!;
    expect(v).toMatch(/^East door: NOT OK\. The door and its screen have both been open since \S+ \(4 minutes\)\. Donny's rule: both open for more than a minute or so lets rattlesnakes in\. Tell Donny\.$/);
    expect(v).toContain(iso(t - 4 * 60_000));
  });

  test("a sensor that isn't reporting is said, not guessed", () => {
    expect(doorwayVerdict(EAST, ent(EAST_DOOR, 'unavailable', HOUR), ent(SCREEN, 'on', HOUR), t)).toBe("East door: can't tell right now, its door sensor reads unavailable.");
    expect(doorwayVerdict(EAST, undefined, undefined, t)).toBe("East door: can't tell right now, its door sensor reads nothing and its screen sensor reads nothing.");
    expect(doorwayVerdict({ name: 'shop door', door: 'binary_sensor.shop_door' }, ent('binary_sensor.shop_door', 'on', HOUR), undefined, t)).toBeNull();
  });

  test('only the doorways a result shows get a line', async () => {
    const handler = new HomeAssistantHandler();
    const run = (name: string, args: Record<string, unknown>) => handler.execute({ id: 't3', name, arguments: args },
      { choom: { name: 'Eve' }, choomId: 'c1', send: jest.fn(), sessionFileCount: { created: 0, maxAllowed: 50 }, settings: { homeAssistant: settings } } as unknown as Parameters<HomeAssistantHandler['execute']>[1])
      .then(r => r.result as Record<string, unknown>);
    expect((await run('ha_get_state', { entity_id: EAST_DOOR })).doorways_now).toEqual(['East door: fine. The screen is open and the door is closed.']);
    expect((await run('ha_get_state', { entity_id: 'sensor.house_temperature' })).doorways_now).toBeUndefined();
  });
});
