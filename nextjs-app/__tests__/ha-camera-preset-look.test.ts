/**
 * 2026-10-29: Aloy's overnight watch ran out of rounds in 48 of 126 runs.
 * A preset look took three rounds (select_option, snapshot, analyze_image),
 * 71 select_option calls arrived without their entity and got ha_call_service
 * disabled, and guessed names ("southeast", "driveway",
 * switch.kitchen1_sink_light) each cost a round. Entities below are the
 * homestead's own, trimmed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HAEntity } from '@/lib/homeassistant-service';

const ent = (entity_id: string, friendly_name: string, extra: Record<string, unknown> = {}, state = 'idle'): HAEntity =>
  ({ entity_id, state, attributes: { friendly_name, ...extra }, last_changed: '', last_updated: '' });

const STATES: HAEntity[] = [
  ent('camera.garage_camera_live_feed', 'Garage Camera Live Feed'),
  ent('camera.garage_camera_snapshots_clear', 'Garage cam snapshot'),
  ent('camera.tower_camera_live_feed', 'Tower Camera Live Feed'),
  ent('camera.tower_camera_camera_snapshot', 'Tower Camera camera snapshot'),
  ent('camera.outside_south_east_camera_snapshot', 'south east camera snapshot'),
  ent('camera.outside_south_east_camera_fluent', 'south east camera Fluent'),
  ent('camera.shop_camera', 'Shop Camera'),
  ent('select.garage_camera_ptz_preset', 'Garage Camera PTZ preset', { options: ['south east corner and gate', 'driveway sensor', 'container door', 'driveway'] }, 'unknown'),
  ent('select.tower_camera_ptz_preset', 'Tower Camera PTZ preset', { options: ['Kims wide', 'Driveway', 'gate', 'Gate wide'] }, 'unknown'),
  ent('select.outside_south_east_camera_ptz_preset', 'south east camera PTZ preset', { options: ['driveway', 'South', 'East'] }, 'unknown'),
  ent('select.stove_light_light_preset', 'Stove light Light preset', { options: ['Not set', 'Light preset 1'] }, 'Not set'),
  ent('light.sink_light', 'Sink Light', {}, 'off'),
  ent('light.kitchen1_ceiling', 'Kitchen1 ceiling light', {}, 'off'),
  ent('switch.kitchen1_stove_powerstrip', 'Kitchen1 stove powerstrip', {}, 'on'),
  ent('switch.kitchen1_counter_outlet', 'Kitchen1 counter outlet', {}, 'on'),
  ent('switch.bedroom_fan', 'Bedroom fan', {}, 'off'),
  // The shop: door open by default; the "shut, still, dark" tests close it.
  { ...ent('binary_sensor.shop_shop_door_sensor_shop_door', 'Shop Door', { device_class: 'door' }, 'on'), last_changed: '2026-10-30T03:25:12+00:00' },
  { ...ent('binary_sensor.shop_prox_sensor_shop_pir', 'Prox_sensor_shop PIR', { device_class: 'motion' }, 'off'), last_changed: '2026-10-30T03:24:38+00:00' },
  { ...ent('sensor.shop_prox_sensor_shop_illuminance', 'Prox_sensor_shop Illuminance', { unit_of_measurement: 'lx' }, '0.0'), last_changed: '2026-10-30T03:25:10+00:00' },
];
STATES.push(
  ent('binary_sensor.kitchen1_home_east_door_window', 'East door', { device_class: 'door' }, 'off'),
  ent('binary_sensor.kitchen1_home_east_screen_door_east_screen_door', 'East Screen door', { device_class: 'door' }, 'on'),
  ent('binary_sensor.living_room_home_north_screen_door_screen_door', 'North Screen door', { device_class: 'door' }, 'off'),
  ent('binary_sensor.living_room_home_north_door_north_door', 'North Door', { device_class: 'door' }, 'on'),
);
const setState = (id: string, state: string) => { STATES.find(e => e.entity_id === id)!.state = state; };

const renderTemplate = jest.fn(async (_t: string) => 'unknown');
const callService = jest.fn(async (..._a: unknown[]) => [] as HAEntity[]);
jest.mock('@/lib/homeassistant-service', () => ({
  HomeAssistantService: class {
    async listStates(domain?: string) { return domain ? STATES.filter(e => e.entity_id.startsWith(`${domain}.`)) : STATES; }
    async getState(id: string) {
      const e = STATES.find(s => s.entity_id === id);
      if (!e) throw new Error('HA API 404: Entity not found');
      return e;
    }
    async callService(...a: unknown[]) { return callService(...a); }
    async verifyServiceExists() { return true; }
    async renderTemplate(t: string) { return renderTemplate(t); }
    async getLogbook() { return []; }
  },
}));

const analyze = jest.fn(async (call: { arguments: Record<string, unknown> }) => ({
  toolCallId: 'x', name: 'analyze_image', result: { success: true, analysis: `Looked at ${call.arguments.image_path}: the container door is closed.`, model: 'vision-test' },
}));
jest.mock('@/skills/core/image-analysis/handler', () => ({
  __esModule: true,
  default: class { execute(call: { arguments: Record<string, unknown> }) { return analyze(call); } },
}));
jest.mock('@/lib/db', () => ({ __esModule: true, default: { generatedImage: { create: jest.fn(async () => ({ id: 'img1' })) } } }));
jest.mock('@/lib/captured-images', () => ({
  cameraSnapshotFolder: (slug: string) => `selfies_${slug}/camera`,
  pruneExpiredCaptures: jest.fn(async () => undefined),
  CAPTURE_RETENTION_HOURS: 72,
}));
jest.mock('@/lib/glass-camera', () => ({ askGlassCamera: jest.fn(), isGlassCameraName: () => false }));

let root: string;
jest.mock('@/lib/config', () => ({ ...jest.requireActual('@/lib/config'), get WORKSPACE_ROOT() { return root; } }));

import HomeAssistantHandler, { closestInAnyDomain, matchPresetOption, missingTemplateEntities, pickFewestExtraWords } from '@/skills/core/home-assistant/handler';
import { PARAM_ERROR } from '@/lib/tool-error-classification';

const JPEG = new Uint8Array(4096).fill(0xff);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-look-'));
  callService.mockClear();
  analyze.mockClear();
  global.fetch = jest.fn(async () => new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })) as unknown as typeof fetch;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const handler = new HomeAssistantHandler();
const ctx = () => ({
  choom: { name: 'Aloy' }, choomId: 'c1', send: jest.fn(),
  sessionFileCount: { created: 0, maxAllowed: 50 },
  settings: { homeAssistant: { baseUrl: 'http://ha.test:8123', accessToken: 't', injectIntoPrompt: false, cacheSeconds: 30 } },
}) as never;
const call = (name: string, args: Record<string, unknown>) => handler.execute({ id: 't1', name, arguments: args }, ctx());
const res = (r: { result: unknown }) => r.result as Record<string, unknown>;

describe('matchPresetOption', () => {
  const opts = ['Kims wide', 'Driveway', 'gate', 'Gate wide', 'house north side'];
  test('exact, case- and punctuation-blind, then a unique partial', () => {
    expect(matchPresetOption('driveway', opts)).toBe('Driveway');
    expect(matchPresetOption('kims-wide', opts)).toBe('Kims wide');
    expect(matchPresetOption('gate', opts)).toBe('gate');
    expect(matchPresetOption('north side', opts)).toBe('house north side');
    expect(matchPresetOption('driveway gate', opts)).toBeNull();
    expect(matchPresetOption('', opts)).toBeNull();
  });
});

describe('ha_get_camera_snapshot preset + question', () => {
  test('moves to the preset, waits, shoots, and answers the question in one call', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'garage', preset: 'Container Door', question: 'Is the container door closed?', settle_seconds: 1 });
    expect(r.error).toBeUndefined();
    expect(callService).toHaveBeenCalledWith('select', 'select_option', 'select.garage_camera_ptz_preset', { option: 'container door' });
    const out = res(r);
    expect(out.entity_id).toBe('camera.garage_camera_live_feed');
    expect(out.preset).toBe('container door');
    expect(out.analysis).toMatch(/container door is closed/);
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ arguments: { image_path: out.path, prompt: 'Is the container door closed?' } }));
    expect(String(out.message)).toMatch(/IS that view/);
    expect(String(out.message)).toMatch(/no need to call analyze_image/);
    expect(fs.existsSync(path.join(root, String(out.path)))).toBe(true);
  });

  test('a preset this camera lacks moves nothing, and names the camera that has it', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'garage', preset: 'Kims wide' });
    expect(callService).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    const out = res(r);
    expect(out.success).toBe(false);
    expect(out.valid_presets).toEqual(['south east corner and gate', 'driveway sensor', 'container door', 'driveway']);
    expect(String(out.hint)).toMatch(/camera\.tower_camera_live_feed \("Kims wide"\)/);
  });

  test('a camera without presets gives its fixed view, never another camera\'s presets', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'shop', preset: 'door' });
    expect(callService).not.toHaveBeenCalled();
    const out = res(r);
    expect(out.entity_id).toBe('camera.shop_camera');
    expect(out.presets).toBeUndefined();
    expect(String(out.message)).toMatch(/no PTZ presets, so this is its fixed view/);
  });

  test('without question, no vision call and a pointer to question=', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'tower' });
    expect(analyze).not.toHaveBeenCalled();
    expect(String(res(r).message)).toMatch(/pass question=/);
    expect(res(r).look_at_preset).toMatch(/preset="<one of presets>"/);
  });

  test('"southeast" finds the south east camera', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'southeast' });
    expect(r.error).toBeUndefined();
    expect(String(res(r).entity_id)).toMatch(/^camera\.outside_south_east_camera_/);
  });

  test('"driveway" is a preset, not a camera: the error says which cameras have it', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'driveway' });
    expect(r.error).toMatch(/^No camera matches "driveway"/);
    expect(r.error).toMatch(/is a PTZ preset, not a camera/);
    expect(r.error).toMatch(/camera\.garage_camera_live_feed has preset "driveway"/);
    expect(r.error).toMatch(/camera\.tower_camera_live_feed has preset "Driveway"/);
    expect(r.error).toMatch(/preset="driveway"\)/);
  });
});

// 2026-10-29: the shop camera is black whenever the shop door is shut, and the
// watch shot and analyzed it every hour anyway.
describe('the shop camera while the shop is shut, still and dark', () => {
  const DOOR = 'binary_sensor.shop_shop_door_sensor_shop_door';
  const PIR = 'binary_sensor.shop_prox_sensor_shop_pir';
  const LUX = 'sensor.shop_prox_sensor_shop_illuminance';
  beforeEach(() => { setState(DOOR, 'off'); setState(PIR, 'off'); setState(LUX, '0.0'); });
  afterEach(() => { setState(DOOR, 'on'); setState(PIR, 'off'); setState(LUX, '0.0'); });

  test('takes no picture and runs no analysis; the shop counts as checked', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'shop', question: 'Anything moving?' });
    expect(r.error).toBeUndefined();
    const out = res(r);
    expect(out.skipped).toBe(true);
    expect(out.entity_id).toBe('camera.shop_camera');
    expect(out.shop_light_lx).toBe(0);
    expect(String(out.message)).toMatch(/^No picture taken: the shop door has been closed since \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
    expect(String(out.message)).toMatch(/shut and still/);
    expect(String(out.message)).toMatch(/force=true/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  test.each([
    ['the door is open', () => setState(DOOR, 'on')],
    ['the PIR sees motion', () => setState(PIR, 'on')],
    ['the lights are on', () => setState(LUX, '120')],
  ])('takes the picture when %s', async (_why, change) => {
    change();
    const r = await call('ha_get_camera_snapshot', { entity_id: 'shop' });
    expect(res(r).skipped).toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });

  test('force=true takes it anyway', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'shop', force: true });
    expect(res(r).skipped).toBeUndefined();
    expect(res(r).path).toBeDefined();
  });

  test('other cameras are never skipped', async () => {
    const r = await call('ha_get_camera_snapshot', { entity_id: 'tower' });
    expect(res(r).skipped).toBeUndefined();
  });
});

describe('ha_call_service without an entity', () => {
  test('a bare select_option is a param error that lists the preset controls', async () => {
    const r = await call('ha_call_service', { domain: 'select', service: 'select_option' });
    expect(r.error).toMatch(/^entity_id is required/);
    expect(PARAM_ERROR.test(String(r.error))).toBe(true); // the tool stays on for her next try
    expect(r.error).toMatch(/select\.garage_camera_ptz_preset \(south east corner and gate/);
    expect(r.error).not.toMatch(/stove_light/);
    expect(r.error).toMatch(/ha_get_camera_snapshot\(entity_id="<camera>", preset="<preset>"\)/);
    expect(r.error).not.toMatch(/You provided service_data/);
    expect(callService).not.toHaveBeenCalled();
  });

  test('entity_id inside service_data (HA YAML style) is used', async () => {
    const r = await call('ha_call_service', { domain: 'select', service: 'select_option', service_data: { entity_id: 'select.garage_camera_ptz_preset', option: 'Container Door', settle_seconds: 1 } });
    expect(r.error).toBeUndefined();
    expect(callService).toHaveBeenCalledWith('select', 'select_option', 'select.garage_camera_ptz_preset', { option: 'container door' }, undefined);
  });

  test('other services get the generic "is required" answer', async () => {
    const r = await call('ha_call_service', { domain: 'light', service: 'turn_on', service_data: { brightness: 50 } });
    expect(r.error).toMatch(/^entity_id is required: "light\.turn_on"/);
    expect(r.error).toMatch(/service_data=\{"brightness":50\}/);
  });
});

describe('guessed ids in the wrong domain', () => {
  test('closestInAnyDomain ranks the rare word first', () => {
    const near = closestInAnyDomain('switch.kitchen1_sink_light', STATES);
    expect(near[0].entity_id).toBe('light.sink_light');
  });

  test('ha_get_history names light.sink_light for switch.kitchen1_sink_light', async () => {
    const r = await call('ha_get_history', { entity_id: 'switch.kitchen1_sink_light', hours: 12 });
    expect(r.error).toMatch(/doesn't exist/);
    expect(r.error).toMatch(/Closest matches in any domain: light\.sink_light \("Sink Light"\)/);
    expect(r.error).toMatch(/Real switch entities on THIS system/); // still read as recoverable
  });
});

// 2026-10-29: Aloy's door sweep read the north door as "unknown" from a guessed
// id in a template; she and Genesis guessed its id on six different days.
describe('templates that name entities that do not exist', () => {
  test('missingTemplateEntities finds guessed ids, not loop variables or real ids', () => {
    const t = "{{ states('binary_sensor.north_door') }} {{ states.binary_sensor.living_room_home_north_door_north_door.last_changed }} " +
      "{% for light in states.light %}{{ light.entity_id }} {{ light.state }}{% endfor %} {{ is_state('binary_sensor.shop_shop_door_sensor_shop_door', 'off') }}";
    expect(missingTemplateEntities(t, STATES)).toEqual(['binary_sensor.north_door']);
  });

  test('a rendered template with a guessed id carries a warning naming the real one', async () => {
    renderTemplate.mockResolvedValueOnce('north: unknown');
    const r = await call('ha_render_template', { template: "north: {{ states('binary_sensor.north_door') }}" });
    expect(r.error).toBeUndefined();
    expect(res(r).missing_entities).toEqual(['binary_sensor.north_door']);
    expect(String(res(r).warning)).toMatch(/don't exist, so Home Assistant read them as "unknown"\/None/);
    expect(String(res(r).warning)).toMatch(/binary_sensor\.north_door \(closest: .*binary_sensor\.living_room_home_north_door_north_door/);
  });

  test('a template that fails on a guessed id says which id, as a recoverable error', async () => {
    // Both tries fail: the local-time version of the template, then the original.
    const undef = new Error("HA template 400: UndefinedError: 'None' has no attribute 'last_changed'");
    renderTemplate.mockRejectedValueOnce(undef).mockRejectedValueOnce(undef);
    const r = await call('ha_render_template', { template: '{{ states.binary_sensor.north_door_contact.last_changed }}' });
    expect(r.error).toMatch(/^Home Assistant error: HA template 400/);
    expect(r.error).toMatch(/binary_sensor\.north_door_contact \(closest:/);
    expect(r.error).toMatch(/don't exist/); // PATH_ERROR: not counted as a tool failure
  });

  test('a template with only real ids has no warning', async () => {
    renderTemplate.mockResolvedValueOnce('off');
    const r = await call('ha_render_template', { template: "{{ states('binary_sensor.shop_shop_door_sensor_shop_door') }}" });
    expect(res(r).warning).toBeUndefined();
  });
});

describe('loose names for reads prefer the name with no extra words', () => {
  test('north_door_contact reads the North Door, not the North Screen door', async () => {
    const r = await call('ha_get_state', { entity_id: 'binary_sensor.north_door_contact' });
    expect(r.error).toBeUndefined();
    expect(res(r).entity_id).toBe('binary_sensor.living_room_home_north_door_north_door');
    expect(res(r).resolved_from).toBe('binary_sensor.north_door_contact');
  });

  test('"east door" logbook reads the East door', async () => {
    const r = await call('ha_get_logbook', { entity_id: 'east door', hours: 3 });
    expect(r.error).toBeUndefined();
    expect(res(r).entity_id).toBe('binary_sensor.kitchen1_home_east_door_window');
  });

  test('a word that names something elsewhere blocks the pick', () => {
    const tied = [ent('switch.kitchen1_light', 'Kitchen1 light'), ent('switch.kitchen1_stove_powerstrip_x', 'Kitchen1 stove powerstrip x')];
    expect(pickFewestExtraWords('switch.kitchen1_sink_light', tied, [...STATES, ...tied])).toBeNull(); // light.sink_light has "sink"
    expect(pickFewestExtraWords('switch.kitchen1_light', tied, [...STATES, ...tied])?.entity_id).toBe('switch.kitchen1_light');
  });

  test('a wide tie stays a list', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map(x => ent(`sensor.temp_${x}`, `Temp ${x}`));
    expect(pickFewestExtraWords('temp', many, many)).toBeNull();
  });
});
