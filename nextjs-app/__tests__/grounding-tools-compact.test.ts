/**
 * Phase 1 of the context plan (2026-09-12): the four tools a Choom calls to
 * ground herself were the largest results in the system — home status 31k
 * chars average, workspace listing 9.7k, memory search 9.4k, follow-ups 5.8k —
 * and they are re-sent on every later iteration of the turn. Each now returns
 * a compact form by default with the detail one argument away.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@/lib/db', () => ({ __esModule: true, default: {}, prisma: {} }));

import { HomeAssistantService, type HAEntity } from '@/lib/homeassistant-service';
import { WorkspaceService } from '@/lib/workspace-service';
import { compactMemory } from '@/skills/core/memory-management/handler';
import MemoryManagementHandler from '@/skills/core/memory-management/handler';
import WorkspaceFilesHandler from '@/skills/core/workspace-files/handler';
import SelfSchedulingHandler from '@/skills/core/self-scheduling/handler';
import * as followupStore from '@/lib/self-followup-store';

const ent = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HAEntity =>
  ({ entity_id, state, attributes, last_changed: '', last_updated: '' });

describe('ha_get_home_status compact glance', () => {
  function serviceWith(entities: HAEntity[]) {
    const svc = new HomeAssistantService({ baseUrl: 'http://ha', accessToken: 't', injectIntoPrompt: false, cacheSeconds: 30 });
    jest.spyOn(svc, 'listStates').mockResolvedValue(entities);
    return svc;
  }

  test('a 1,000-entity house reads in a few thousand chars and keeps what matters', async () => {
    const entities: HAEntity[] = [
      ent('person.donny', 'home', { friendly_name: 'Donny' }),
      ent('light.kitchen', 'on', { friendly_name: 'Kitchen', brightness: 128 }),
      ent('light.porch', 'off', { friendly_name: 'Porch' }),
      ent('binary_sensor.garage_door', 'on', { friendly_name: 'Garage Door', device_class: 'garage_door' }),
      ent('binary_sensor.hall_motion', 'off', { friendly_name: 'Hall Motion', device_class: 'motion' }),
      ent('binary_sensor.pump', 'on', { friendly_name: 'Well Pump', device_class: 'problem' }),
      ent('binary_sensor.shop_link', 'off', { friendly_name: 'Shop Link', device_class: 'connectivity' }),
      ent('sensor.solar_power', '2179', { friendly_name: 'Solar Power', device_class: 'power', unit_of_measurement: 'W' }),
      ent('sensor.battery_soc', '98', { friendly_name: 'Battery SOC', device_class: 'battery', unit_of_measurement: '%' }),
      ent('sensor.remote_battery', '12', { friendly_name: 'Remote Battery', device_class: 'battery', unit_of_measurement: '%' }),
      ent('sensor.outdoor_temp', '88.4', { friendly_name: 'Outdoor Temperature', device_class: 'temperature', unit_of_measurement: '°F' }),
      ent('climate.house', 'cool', { friendly_name: 'House', temperature: 72, current_temperature: 75, hvac_action: 'cooling' }),
      ent('update.core', 'on', { friendly_name: 'Home Assistant Core' }),
      ent('camera.driveway', 'idle', { friendly_name: 'Driveway' }),
      ent('sensor.ghost', 'unavailable', { friendly_name: 'Ghost' }),
    ];
    // 700 assorted sensors and 60 per-plug power meters, the way a real homestead looks.
    for (let i = 0; i < 700; i++) entities.push(ent(`sensor.misc_${i}`, String(i), { friendly_name: `Misc ${i}` }));
    for (let i = 0; i < 60; i++) entities.push(ent(`sensor.plug_${i}_power`, '3.2', { friendly_name: `Plug ${i} Power`, device_class: 'power', unit_of_measurement: 'W' }));
    for (let i = 0; i < 40; i++) entities.push(ent(`switch.relay_${i}`, 'on', { friendly_name: `Relay ${i}` }));

    const out = await serviceWith(entities).getCompactHomeStatus();
    const json = JSON.stringify(out);
    expect(json.length).toBeLessThan(4000);
    expect(out.people).toEqual(['Donny: home']);
    expect(out.lights_on).toEqual(['Kitchen (50%)']);
    expect(out.alerts).toEqual(expect.arrayContaining(['Garage Door: open', 'Well Pump: problem']));
    expect(out.low_batteries).toEqual(['Remote Battery: 12 %']);
    expect(out.offline_devices).toEqual(['Shop Link']);
    expect(out.updates_available).toEqual(['Home Assistant Core']);
    expect(out.climate).toEqual(['House: cooling, now 75°, target 72°']);
    // Solar and battery outrank 60 anonymous plug meters, and the block is capped.
    const energy = out.energy as string[];
    expect(energy[0]).toBe('Solar Power: 2179 W');
    expect(energy[1]).toBe('Battery SOC: 98 %');
    expect(energy.length).toBeLessThanOrEqual(12);
    expect(out.environment).toEqual(['Outdoor Temperature: 88.4 °F']);
    // 40 switches on → 15 shown plus a count, not 40 names.
    expect((out.switches_on as { shown: string[]; more: number }).more).toBe(25);
    expect(String(out.summary)).toContain('1 lights on');
    expect(String(out.summary)).toContain('2 open/motion/problem');
    expect(json).not.toContain('Misc 3');
  });

  test('detail=true is capped per domain and says how many were left out', async () => {
    const entities: HAEntity[] = [];
    for (let i = 0; i < 300; i++) entities.push(ent(`sensor.s_${i}`, String(i), { friendly_name: `Sensor ${i}` }));
    for (let i = 0; i < 5; i++) entities.push(ent(`light.l_${i}`, 'on', { friendly_name: `Light ${i}` }));
    const svc = serviceWith(entities);
    // The handler's detail path goes through getHomeSummary; exercise the same shape here.
    const groups = await svc.getHomeSummary(false);
    expect(groups.sensor).toHaveLength(300);
    // The cap itself lives in the handler; cover it through the handler with the service mocked.
    jest.resetModules();
    jest.doMock('@/lib/homeassistant-service', () => ({
      ...jest.requireActual('@/lib/homeassistant-service'),
      HomeAssistantService: jest.fn().mockImplementation(() => ({
        getHomeSummary: () => Promise.resolve(groups),
        getCompactHomeStatus: () => Promise.resolve({ summary: 'compact' }),
      })),
    }));
    const Handler = (await import('@/skills/core/home-assistant/handler')).default;
    const h = new Handler();
    const ctx = { settings: { homeAssistant: { baseUrl: 'http://ha', accessToken: 't' } } } as unknown as Parameters<typeof h.execute>[1];
    const full = await h.execute({ id: '1', name: 'ha_get_home_status', arguments: { detail: true } }, ctx);
    const r = full.result as { domains: Record<string, unknown>; note?: string; matched_entities: number };
    expect(r.matched_entities).toBe(305);
    expect((r.domains.sensor as { shown: unknown[]; more: number }).shown).toHaveLength(25);
    expect((r.domains.sensor as { more: number }).more).toBe(275);
    expect(r.domains.light).toHaveLength(5);
    expect(r.note).toMatch(/275 entities not shown/);
    expect(JSON.stringify(full.result).length).toBeLessThan(6000);
    const glance = await h.execute({ id: '2', name: 'ha_get_home_status', arguments: {} }, ctx);
    expect(glance.result).toEqual({ summary: 'compact' });
  });

  test('a quiet house says so instead of listing nothing', async () => {
    const out = await serviceWith([ent('light.a', 'off', { friendly_name: 'A' })]).getCompactHomeStatus();
    expect(String(out.summary)).toContain('nothing open, no motion, no problems');
    expect(out).not.toHaveProperty('alerts');
    expect(out).not.toHaveProperty('lights_on');
  });
});

describe('workspace_list_files depth and folder counts', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    fs.mkdirSync(path.join(root, 'selfies', 'images'), { recursive: true });
    fs.mkdirSync(path.join(root, 'journals'), { recursive: true });
    fs.writeFileSync(path.join(root, 'journals', 'journal.md'), 'hi');
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, 'selfies', 'images', `img_${i}.png`), 'x');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('depth 2 still shows a nested journal, and a deep image folder shows a count instead of 40 paths', async () => {
    const ws = new WorkspaceService(root, 1024, ['.md', '.png']);
    const { entries, truncated } = await ws.listFilesRecursive('', 2, 80);
    const paths = entries.map(e => e.path);
    expect(paths).toContain('journals/journal.md');
    expect(paths).toContain('selfies/images');
    expect(paths).not.toContain('selfies/images/img_0.png');
    expect(entries.find(e => e.path === 'selfies/images')?.children).toBe(40);
    expect(truncated).toBe(false);
  });

  test('a folder that does not exist is an error, not an empty listing', async () => {
    jest.resetModules();
    jest.doMock('@/lib/config', () => ({
      ...jest.requireActual('@/lib/config'),
      WORKSPACE_ROOT: root, WORKSPACE_MAX_FILE_SIZE_KB: 1024, WORKSPACE_ALLOWED_EXTENSIONS: ['.md', '.png'],
    }));
    const Handler = (await import('@/skills/core/workspace-files/handler')).default as typeof WorkspaceFilesHandler;
    const h = new Handler();
    const ctx = { sessionFileCount: { created: 0, maxAllowed: 10 } } as unknown as Parameters<typeof h.execute>[1];
    const missing = await h.execute({ id: '1', name: 'workspace_list_files', arguments: { path: 'choom_commons/for_genesis' } }, ctx);
    expect(missing.error).toMatch(/does not exist/);
    const empty = await h.execute({ id: '2', name: 'workspace_list_files', arguments: { path: 'journals' } }, ctx);
    expect(empty.error).toBeUndefined();
  });

  test('root is a one-level map, a folder opens two levels, depth overrides', async () => {
    jest.resetModules();
    jest.doMock('@/lib/config', () => ({
      ...jest.requireActual('@/lib/config'),
      WORKSPACE_ROOT: root, WORKSPACE_MAX_FILE_SIZE_KB: 1024, WORKSPACE_ALLOWED_EXTENSIONS: ['.md', '.png'],
    }));
    const Handler = (await import('@/skills/core/workspace-files/handler')).default as typeof WorkspaceFilesHandler;
    const h = new Handler();
    const ctx = { sessionFileCount: { created: 0, maxAllowed: 10 } } as unknown as Parameters<typeof h.execute>[1];
    // Root = map of projects: one level with counts, so no album can crowd out the rest.
    const rootMap = await h.execute({ id: '0', name: 'workspace_list_files', arguments: {} }, ctx);
    const rootText = (rootMap.result as { formatted: string }).formatted;
    expect(rootText).toContain('selfies/ (1 inside)');
    expect(rootText).toContain('journals/ (1 inside)');
    expect(rootText).not.toContain('journal.md');
    expect(rootMap.result).not.toHaveProperty('entries'); // no second copy of the listing
    // Inside a folder: two levels, so a file nested one folder down is visible.
    const inside = await h.execute({ id: '1', name: 'workspace_list_files', arguments: { path: 'selfies' } }, ctx);
    expect((inside.result as { formatted: string }).formatted).toContain('selfies/images/img_0.png');
    // depth=1 on that folder shows the album as a count instead of 40 paths.
    const shallow = await h.execute({ id: '2', name: 'workspace_list_files', arguments: { path: 'selfies', depth: 1 } }, ctx);
    const shallowText = (shallow.result as { formatted: string }).formatted;
    expect(shallowText).toContain('selfies/images/ (40 inside)');
    expect(shallowText).not.toContain('img_0.png');
  });
});

describe('search_memories compact excerpts', () => {
  const raw = {
    id: 'mem_1', title: 'Rack build', content: 'x'.repeat(700), timestamp: '2026-09-11T10:00:00-06:00',
    tags: "['a','b']", importance: '9.5', memory_type: 'event', metadata: "{'reinforcement_accum': 0.4}",
    companion_id: 'c1', relevance_score: '0.678796', match_type: 'semantic',
  };

  test('compactMemory keeps title, type, date, importance and a 300-char excerpt', () => {
    const m = compactMemory(raw);
    expect(m).toMatchObject({ id: 'mem_1', title: 'Rack build', type: 'event', date: '2026-09-11', importance: 9.5, relevance: 0.68, truncated: true });
    expect((m.excerpt as string).length).toBe(300);
    expect(m).not.toHaveProperty('metadata');
    expect(m).not.toHaveProperty('companion_id');
  });

  test('the handler defaults search_memories to 5 results and detail=true returns the raw form', async () => {
    const search = jest.fn().mockResolvedValue({ success: true, data: [raw, raw] });
    const ctx = { memoryClient: { search }, memoryCompanionId: 'c1' } as unknown as Parameters<MemoryManagementHandler['execute']>[1];
    const h = new MemoryManagementHandler();
    const compact = await h.execute({ id: '1', name: 'search_memories', arguments: { query: 'rack' } }, ctx);
    expect(search).toHaveBeenLastCalledWith('rack', 5, 'c1');
    expect((compact.result as { count: number; memories: unknown[]; note?: string }).count).toBe(2);
    expect(JSON.stringify(compact.result).length).toBeLessThan(JSON.stringify({ success: true, data: [raw, raw] }).length);
    const full = await h.execute({ id: '2', name: 'search_memories', arguments: { query: 'rack', detail: true, limit: 10 } }, ctx);
    expect(search).toHaveBeenLastCalledWith('rack', 10, 'c1');
    expect((full.result as { data: unknown[] }).data).toHaveLength(2);
  });
});

describe('list_self_followups one line per entry', () => {
  test('31 pending entries fit in a few lines each, soonest first, with the id for cancelling', async () => {
    const entries = Array.from({ length: 31 }, (_, i) => ({
      id: `sf_${i.toString(16).padStart(8, '0')}`, choom_id: 'c', choom_name: 'Genesis',
      prompt: `Check on the greenhouse humidity and report back to Donny with a plan number ${i} `.repeat(4),
      reason: 'because', trigger_at: new Date(Date.UTC(2026, 8, 13, 12 + (31 - i), 0)).toISOString(),
      created_at: '', consumed: false, target: i % 3 === 0 ? 'room' as const : 'signal' as const,
    }));
    jest.spyOn(followupStore, 'listEntries').mockReturnValue(entries as unknown as ReturnType<typeof followupStore.listEntries>);
    const h = new SelfSchedulingHandler();
    const out = await h.execute({ id: '1', name: 'list_self_followups', arguments: {} }, { choomId: 'c' } as unknown as Parameters<SelfSchedulingHandler['execute']>[1]);
    const r = out.result as { pending_count: number; followups: string[] };
    expect(r.pending_count).toBe(31);
    expect(r.followups).toHaveLength(31);
    expect(r.followups[0]).toMatch(/^sf_0000001e \| /); // soonest (i=30) first
    expect(r.followups[0]).toContain(' | room | '); // i=30 is a room follow-up
    expect(r.followups[1]).toContain(' | signal | ');
    expect(r.followups[0].length).toBeLessThan(160);
    expect(JSON.stringify(out.result).length).toBeLessThan(6000);
  });
});
