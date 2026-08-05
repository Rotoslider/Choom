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

/**
 * Fine-grained error classes (C-09). Before these existed, ~58% of all failed
 * calls aggregated in the doctor's report as an unactionable "other"
 * (other: 1298 across all reports) — which hid, among other things, the C-01
 * template crash entirely. Every string below is VERBATIM from data/traces.
 *
 * These classes refine the LABEL only. The paired behavior assertions pin that
 * refining a label never changes what counts toward the failure cap or blocks
 * a tool.
 */
describe('fine-grained error classes (C-09)', () => {
  const classOf = (e: string, tool = 'some_tool') =>
    classifyToolError(tool, e).errorClass;

  test.each([
    ['rate_limit', 'Web search failed: Brave Search error: 429'],
    ['upstream_5xx', 'Home Assistant error: HA API 500: 500 Internal Server Error\n\nServer got itself in trouble'],
    ['upstream_5xx', 'Music Assistant API error (500): Internal server error'],
    ['upstream_4xx', 'Weather fetch failed: Weather API error: 404'],
    ['upstream_4xx', 'Web search failed: Brave Search error: 422'],
    ['upstream_4xx', 'Failed read_document: Docs API error (404): {\n  "error": {\n    "code": 404,\n    "message": "Requested entity was not found.",\n    "status": "NOT_FOUND"\n  }\n}'],
    ['network', 'Vision analysis failed: fetch failed'],
    ['network', 'Delegation to "Genesis" — could not connect to chat API within 30s'],
    ['timeout', 'ForgeRAG request failed: The operation was aborted due to timeout'],
    ['auth', 'Weather API error: 401 — OPENWEATHER_API_KEY is missing, invalid, or not yet active'],
    ['auth', 'Calendar fetch failed: Calendar API error (403): Request had insufficient authentication scopes.'],
    ['template', "LLM API error 400: System message must be at the beginning. raise_exception('System message must be at the beginning.')"],
    ['permission_block', 'Blocked: choom_commons/ is a shared folder — never delete from it. If an entry is wrong, write a correction instead.'],
    ['permission_block', "Blocked: cannot write into another Choom's folder (selfies_optic/). Your folder is selfies_aloy/."],
    ['blocked_reissue', 'workspace_write_file has been disabled for this request because it failed repeatedly. Do NOT call workspace_write_file again. Tell the user what went wrong and suggest alternatives.'],
    ['blocked_reissue', 'STOP. You have already called get_delegation_result with these exact arguments 5 times in this request.'],
    ['blocked_reissue', 'Weather API error: 404 [This exact call already failed. Try a different approach or different arguments.]'],
  ] as const)('classifies as %s: %s', (expected, err) => {
    expect(classOf(err)).toBe(expected);
  });

  test('coarse classes are unchanged for errors that already had a name', () => {
    expect(classOf('GPU is busy with another generation')).toBe('gpu_busy');
    expect(classOf('workspace_write_file: path is required. Provide a relative file path')).toBe('param');
    expect(classOf("ENOENT: no such file or directory, open '/tmp/x.png'")).toBe('path');
    expect(classOf('Ollama is not configured for this Choom')).toBe('config');
  });

  test('relabeling must not change cap/blocking behavior', () => {
    // auth (was config's "unauthorized" bucket) still blocks immediately…
    expect(classifyToolError('t', 'Gmail API error: unauthorized').blockImmediately).toBe(true);
    // …but a 401 that never matched CONFIG_ERROR still does NOT block (it
    // counted toward the cap before, and must keep doing exactly that).
    const weather401 = classifyToolError('t',
      'Weather API error: 401 — OPENWEATHER_API_KEY is missing, invalid, or not yet active');
    expect(weather401.blockImmediately).toBe(false);
    expect(weather401.recoverable).toBe(false);
    // permission_block keeps its recoverable-never-counts semantics
    expect(classifyToolError('workspace_delete_file',
      'Blocked: sibling_journal/ is archived').recoverable).toBe(true);
  });

  test('"Memory not found" is NOT mislabeled as an upstream 404', () => {
    expect(classOf('Memory not found')).not.toBe('upstream_4xx');
  });
});
