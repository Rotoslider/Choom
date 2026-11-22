/**
 * 2026-11-21: Home Assistant's camera and media-player tokens were reaching
 * the model. Between Sep 15 and Nov 20, 105 ha_get_state results carried a
 * camera's access_token, and 11 more carried picture links with ?token=.
 * ha_render_template passed them on as well when a template printed a
 * camera's attributes. In November 2026 OpenRouter said an attacker had read
 * one of its providers' stored requests (GMI Cloud) and searched them for
 * credentials. Every HA tool result now goes through stripHaTokens.
 */
import type { HAEntity } from '@/lib/homeassistant-service';

// Made-up 64-hex tokens, the shape HA uses; built here so no key-shaped
// literal sits in the repo for the secret scanner.
const CAM_TOKEN = 'a1b2c3d4'.repeat(8);
const MEDIA_TOKEN = '0f9e8d7c'.repeat(8);

const STATES: HAEntity[] = [
  {
    entity_id: 'camera.tower_camera_live_feed', state: 'idle', last_changed: '', last_updated: '',
    attributes: {
      friendly_name: 'Tower Camera Live Feed', access_token: CAM_TOKEN,
      entity_picture: `/api/camera_proxy/camera.tower_camera_live_feed?token=${CAM_TOKEN}`, brand: 'Reolink',
    },
  },
  {
    entity_id: 'media_player.kitchen', state: 'playing', last_changed: '', last_updated: '',
    attributes: {
      friendly_name: 'Kitchen', media_title: 'Song',
      entity_picture_local: `/api/media_player_proxy/media_player.kitchen?token=${MEDIA_TOKEN}&cache=7c1d`,
    },
  },
];

const renderTemplate = jest.fn(async (_t: string) => '');
jest.mock('@/lib/homeassistant-service', () => ({
  HomeAssistantService: class {
    async listStates() { return STATES; }
    async getState(id: string) {
      const e = STATES.find(s => s.entity_id === id);
      if (!e) throw new Error('HA API 404: Entity not found');
      return e;
    }
    async renderTemplate(t: string) { return renderTemplate(t); }
  },
}));
jest.mock('@/skills/core/image-analysis/handler', () => ({ __esModule: true, default: class {} }));
jest.mock('@/lib/db', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/captured-images', () => ({
  cameraSnapshotFolder: (slug: string) => `selfies_${slug}/camera`,
  pruneExpiredCaptures: jest.fn(async () => undefined),
  CAPTURE_RETENTION_HOURS: 72,
}));
jest.mock('@/lib/glass-camera', () => ({ askGlassCamera: jest.fn(), isGlassCameraName: () => false }));

import HomeAssistantHandler, { stripHaTokens } from '@/skills/core/home-assistant/handler';

const handler = new HomeAssistantHandler();
const ctx = () => ({
  choom: { name: 'Aloy' }, choomId: 'c1', send: jest.fn(),
  sessionFileCount: { created: 0, maxAllowed: 50 },
  settings: { homeAssistant: { baseUrl: 'http://ha.test:8123', accessToken: 't', injectIntoPrompt: false, cacheSeconds: 30 } },
}) as never;
const call = (name: string, args: Record<string, unknown>) => handler.execute({ id: 't1', name, arguments: args }, ctx());
const noTokens = (v: unknown) => {
  const s = JSON.stringify(v);
  expect(s).not.toContain(CAM_TOKEN);
  expect(s).not.toContain(MEDIA_TOKEN);
};

describe('stripHaTokens', () => {
  it('drops access_token keys at any depth and keeps the rest', () => {
    const out = stripHaTokens({ a: { access_token: CAM_TOKEN, brand: 'Reolink' }, list: [{ ACCESS_TOKEN: CAM_TOKEN, n: 1 }] });
    expect(out).toEqual({ a: { brand: 'Reolink' }, list: [{ n: 1 }] });
  });

  it('replaces the token in proxy links and keeps the link', () => {
    expect(stripHaTokens(`/api/media_player_proxy/media_player.kitchen?token=${MEDIA_TOKEN}&cache=7c1d`))
      .toBe('/api/media_player_proxy/media_player.kitchen?token=removed&cache=7c1d');
    expect(stripHaTokens(`http://ha:8123/api/camera_proxy/camera.x?access_token=${CAM_TOKEN}`))
      .toBe('http://ha:8123/api/camera_proxy/camera.x?access_token=removed');
  });

  it('replaces the token in rendered template text (Python dict and JSON)', () => {
    expect(stripHaTokens(`{'access_token': '${CAM_TOKEN}', 'friendly_name': 'Tower'}`))
      .toBe(`{'access_token': 'removed', 'friendly_name': 'Tower'}`);
    expect(stripHaTokens(`{"access_token":"${CAM_TOKEN}","brand":"Reolink"}`))
      .toBe('{"access_token":"removed","brand":"Reolink"}');
  });

  it('leaves ordinary text, numbers, and binary data alone', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(stripHaTokens('The garage door is closed; token ring battery 80%')).toBe('The garage door is closed; token ring battery 80%');
    expect(stripHaTokens(42)).toBe(42);
    expect(stripHaTokens(null)).toBeNull();
    expect(stripHaTokens(bytes)).toBe(bytes);
  });
});

describe('HA tools hand back no tokens', () => {
  it('ha_get_state on a camera', async () => {
    const r = await call('ha_get_state', { entity_id: 'camera.tower_camera_live_feed' });
    expect(r.error).toBeUndefined();
    noTokens(r);
    expect((r.result as { attributes: Record<string, unknown> }).attributes).toEqual({ brand: 'Reolink' });
  });

  it('ha_get_state on a media player keeps its picture link without the token', async () => {
    const r = await call('ha_get_state', { entity_id: 'media_player.kitchen' });
    noTokens(r);
    expect((r.result as { attributes: Record<string, unknown> }).attributes.entity_picture_local)
      .toBe('/api/media_player_proxy/media_player.kitchen?token=removed&cache=7c1d');
  });

  it('ha_render_template printing a camera\'s attributes', async () => {
    renderTemplate.mockResolvedValueOnce(
      `{'access_token': '${CAM_TOKEN}', 'friendly_name': 'Tower Camera Live Feed', 'entity_picture': '/api/camera_proxy/camera.tower_camera_live_feed?token=${CAM_TOKEN}'}`,
    );
    const r = await call('ha_render_template', { template: "{{ states.camera.tower_camera_live_feed.attributes }}" });
    expect(r.error).toBeUndefined();
    noTokens(r);
  });

  it('ha_render_template returning JSON', async () => {
    renderTemplate.mockResolvedValueOnce(JSON.stringify([{ entity_id: 'camera.tower_camera_live_feed', access_token: CAM_TOKEN }]));
    const r = await call('ha_render_template', { template: '{{ states.camera | map(attribute="attributes") | list | tojson }}' });
    noTokens(r);
    expect((r.result as { rendered: unknown }).rendered).toEqual([{ entity_id: 'camera.tower_camera_live_feed' }]);
  });
});
