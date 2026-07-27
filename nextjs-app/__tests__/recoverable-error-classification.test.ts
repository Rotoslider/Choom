/**
 * The agentic loop disables a tool after N failures. Errors that are actually
 * *recoverable* — the error text itself contains the correct answer — must not
 * count toward that cap.
 *
 * This broke in production: c337d25 reworded the Home Assistant entity error
 * from "does not exist. NEVER guess entity IDs" to "doesn't exist — don't guess
 * ids". The classifier regex matched "does not exist" but not the contraction,
 * so entity misses started burning the failure cap. Traces show the exact
 * consequence — the model followed the suggestion and was punished for it:
 *
 *   ha_get_state("climate.mini_split")               -> error, lists real ids
 *   ha_get_state("climate.house_mini_split_mini_split") -> "has been disabled"
 *   ha_get_state("climate.shop_mini_split_mini_split")  -> "has been disabled"
 *
 * These assertions use VERBATIM message text from the trace corpus and from
 * skills/core/home-assistant/handler.ts. If you reword an error, this test
 * fails and you update both together — that is the point.
 */
import { classifyToolError } from '../lib/tool-error-classification';

/** Recoverable = must NOT count toward the per-tool failure cap. */
const recoverable = (e: string, tool = 'ha_get_state') =>
  classifyToolError(tool, e).recoverable;

describe('recoverable error classification', () => {
  describe('Home Assistant entity misses (verbatim from traces)', () => {
    const cases = [
      'Entity "climate.mini_split" doesn\'t exist — don\'t guess ids. Real climate entities on THIS system: climate.house_mini_split_mini_split ("mini split"), climate.shop_mini_split_mini_split ("mini split")',
      'Entity "sensor.solar_panel_power" doesn\'t exist — don\'t guess ids. Real sensor entities on THIS system: sensor.solarassistant_2_battery_power ("SolarAssistant Data Battery power")',
      'Entity "sensor.battery_level" doesn\'t exist — don\'t guess ids. Real sensor entities on THIS system: sensor.sm_g988u1_battery_state ("SM-G988U1 Battery state")',
    ];
    test.each(cases)('is recoverable: %s', (err) => {
      expect(recoverable(err)).toBe(true);
    });
  });

  test('the pre-c337d25 wording is still recoverable (do not regress the old form)', () => {
    expect(recoverable(
      'Entity "climate.mini_split" does not exist. NEVER guess entity IDs — use ha_list_entities(domain="climate") to discover actual entity IDs on this system.',
    )).toBe(true);
  });

  test('camera lookup that lists the real cameras is recoverable', () => {
    expect(recoverable(
      'No camera matches "camera.genesis_north". Cameras on THIS system: camera.genesis_north_snapshots_clear ("Genesis north Snapshots clear"), camera.genesis_north_clear ("Genesis north Clear")',
    )).toBe(true);
  });

  test('unknown service that lists the real services is recoverable', () => {
    expect(recoverable(
      'Service "notify.mobile_app_donny_phone" does not exist on this Home Assistant instance. Real services in "notify" domain: send_message, persistent_notification, mobile_app_sm_g988u1, notify.',
    )).toBe(true);
  });

  test('file-not-found remains recoverable', () => {
    expect(recoverable(
      'ENOENT: no such file or directory, open \'/home/nuc1/choom-projects/freecad/view.png\'',
    )).toBe(true);
    expect(recoverable(
      'File not found: "choom_commons/trips/planning.md". The closest existing directory is "choom_commons/trips"',
    )).toBe(true);
  });

  describe('genuine failures must still count toward the cap', () => {
    const hard = [
      'Home Assistant error: HA API 500: 500 Internal Server Error',
      'Web search failed: Brave Search error: 422',
      'Image generation failed: fetch failed',
      'Python execution failed in FreeCAD',
      'Weather API error: 401 — OPENWEATHER_API_KEY is missing, invalid, or not yet active',
    ];
    test.each(hard)('is NOT treated as recoverable: %s', (err) => {
      expect(recoverable(err)).toBe(false);
    });
  });
});
