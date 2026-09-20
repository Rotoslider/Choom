/**
 * pickCameraAmongTies — "tower" tied between camera.tower_camera_live_feed and
 * camera.tower_camera_camera_snapshot and was refused 8–16 times a day
 * (nightly doctor 2026-09-15 → 09-19). Same physical camera → pick the live
 * feed. Different cameras → still refuse (null) so the caller lists them.
 */
import { pickCameraAmongTies } from '@/skills/core/home-assistant/handler';

const cam = (entity_id: string, friendly_name: string) =>
  ({ entity_id, state: 'idle', attributes: { friendly_name }, last_changed: '', last_updated: '' }) as never;

const towerLive = cam('camera.tower_camera_live_feed', 'Tower Camera Live Feed');
const towerSnap = cam('camera.tower_camera_camera_snapshot', 'Tower Camera camera snapshot');
const garageLive = cam('camera.garage_camera_live_feed', 'Garage Camera Live Feed');
const garageClear = cam('camera.garage_camera_snapshots_clear', 'Garage Camera snapshots clear');

describe('pickCameraAmongTies', () => {
  it('prefers the live feed when the tie is one physical camera', () => {
    expect(pickCameraAmongTies([towerSnap, towerLive])).toBe(towerLive);
    expect(pickCameraAmongTies([garageClear, garageLive])).toBe(garageLive);
  });

  it('refuses when the tied entities are different cameras', () => {
    expect(pickCameraAmongTies([towerLive, garageLive])).toBeNull();
  });

  it('falls back to the clear/main flavour when there is no live feed', () => {
    const fluent = cam('camera.driveway_snapshots_fluent', 'Driveway snapshots fluent');
    const clear = cam('camera.driveway_snapshots_clear', 'Driveway snapshots clear');
    expect(pickCameraAmongTies([fluent, clear])).toBe(clear);
  });

  it('returns the sole entity when only one is given', () => {
    expect(pickCameraAmongTies([towerLive])).toBe(towerLive);
  });
});
