import { BaseSkillHandler, type SkillHandlerContext } from '@/lib/skill-handler';
import { localFileStamp, localTimeString, localizeTimestamps, localTemplateTimes } from '@/lib/time-context';
import { HomeAssistantService, type HomeAssistantSettings, type HAEntity } from '@/lib/homeassistant-service';
import { WorkspaceService } from '@/lib/workspace-service';
import { WORKSPACE_ROOT } from '@/lib/config';
import prisma from '@/lib/db';
import { cameraSnapshotFolder, pruneExpiredCaptures, CAPTURE_RETENTION_HOURS } from '@/lib/captured-images';
import type { ToolCall, ToolResult } from '@/lib/types';
import { askGlassCamera, isGlassCameraName } from '@/lib/glass-camera';
import ImageAnalysisHandler from '@/skills/core/image-analysis/handler';

const TOOL_NAMES = new Set([
  'ha_get_state',
  'ha_list_entities',
  'ha_call_service',
  'ha_get_history',
  'ha_get_home_status',
  'ha_get_camera_snapshot',
  'ha_fire_event',
  'ha_render_template',
  'ha_list_services',
]);

/**
 * Coerce a service_data value into a plain object. Chooms sometimes pass it
 * as a YAML-ish string ("entity_id: camera.x") or a JSON string; HA rejects
 * both because the REST API requires an object body. Parse transparently.
 */
/**
 * Score real HA entities by similarity to a loose reference (token overlap on
 * entity_id + friendly_name). Returns ALL entities sorted best-first with their
 * score; original HA order breaks ties. The basis for both "did you mean…"
 * suggestions and confident auto-resolution.
 */
function scoreEntities(ref: string, entities: HAEntity[]): Array<{ e: HAEntity; score: number }> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = norm(ref).split(/\s+/).filter(t => t.length > 1);
  return entities
    .map((e, i) => {
      const hay = norm(`${e.entity_id} ${String(e.attributes?.friendly_name || '')}`);
      // Also against the name run together: "southeast" is
      // camera.outside_south_east_camera_snapshot (2026-10-27, 3 misses).
      const compact = hay.replace(/ /g, '');
      let score = 0;
      for (const t of tokens) if (hay.includes(t) || compact.includes(t)) score++;
      return { e, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ e, score }) => ({ e, score }));
}

/** Rank entities best-first; returns all unchanged when nothing matches (caller slices the head). */
function rankEntityMatches(guessed: string, entities: HAEntity[]): HAEntity[] {
  const scored = scoreEntities(guessed, entities);
  return scored.some(s => s.score > 0) ? scored.map(s => s.e) : entities;
}

/** Format an entity list compactly for a model-facing "pick one" message. */
function entityListText(entities: HAEntity[], max = 12): string {
  const head = entities.slice(0, max).map(e => {
    const fn = String(e.attributes?.friendly_name || '');
    return fn && fn !== e.entity_id ? `${e.entity_id} ("${fn}")` : e.entity_id;
  }).join(', ');
  return entities.length > max ? `${head}, …(+${entities.length - max} more)` : head;
}

/**
 * "Did you mean" across every domain. A guessed id with the wrong domain
 * (switch.kitchen1_sink_light; the real one is light.sink_light) used to get
 * only that domain's list back: 7 history and 6 logbook misses for Aloy in
 * five days (2026-10-25 → 29). Words few entities share count most, so
 * "sink" outranks "kitchen1" and "light".
 */
export function closestInAnyDomain(ref: string, entities: HAEntity[], max = 5): HAEntity[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const objectPart = ref.includes('.') ? ref.slice(ref.indexOf('.') + 1) : ref;
  const tokens = [...new Set(norm(objectPart).split(/\s+/).filter(t => t.length > 1))];
  if (!tokens.length) return [];
  const hays = entities.map(e => {
    const h = norm(`${e.entity_id} ${String(e.attributes?.friendly_name || '')}`);
    return { e, h, c: h.replace(/ /g, '') };
  });
  const has = (x: { h: string; c: string }, t: string) => x.h.includes(t) || x.c.includes(t);
  const df = new Map(tokens.map(t => [t, hays.filter(x => has(x, t)).length]));
  return hays
    .map(x => ({ e: x.e, score: tokens.reduce((s, t) => s + (has(x, t) ? 1 / (df.get(t) || 1) : 0), 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.e);
}

/**
 * Read tie-break: among equally good loose matches, the one whose name has the
 * fewest words beyond what was asked ("north door" and "north_door_contact" →
 * North Door, not North Screen door). Aloy and Genesis guessed the north
 * door's id on six different days (2026-10-18 → 29). Only for reads, where a
 * wrong pick shows in resolved_from and changes nothing; a wide tie (a vague
 * word) or a tie on extra words stays a list. The pick must also carry every
 * asked word that names something somewhere in the house: "sink" in
 * switch.kitchen1_sink_light points at light.sink_light, so no switch is
 * picked, while "contact" in north_door_contact names nothing and is let go.
 */
export function pickFewestExtraWords(ref: string, tied: HAEntity[], all: HAEntity[]): HAEntity | null {
  if (tied.length < 2 || tied.length > 4) return tied.length === 1 ? tied[0] : null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = (s: string) => new Set(norm(s).split(' ').filter(Boolean));
  const hay = (e: HAEntity) => { const h = norm(`${e.entity_id} ${String(e.attributes?.friendly_name || '')}`); return `${h} ${h.replace(/ /g, '')}`; };
  const asked = words(ref.includes('.') ? ref.slice(ref.indexOf('.') + 1) : ref);
  const extra = (e: HAEntity) =>
    [...words(String(e.attributes?.friendly_name || e.entity_id.split('.')[1] || ''))].filter(w => !asked.has(w)).length;
  const ranked = tied.map(e => ({ e, x: extra(e) })).sort((a, b) => a.x - b.x);
  if (ranked[0].x === ranked[1].x) return null;
  const pick = ranked[0].e;
  const pickHay = hay(pick);
  const unmet = [...asked].filter(w => w.length > 1 && !pickHay.includes(w));
  if (unmet.some(w => all.some(e => hay(e).includes(w)))) return null;
  return pick;
}

// What a state object has (light.entity_id, sensor.state in a loop over
// states.light): never entity ids.
const STATE_PROPERTIES = new Set(['entity_id', 'state', 'attributes', 'last_changed', 'last_updated', 'last_reported', 'name', 'object_id', 'domain', 'context']);

/**
 * Entity ids a template names that don't exist. Home Assistant renders them
 * as "unknown" (or None) without a word: Aloy's door sweep on 2026-10-29 read
 * the north door as "unknown" from a guessed id. Checks every domain.object
 * pair in a dotted chain, so states.binary_sensor.x.last_changed counts too.
 */
export function missingTemplateEntities(template: string, entities: HAEntity[]): string[] {
  const ids = new Set(entities.map(e => e.entity_id));
  const domains = new Set(entities.map(e => e.entity_id.split('.')[0]));
  const missing = new Set<string>();
  for (const chain of template.match(/[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+/g) || []) {
    const parts = chain.split('.');
    for (let i = 0; i + 1 < parts.length; i++) {
      if (!domains.has(parts[i]) || STATE_PROPERTIES.has(parts[i + 1])) continue;
      const id = `${parts[i]}.${parts[i + 1]}`;
      if (!ids.has(id)) missing.add(id);
      i++; // the object part can't start another pair
    }
  }
  return [...missing];
}

/** " These ids in your template don't exist…" with the closest real ones; empty when all exist. */
async function templateMissingNote(ha: HomeAssistantService, template: string, rendered: boolean): Promise<{ note: string; ids: string[] }> {
  try {
    const all = await ha.listStates();
    // The list can be trimmed (assistExposedOnly), so each id not on it is
    // asked for directly and called missing only on a 404: Eve's five real
    // occupancy sensors were all reported missing (2026-10-29, 21:05).
    const ids: string[] = [];
    for (const id of missingTemplateEntities(template, all).slice(0, 8)) {
      try {
        await ha.getState(id);
      } catch (e) {
        if (/HA API 404\b/.test(e instanceof Error ? e.message : String(e))) ids.push(id);
      }
    }
    if (!ids.length) return { note: '', ids };
    const each = ids.slice(0, 6).map(id => {
      const near = closestInAnyDomain(id, all, 3);
      return near.length ? `${id} (closest: ${entityListText(near, 3)})` : id;
    });
    return {
      ids,
      note: rendered
        ? ` These entity ids in your template don't exist, so Home Assistant read them as "unknown"/None — that is NOT the real state: ${each.join('; ')}. Use the exact ids.`
        : ` Also, these entity ids in your template don't exist: ${each.join('; ')}. Use the exact ids.`,
    };
  } catch {
    return { note: '', ids: [] };
  }
}

/**
 * An exact entity id that exists, asked for directly — or null. The list that
 * resolveEntity searches is trimmed to what Home Assistant exposes to Assist
 * (assistExposedOnly), so a real, unexposed id like Eve's occupancy sensors
 * read as missing, and a loose match could even have picked a different
 * entity (2026-10-29). ha_get_state already tried the id first; history,
 * logbook and camera snapshots do now too.
 */
async function exactEntity(ha: HomeAssistantService, ref: string): Promise<string | null> {
  if (!/^[a-z_]+\.[a-z0-9_]+$/i.test(ref)) return null;
  try {
    return (await ha.getState(ref)).entity_id;
  } catch {
    return null;
  }
}

/** The "doesn't exist" answer for a loose or guessed entity: the closest
 *  entities in any domain first, then the scoped list. Keeps the wording the
 *  loop reads as recoverable ("doesn't exist", "Real … entities on THIS system"). */
async function entityMissingText(
  ha: HomeAssistantService,
  ref: string,
  r: { candidates: HAEntity[]; domain: string },
  discover: string,
): Promise<string> {
  let closest = '';
  try {
    const near = closestInAnyDomain(ref, await ha.listStates());
    if (near.length) closest = ` Closest matches in any domain: ${entityListText(near, 5)}.`;
  } catch { /* best effort — the scoped list below still helps */ }
  return `Entity "${ref}" doesn't exist — don't guess ids.${closest}${r.candidates.length
    ? ` Real ${r.domain ? `${r.domain} ` : ''}entities on THIS system: ${entityListText(r.candidates)}. Use one of these exact ids.`
    : ` ${discover}`}`;
}

/**
 * Resolve a LOOSE entity reference ("garage", "mini split", "camera.garage") to a
 * real entity_id, scoped to a domain so the model never needs the whole HA table.
 * - exact id (case-insensitive)         → resolve
 * - exactly one confident fuzzy match   → resolve (so sane names just work)
 * - vague / zero / multiple matches     → return the scoped candidate list
 * Conservative on purpose: ties never auto-resolve (so an action can't actuate the
 * wrong device) — the caller surfaces the list and the model picks.
 */
async function resolveEntity(
  ha: HomeAssistantService,
  ref: string,
  domain?: string,
  tieBreak?: (tied: HAEntity[]) => HAEntity | null,
): Promise<{ entityId: string; resolvedFrom?: string } | { candidates: HAEntity[]; domain: string }> {
  const refTrim = (ref || '').trim();
  const dom = domain || (refTrim.includes('.') ? refTrim.split('.')[0] : undefined);
  const entities = await ha.listStates(dom);
  const exact = entities.find(e => e.entity_id.toLowerCase() === refTrim.toLowerCase());
  if (exact) return { entityId: exact.entity_id };
  if (!entities.length) return { candidates: [], domain: dom || '' };
  const scored = scoreEntities(refTrim, entities);
  const top = scored[0];
  const tied = scored.filter(s => s.score === top.score).map(s => s.e);
  if (top.score > 0 && tied.length === 1) return { entityId: top.e.entity_id, resolvedFrom: refTrim };
  if (top.score > 0 && tieBreak) {
    const pick = tieBreak(tied);
    if (pick) return { entityId: pick.entity_id, resolvedFrom: refTrim };
  }
  return { candidates: top.score > 0 ? scored.map(s => s.e) : entities, domain: dom || '' };
}

/**
 * Camera tie-break. One physical camera shows up in HA as several camera.*
 * entities — "Tower Camera Live Feed", "Tower Camera camera snapshot",
 * "Garage Camera snapshots clear" — so "tower" scores a dead heat between
 * them and the conservative resolver refused it: 8–16 "No camera matches
 * \"tower\"" errors per day in the nightly doctor (2026-09-15 → 09-19), every
 * one of them a wasted iteration on a name the tool description promised
 * would work. When every tied candidate is the SAME camera (identical name
 * once the stream-flavour words are stripped), prefer the live feed.
 * Different cameras still tie → still hand back the list.
 */
const CAMERA_FLAVOUR_WORDS = /\b(camera|cam|live|feed|stream|snapshot|snapshots|clear|fluent|main|sub|hd|sd|high|low)\b/g;
export function pickCameraAmongTies(tied: HAEntity[]): HAEntity | null {
  if (tied.length < 2) return tied[0] ?? null;
  const stem = (e: HAEntity) => {
    const raw = String(e.attributes?.friendly_name || e.entity_id.replace(/^camera\./, ''));
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(CAMERA_FLAVOUR_WORDS, ' ').replace(/\s+/g, ' ').trim();
  };
  const stems = new Set(tied.map(stem));
  if (stems.size !== 1) return null;
  const preference = [/live_feed|live/i, /main|clear|hd|high/i, /./];
  for (const re of preference) {
    const hit = tied.find(e => re.test(e.entity_id) || re.test(String(e.attributes?.friendly_name || '')));
    if (hit) return hit;
  }
  return tied[0];
}

/**
 * Find the PTZ/preset select entity that belongs to a given camera (so the model
 * can address presets by CAMERA, not by knowing the select.*_ptz id). Matches the
 * camera's name tokens against select.* entities that look like preset controls;
 * falls back to the sole preset select if there's only one. Returns its options too.
 */
async function findCameraPresetSelect(
  ha: HomeAssistantService,
  cameraEntityId: string,
): Promise<{ entity_id: string; options: string[] } | null> {
  try {
    const all = await ha.listStates();
    const selects = ptzSelects(all);
    if (!selects.length) return null;
    // The camera's own words, without the stream-flavour ones ("camera",
    // "snapshot", "clear"…) that every select shares: matched on those, the
    // shop camera got the garage camera's presets. All of them must match.
    const stem = cameraStem(cameraEntityId.replace(/^camera\./, ''));
    const words = stem.split(' ').filter(t => t.length > 1);
    const best = words.length ? scoreEntities(stem, selects)[0] : undefined;
    const chosen = best && best.score === words.length ? best.e : (selects.length === 1 ? selects[0] : null);
    if (!chosen) return null;
    return { entity_id: chosen.entity_id, options: presetOptions(chosen) };
  } catch {
    return null;
  }
}

/** A camera or select id's own words: "outside_south_east_camera_snapshot" → "outside south east". */
function cameraStem(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(CAMERA_FLAVOUR_WORDS, ' ')
    .replace(/\bptz\b|\bpreset\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Camera PTZ preset controls (select.*ptz*), not the lights' "light preset" selects. */
function ptzSelects(all: HAEntity[]): HAEntity[] {
  return all.filter(e => e.entity_id.startsWith('select.') && /ptz/i.test(e.entity_id));
}

function presetOptions(e: HAEntity): string[] {
  return Array.isArray(e.attributes?.options) ? (e.attributes.options as unknown[]).map(String) : [];
}

/** The camera a preset control belongs to (select.garage_camera_ptz_preset → the garage camera). */
function cameraForPresetSelect(selectId: string, cameras: HAEntity[]): HAEntity | null {
  const stem = cameraStem(selectId.replace(/^select\./, ''));
  const words = stem.split(' ').filter(t => t.length > 1);
  if (!words.length) return null;
  const scored = scoreEntities(stem, cameras).filter(s => s.score === words.length);
  return scored.length ? pickCameraAmongTies(scored.map(s => s.e)) : null;
}

/** " Preset controls on THIS system: select.x (a, b, …); …" for messages; empty when none. */
async function presetControlsText(ha: HomeAssistantService, maxOptions = 6): Promise<string> {
  try {
    const sel = ptzSelects(await ha.listStates());
    if (!sel.length) return '';
    return ` Preset controls on THIS system: ${sel.map(e => {
      const o = presetOptions(e);
      return `${e.entity_id} (${o.slice(0, maxOptions).join(', ')}${o.length > maxOptions ? ', …' : ''})`;
    }).join('; ')}.`;
  } catch {
    return '';
  }
}

/**
 * The preset a loose request names: exact, then case- and punctuation-blind,
 * then a partial match only when it is the sole one ("north side" →
 * "house north side"; "driveway gate" stays unmatched between "Driveway" and
 * "gate").
 */
export function matchPresetOption(requested: string, options: string[]): string | null {
  const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const want = norm(requested);
  if (!want) return null;
  const exact = options.find(o => o === requested) || options.find(o => norm(o) === want);
  if (exact) return exact;
  const partial = options.filter(o => norm(o) && (norm(o).includes(want) || want.includes(norm(o))));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Cameras that see only darkness while their room is shut, still and unlit.
 * The shop camera is black whenever the shop door is closed (Donny,
 * 2026-10-29), and Aloy's watch shot and analyzed it every hour anyway. The
 * shop's PIR is the motion test: its mmWave also sees the bushes moving
 * outside. The light level only lets a lit shop (lights left on) be shot.
 */
export const DARK_WHEN_SHUT: Record<string, { place: string; door: string; motion: string; light?: string }> = {
  'camera.shop_camera': {
    place: 'shop',
    door: 'binary_sensor.shop_shop_door_sensor_shop_door',
    motion: 'binary_sensor.shop_prox_sensor_shop_pir',
    light: 'sensor.shop_prox_sensor_shop_illuminance',
  },
};
const DARK_LUX = 10;

/** Why a picture from this camera would be pointless right now (its room is
 *  shut, still and dark), or null to take it — also whenever a sensor can't
 *  be read. */
export async function shutStillAndDark(
  ha: HomeAssistantService,
  cameraId: string,
): Promise<{ place: string; doorSince: string; stillSince: string; lux: number | null } | null> {
  const rule = DARK_WHEN_SHUT[cameraId];
  if (!rule) return null;
  try {
    const [door, motion, light] = await Promise.all([
      ha.getState(rule.door),
      ha.getState(rule.motion),
      rule.light ? ha.getState(rule.light).catch(() => null) : Promise.resolve(null),
    ]);
    if (door.state !== 'off' || motion.state !== 'off') return null;
    const lux = light ? Number(light.state) : NaN;
    if (Number.isFinite(lux) && lux >= DARK_LUX) return null;
    const when = (iso: string) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? 'a while' : localTimeString(d);
    };
    return { place: rule.place, doorSince: when(door.last_changed), stillSince: when(motion.last_changed), lux: Number.isFinite(lux) ? lux : null };
  } catch {
    return null;
  }
}

/** Cameras that have a preset by this name, for a "driveway" asked for as a camera. */
function camerasWithPreset(requested: string, all: HAEntity[]): Array<{ camera: string; preset: string }> {
  const cameras = all.filter(e => e.entity_id.startsWith('camera.'));
  return ptzSelects(all).flatMap(sel => {
    const preset = matchPresetOption(requested, presetOptions(sel));
    const cam = preset ? cameraForPresetSelect(sel.entity_id, cameras) : null;
    return preset && cam ? [{ camera: cam.entity_id, preset }] : [];
  });
}

function coerceServiceData(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Try JSON first.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  // Try YAML-ish "key: value" per line (no nested structures).
  const obj: Record<string, unknown> = {};
  let parsedAny = false;
  for (const line of trimmed.split(/\r?\n|,\s*/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (m) {
      const [, k, v] = m;
      let value: unknown = v;
      if (v === 'true') value = true;
      else if (v === 'false') value = false;
      else if (/^-?\d+$/.test(v)) value = Number(v);
      else if (/^-?\d*\.\d+$/.test(v)) value = Number(v);
      else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) value = v.slice(1, -1);
      obj[k] = value;
      parsedAny = true;
    }
  }
  return parsedAny ? obj : undefined;
}

const WORKSPACE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const MAX_SNAPSHOT_KB = 10 * 1024; // 10MB

export default class HomeAssistantHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  // Home Assistant gives every time in UTC (state changes, history, the
  // logbook, timestamp sensors like the rain gauge's last rain); she gets
  // them in local time, the way she says them to Donny.
  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const r = await this.run(toolCall, ctx);
    return r.result == null ? r : { ...r, result: localizeTimestamps(r.result) };
  }

  private async run(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    const haSettings = (ctx.settings as Record<string, unknown>)?.homeAssistant as HomeAssistantSettings | undefined;

    if (!haSettings?.baseUrl || !haSettings?.accessToken) {
      return this.error(toolCall, 'Home Assistant is not configured. Please set the URL and access token in Settings > Smart Home.');
    }

    const ha = new HomeAssistantService(haSettings);
    const args = toolCall.arguments || {};

    try {
      switch (toolCall.name) {
        case 'ha_get_state': {
          const ref = args.entity_id as string;
          if (!ref) return this.error(toolCall, 'entity_id is required');

          // Accept loose references ("garage", "mini split") — try the exact id
          // first (fast path, exact ids cost one call), and only on a 404 fall
          // back to scoped resolution: confident match → use it; else hand back
          // the domain's real entities so she picks instead of guessing again.
          let entity: HAEntity;
          let resolvedFrom = '';
          try {
            entity = await ha.getState(ref);
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            if (!/HA API 404\b/.test(m)) throw e;
            const everyEntity = await ha.listStates();
            const r = await resolveEntity(ha, ref, undefined, tied => pickFewestExtraWords(ref, tied, everyEntity));
            if ('entityId' in r) {
              entity = await ha.getState(r.entityId);
              resolvedFrom = ref;
            } else {
              return this.error(
                toolCall,
                await entityMissingText(ha, ref, r, `Call ha_list_entities(${r.domain ? `domain="${r.domain}"` : ''}) to discover them.`),
              );
            }
          }
          const entityId = entity.entity_id;
          const name = String(entity.attributes.friendly_name || entityId);
          const unit = String(entity.attributes.unit_of_measurement || '');
          const stateStr = unit ? `${entity.state} ${unit}` : entity.state;

          // Pick useful attributes to return (skip internal ones)
          const relevantAttrs: Record<string, unknown> = {};
          const skipKeys = new Set(['friendly_name', 'unit_of_measurement', 'icon', 'entity_picture', 'supported_features', 'attribution']);
          for (const [k, v] of Object.entries(entity.attributes)) {
            if (!skipKeys.has(k)) relevantAttrs[k] = v;
          }

          return this.success(toolCall, {
            entity_id: entityId,
            ...(resolvedFrom && { resolved_from: resolvedFrom }),
            friendly_name: name,
            state: stateStr,
            raw_state: entity.state,
            attributes: relevantAttrs,
            last_changed: entity.last_changed,
          });
        }

        case 'ha_list_entities': {
          const domain = args.domain as string | undefined;
          const area = args.area as string | undefined;
          const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : '';
          const entities = await ha.listStates(domain, area);

          // Bounded (2026-09-12): domain="sensor" on this homestead is 722
          // entities and came back as ~100k chars — the last uncapped result.
          // `search` narrows by name/id; past the cap the model is told how many
          // more there are and how to narrow.
          const LIST_CAP = 60;
          const matched = search
            ? entities.filter(e => e.entity_id.toLowerCase().includes(search) || String(e.attributes.friendly_name || '').toLowerCase().includes(search))
            : entities;
          const list = matched.slice(0, LIST_CAP).map(e => ({
            entity_id: e.entity_id,
            friendly_name: String(e.attributes.friendly_name || e.entity_id),
            state: e.state,
            domain: e.entity_id.split('.')[0],
          }));

          return this.success(toolCall, {
            count: matched.length,
            entities: list,
            ...(matched.length > list.length && {
              more: matched.length - list.length,
              note: `${matched.length - list.length} more not shown. Narrow with search="<word in the name>" (e.g. "solar", "garage") or a more specific domain.`,
            }),
            ...(domain && { filtered_by_domain: domain }),
            ...(area && { filtered_by_area: area }),
            ...(search && { filtered_by_search: search }),
          });
        }

        case 'ha_call_service': {
          const domain = args.domain as string;
          const service = args.service as string;
          let entityId = args.entity_id as string | undefined;
          const serviceData = coerceServiceData(args.service_data);
          // target has the same "should be an object, often arrives as YAML-ish string"
          // problem as service_data. Reuse the same coercion.
          const target = coerceServiceData(args.target) as
            | { entity_id?: string | string[]; area_id?: string | string[]; device_id?: string | string[] }
            | undefined;

          if (!domain || !service) {
            return this.error(toolCall, 'domain and service are required');
          }

          // HA's own YAML puts the entity inside the data ({entity_id, option});
          // take it from there, so the preset matching and settle wait below see it.
          if (!entityId && typeof serviceData?.entity_id === 'string' && serviceData.entity_id) {
            entityId = serviceData.entity_id;
            delete serviceData.entity_id;
          }

          // Specific entity_id-missing catch for entity-scoped services. Chooms often
          // forget to specify which entity to act on, sending {service, service_data,
          // domain} only. HA responds with a bare 400 which our generic diagnostic
          // can't disambiguate from real shape errors. Detect this pre-dispatch.
          // The answer must start "entity_id is required" (a param error to the
          // loop): the older "requires you to specify WHICH entity" counted as a
          // hard failure, disabled ha_call_service after two, and Aloy and Genesis
          // re-issued it 56 times into the block (2026-10-25 → 29), most of them
          // select_option calls that arrived as just {domain, service}.
          const hasAnyEntityTarget = Boolean(
            entityId
            || (target && (target.entity_id || target.area_id || target.device_id))
          );
          const ENTITY_SCOPED_SERVICES = /^(select|light|switch|fan|cover|climate|button|media_player|lock|input_boolean|input_select|input_number|input_text|input_datetime|scene|automation|script)\./;
          if (!hasAnyEntityTarget && ENTITY_SCOPED_SERVICES.test(`${domain}.${service}`)) {
            if (domain === 'select' && service === 'select_option') {
              return this.error(
                toolCall,
                `entity_id is required: select.select_option moves ONE preset control, and this call named none (no entity_id or target). ` +
                `To aim a camera at a preset AND take the picture in one step, call ha_get_camera_snapshot(entity_id="<camera>", preset="<preset>") — it moves the camera, waits for it to settle, then shoots.` +
                `${await presetControlsText(ha)}`
              );
            }
            return this.error(
              toolCall,
              `entity_id is required: "${domain}.${service}" acts on one entity, and this call named none (no entity_id or target). ` +
              `Add entity_id="<entity>" at the top level, or target={"entity_id":"<entity>"}. ` +
              `Example: ha_call_service(domain="${domain}", service="${service}", entity_id="<your entity>"${serviceData ? `, service_data=${JSON.stringify(serviceData)}` : ''}).`
            );
          }

          // Modern tts.speak uses entity_id = the tts.* service entity, and the speaker
          // goes in media_player_entity_id. The legacy mental model (entity_id = speaker)
          // returns a bare 400 from HA with no explanation, so catch it before dispatch.
          if (domain === 'tts' && service === 'speak') {
            const sdEntity = (serviceData as Record<string, unknown> | undefined)?.entity_id;
            const sdMediaPlayer = (serviceData as Record<string, unknown> | undefined)?.media_player_entity_id;
            const topEntity = entityId;
            const candidate = (typeof sdEntity === 'string' && sdEntity) || topEntity || '';
            if (candidate.startsWith('media_player.') && !sdMediaPlayer) {
              return this.error(
                toolCall,
                `tts.speak uses entity_id = the TTS service entity (tts.*), not the speaker. ` +
                `Find available TTS entities with ha_list_entities(domain="tts"), then call: ` +
                `ha_call_service(domain="tts", service="speak", service_data={"entity_id":"tts.<provider>", "media_player_entity_id":"${candidate}", "message":"..."}). ` +
                `Alternative: if the speaker supports media_player.play_media, use that directly.`
              );
            }
          }

          // Pre-validate the service exists in the HA catalog. Chooms repeatedly
          // hallucinate services like camera.ptz_preset, onvif.ptz_preset,
          // ptz.list_presets — none exist. Instead of letting HA return a bare 400,
          // tell the Choom authoritatively what's available, and if this looks like a
          // PTZ-preset attempt, point at the actual select entity.
          {
            const existence = await ha.verifyServiceExists(domain, service);
            if (existence !== true) {
              // Build the PTZ hint once — applies whether the domain or the specific
              // service is unknown, since both patterns show up for hallucinated PTZ calls.
              const looksLikePtz = /ptz|preset/i.test(service)
                || /ptz|preset/i.test(domain)
                || domain === 'onvif'
                || (domain === 'camera' && /move|goto|tilt|pan|zoom/i.test(service));
              let ptzHint = '';
              if (looksLikePtz) {
                try {
                  const all = await ha.listStates();
                  const selectors = all
                    .filter(e => e.entity_id.startsWith('select.') && /ptz|preset/i.test(e.entity_id))
                    .map(e => {
                      const opts = Array.isArray(e.attributes?.options) ? (e.attributes.options as string[]) : [];
                      return { entity_id: e.entity_id, options: opts.slice(0, 12), truncated: opts.length > 12 };
                    });
                  const buttons = all
                    .filter(e => e.entity_id.startsWith('button.') && /preset|ptz/i.test(e.entity_id))
                    .slice(0, 8)
                    .map(e => e.entity_id);

                  // Return as a SUCCESS redirect so the agentic loop doesn't block
                  // ha_call_service — the tool isn't broken, the LLM just used the
                  // wrong domain/service. Returning an error causes brokenTools to
                  // fire after 2 attempts, permanently blocking camera control.
                  if (selectors.length > 0) {
                    console.log(`   🔀 PTZ redirect: ${domain}.${service} → discovered ${selectors.length} select entities`);
                    return this.success(toolCall, {
                      redirected: true,
                      message: `"${domain}.${service}" does not exist. HA does NOT have generic PTZ services. Presets are exposed as select entities.`,
                      ptz_entities: selectors.map(s =>
                        `${s.entity_id} (options: ${s.options.join(', ')}${s.truncated ? '…' : ''})`
                      ),
                      correct_call: `ha_call_service(domain="select", service="select_option", entity_id="${selectors[0].entity_id}", service_data={"option":"${selectors[0].options[0] || '<preset name>'}"})`,
                      note: 'Call ha_call_service with domain="select" and service="select_option". The handler auto-waits for the camera to physically move before returning.',
                    });
                  } else if (buttons.length > 0) {
                    console.log(`   🔀 PTZ redirect: ${domain}.${service} → discovered ${buttons.length} button entities`);
                    return this.success(toolCall, {
                      redirected: true,
                      message: `"${domain}.${service}" does not exist. HA does NOT have generic PTZ services. This system has preset button entities.`,
                      preset_buttons: buttons,
                      correct_call: `ha_call_service(domain="button", service="press", entity_id="${buttons[0]}")`,
                      note: 'Press a preset button to move the camera, then call ha_get_camera_snapshot.',
                    });
                  } else {
                    ptzHint = `\n\nHA does NOT have generic PTZ services — search for select.*ptz* or button.*preset* entities via ha_list_entities() (no domain filter) to find the real preset controls.`;
                  }
                } catch { /* state fetch failed — skip hint */ }
              }
              if (existence === null) {
                return this.error(
                  toolCall,
                  `Domain "${domain}" has no registered services on this Home Assistant instance. ` +
                  `You invented this domain. Run ha_list_services() with no arguments to see real domains, or ha_list_entities(domain="${domain}") to confirm whether the domain name even exists.${ptzHint}`
                );
              }
              const siblings = existence.siblings.slice(0, 20).join(', ');
              const more = existence.siblings.length > 20 ? ` (+${existence.siblings.length - 20} more)` : '';
              return this.error(
                toolCall,
                `Service "${domain}.${service}" does not exist on this Home Assistant instance. ` +
                `Real services in "${domain}" domain: ${siblings}${more}.${ptzHint}`
              );
            }
          }

          // camera.snapshot writes into HA's container filesystem (behind allowlist_external_dirs)
          // and the file is unreachable from our workspace. Redirect to the dedicated tool.
          if (domain === 'camera' && service === 'snapshot') {
            const hint = entityId || (typeof target?.entity_id === 'string' ? target.entity_id : 'camera.<name>');
            return this.error(
              toolCall,
              `camera.snapshot writes to HA's internal filesystem and is unreachable from your workspace. ` +
              `Instead, call ha_get_camera_snapshot(entity_id="${hint}") — one call, returns a workspace path ` +
              `usable with analyze_image, send_notification(file_paths=[...]), or inline chat display.`
            );
          }

          // Case-insensitive option matching for select.select_option. Chooms often
          // pass lowercase "driveway" when the real preset is "Driveway" — HA rejects
          // case mismatches with a bare 400. Auto-correct against attributes.options.
          let selectTargetEntity = entityId
            || (typeof target?.entity_id === 'string' ? target.entity_id : undefined);
          // Camera-centric presets: if she aimed select_option at a CAMERA (or a
          // loose name that isn't a select.* entity), map it to that camera's preset
          // select so she can address presets by camera without knowing the
          // select.*_ptz id. (The option-matching/validation below then runs as normal.)
          if (domain === 'select' && service === 'select_option' && selectTargetEntity
              && !selectTargetEntity.startsWith('select.')) {
            const mapped = selectTargetEntity.startsWith('camera.')
              ? (await findCameraPresetSelect(ha, selectTargetEntity))?.entity_id
              : await (async () => {
                  const r = await resolveEntity(ha, selectTargetEntity!, 'select');
                  return 'entityId' in r ? r.entityId : undefined;
                })();
            if (mapped && mapped !== selectTargetEntity) {
              console.log(`   🔀 select_option entity remapped: "${selectTargetEntity}" → ${mapped}`);
              if (typeof target?.entity_id === 'string') target.entity_id = mapped;
              else entityId = mapped;
              selectTargetEntity = mapped;
            }
          }
          if (domain === 'select' && service === 'select_option' && serviceData?.option && selectTargetEntity) {
            try {
              const state = await ha.getState(selectTargetEntity);
              const options = state.attributes?.options as string[] | undefined;
              const requested = String(serviceData.option);
              if (Array.isArray(options) && !options.includes(requested)) {
                // Normalize for loose matching: lowercase, collapse all non-alphanumerics.
                const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
                const ciMatch = options.find(o => String(o).toLowerCase() === requested.toLowerCase())
                  || options.find(o => norm(o) === norm(requested));
                if (ciMatch) {
                  console.log(`   🔀 select_option matched: "${requested}" → "${ciMatch}"`);
                  serviceData.option = ciMatch;
                } else {
                  // Option does not exist on THIS entity. Reolink/HA returns a cryptic
                  // 500 (not a 400) for invalid select options, which then trips the
                  // brokenTools blocker and disables ha_call_service for the whole turn.
                  // Intercept here: find which sibling select.*_ptz/preset entity DOES
                  // have this option (Chooms routinely mix up the tower vs garage cam
                  // preset lists) and return a SUCCESS redirect so the tool stays alive.
                  let siblingHint: { entity_id: string; option: string } | undefined;
                  try {
                    const all = await ha.listStates();
                    for (const e of all) {
                      if (e.entity_id === selectTargetEntity) continue;
                      if (!e.entity_id.startsWith('select.') || !/ptz|preset/i.test(e.entity_id)) continue;
                      const opts = Array.isArray(e.attributes?.options) ? (e.attributes.options as string[]) : [];
                      const m = opts.find(o => norm(o) === norm(requested));
                      if (m) { siblingHint = { entity_id: e.entity_id, option: m }; break; }
                    }
                  } catch { /* sibling scan is best-effort */ }
                  console.log(`   ⚠️  select_option invalid: "${requested}" not on ${selectTargetEntity}${siblingHint ? ` — found on ${siblingHint.entity_id}` : ''}`);
                  return this.success(toolCall, {
                    redirected: true,
                    success: false,
                    message: `"${requested}" is not a valid preset for ${selectTargetEntity}. The camera did NOT move. (HA returns a 500 for invalid options, which is why earlier calls failed.)`,
                    valid_options: options,
                    ...(siblingHint && {
                      hint: `"${siblingHint.option}" is a preset on a DIFFERENT camera: ${siblingHint.entity_id}. Each camera has its own preset list — don't mix them up.`,
                      correct_call: `ha_call_service(domain="select", service="select_option", entity_id="${siblingHint.entity_id}", service_data={"option":"${siblingHint.option}"})`,
                    }),
                    ...(!siblingHint && {
                      correct_call: `ha_call_service(domain="select", service="select_option", entity_id="${selectTargetEntity}", service_data={"option":"${options[0]}"})`,
                    }),
                  });
                }
              }
            } catch { /* entity fetch failed — let HA report the error */ }
          }

          // settle_seconds is our own override, not a real HA field — strip before dispatch.
          let settleOverride: number | undefined;
          if (serviceData && 'settle_seconds' in serviceData) {
            const v = Number(serviceData.settle_seconds);
            if (Number.isFinite(v)) settleOverride = Math.max(1, Math.min(20, v));
            delete serviceData.settle_seconds;
          }

          const result = await ha.callService(domain, service, entityId, serviceData, target);

          // A PTZ move (preset SELECT or preset BUTTON) is mechanical AND the lens
          // autofocuses after it stops — snapshotting too soon yields a blurry or
          // stale frame. Block here for a settle window so the NEXT
          // ha_get_camera_snapshot is sharp. Default 10s covers a full pan + refocus
          // on typical home PTZ cams (6s was enough for the move but not the focus);
          // override via service_data.settle_seconds (clamped 1-20) for small moves
          // or slow lenses.
          const isPtzPreset = domain === 'select' && service === 'select_option'
            && (selectTargetEntity?.includes('ptz') || selectTargetEntity?.includes('preset'));
          const pressedEntity = entityId || (typeof target?.entity_id === 'string' ? target.entity_id : undefined);
          const isPresetButton = domain === 'button' && service === 'press'
            && !!pressedEntity && /(ptz|preset)/i.test(pressedEntity);
          const didMoveCamera = isPtzPreset || isPresetButton;
          const settleSeconds = settleOverride !== undefined ? settleOverride : 10;
          if (didMoveCamera) {
            await new Promise(resolve => setTimeout(resolve, settleSeconds * 1000));
          }

          // Best-effort state reporting for single-entity calls.
          if (entityId) {
            const updatedEntity = result.find(e => e.entity_id === entityId);
            const newState = updatedEntity?.state || 'unknown';
            const name = updatedEntity ? String(updatedEntity.attributes.friendly_name || entityId) : entityId;
            // PTZ preset selects are WRITE-ONLY on Reolink/HA: the command moves
            // the camera, but HA never reads the active preset back, so the
            // entity state stays "unknown". Reporting "unknown" makes Chooms
            // think the move failed and retry. Echo the option we just set as the
            // confirmed position and explain the quirk so they stop second-guessing.
            if (isPtzPreset && (newState === 'unknown' || newState === 'unavailable')) {
              const requested = serviceData?.option ? String(serviceData.option) : undefined;
              return this.success(toolCall, {
                success: true,
                entity_id: entityId,
                friendly_name: name,
                service_called: `${domain}.${service}`,
                moved_to: requested,
                new_state: requested ?? newState,
                note: `Camera moved to "${requested}" and I waited ${settleSeconds}s for it to settle and refocus. The select entity reports state "unknown" because Reolink/HA does not read the active preset back — this is NORMAL and does NOT mean the move failed. Do not re-select or call ha_get_state to "confirm"; trust this success. Now call ha_get_camera_snapshot for a sharp frame — and next time ha_get_camera_snapshot(entity_id=..., preset="${requested ?? '<preset>'}") does the move and the picture in one call.`,
              });
            }
            return this.success(toolCall, {
              success: true,
              entity_id: entityId,
              friendly_name: name,
              service_called: `${domain}.${service}`,
              new_state: newState,
            });
          }

          return this.success(toolCall, {
            success: true,
            service_called: `${domain}.${service}`,
            ...(target && { target }),
            affected_count: result.length,
            note: didMoveCamera
              ? `Camera preset selected. Waited ${settleSeconds}s for the camera to finish moving AND refocus — now safe to call ha_get_camera_snapshot for a sharp frame. If a snapshot still looks blurry or shows the old view, the move/focus took longer; redo this call with service_data={..., "settle_seconds":15} (max 20), or pass settle_seconds to ha_get_camera_snapshot itself.`
              : result.length === 0
                ? 'Service call succeeded. No entity states returned (typical for global/fire-and-forget services like notify.*, tts.speak, scene.create, automation.trigger).'
                : `Service call succeeded. ${result.length} entity state(s) updated.`,
          });
        }

        case 'ha_list_services': {
          const domainFilter = args.domain as string | undefined;
          const services = await ha.listServices(domainFilter);
          // Summarize — raw /api/services output is enormous. Keep service names and
          // a short field summary; drop the full field schemas unless they're short.
          const summary: Record<string, Record<string, { description?: string; required_fields?: string[] }>> = {};
          for (const [dom, svcMap] of Object.entries(services)) {
            summary[dom] = {};
            for (const [svcName, svcSpec] of Object.entries(svcMap as Record<string, Record<string, unknown>>)) {
              const desc = typeof svcSpec.description === 'string' ? svcSpec.description.slice(0, 120) : undefined;
              const fields = svcSpec.fields as Record<string, { required?: boolean }> | undefined;
              const required = fields
                ? Object.entries(fields).filter(([, f]) => f?.required).map(([k]) => k)
                : [];
              summary[dom][svcName] = {
                ...(desc && { description: desc }),
                ...(required.length > 0 && { required_fields: required }),
              };
            }
          }
          return this.success(toolCall, {
            success: true,
            ...(domainFilter && { domain: domainFilter }),
            domain_count: Object.keys(summary).length,
            services: summary,
          });
        }

        case 'ha_fire_event': {
          const eventType = args.event_type as string;
          if (!eventType) return this.error(toolCall, 'event_type is required');
          const eventData = args.event_data as Record<string, unknown> | undefined;
          const result = await ha.fireEvent(eventType, eventData);
          return this.success(toolCall, {
            success: true,
            event_type: eventType,
            message: result.message || `Fired event ${eventType}`,
          });
        }

        case 'ha_render_template': {
          const template = args.template as string;
          if (!template) return this.error(toolCall, 'template is required');
          // Change times in local time. as_local of a missing entity's time is
          // an error where printing it gives nothing, so a template the change
          // breaks runs as she wrote it.
          const local = localTemplateTimes(template);
          let rendered: string;
          try {
            try {
              rendered = await ha.renderTemplate(local);
            } catch (err) {
              if (local === template) throw err;
              rendered = await ha.renderTemplate(template);
            }
          } catch (err) {
            // A guessed id is the usual cause of "'None' has no attribute…":
            // name it ("doesn't exist" also marks the error as recoverable).
            const missing = await templateMissingNote(ha, template, false);
            if (!missing.note) throw err;
            return this.error(toolCall, `Home Assistant error: ${err instanceof Error ? err.message : String(err)}.${missing.note}`);
          }
          const missing = await templateMissingNote(ha, template, true);
          // A template can loop over every sensor in the house — Qwen wrote one
          // that rendered 30k chars (2026-09-12). Bound it like every other
          // result; the note tells her how to get the rest.
          const RENDER_CAP = 8000;
          let renderTruncated = false;
          if (rendered.length > RENDER_CAP) {
            rendered = rendered.slice(0, RENDER_CAP);
            renderTruncated = true;
          }
          // Attempt JSON parse so structured results aren't dumped as raw strings.
          let parsed: unknown = rendered;
          try {
            parsed = JSON.parse(rendered);
          } catch {
            /* not JSON — return raw string */
          }
          return this.success(toolCall, {
            success: true,
            rendered: parsed,
            ...(missing.note && { missing_entities: missing.ids, warning: missing.note.trim() }),
            ...(renderTruncated && { truncated: true, note: `Output cut at ${RENDER_CAP} chars. Narrow the template (filter by name/domain, or render a few entities at a time).` }),
            ...(typeof parsed === 'string' && parsed !== rendered && { raw: rendered }),
          });
        }

        case 'ha_get_history': {
          const histRef = String(args.entity_id ?? args.entity ?? args.name ?? '').trim();
          if (!histRef) return this.error(toolCall, 'entity_id is required — the entity to chart, e.g. entity_id="sensor.outdoor_temperature" or a loose name like "outdoor temperature". Call ha_get_home_status to see what exists.');
          const everyEntity = await ha.listStates();
          const histExact = await exactEntity(ha, histRef);
          const histResolved = histExact ? { entityId: histExact } : await resolveEntity(ha, histRef, undefined, tied => pickFewestExtraWords(histRef, tied, everyEntity));
          if (!('entityId' in histResolved)) {
            return this.error(toolCall, await entityMissingText(ha, histRef, histResolved, 'Call ha_get_home_status to discover them.'));
          }
          const entityId = histResolved.entityId;

          const hours = Math.min(Math.max(Number(args.hours) || 24, 1), 168);
          const summary = await ha.getHistory(entityId, hours);

          return this.success(toolCall, {
            entity_id: summary.entity_id,
            friendly_name: summary.friendly_name,
            period: `${hours} hours`,
            ...(summary.samples === 0 && {
              note: `No history data recorded for ${entityId} in the last ${hours} hours`,
            }),
            ...(summary.min !== null && {
              min: `${summary.min}${summary.unit}`,
              max: `${summary.max}${summary.unit}`,
              avg: `${summary.avg}${summary.unit}`,
            }),
            trend: summary.trend,
            samples: summary.samples,
            first_value: summary.first,
            last_value: summary.last,
            ...(summary.changes && summary.changes.length > 0 && {
              changes: summary.changes,
            }),
          });
        }

        case 'ha_get_logbook': {
          // "entity_id is required" was a blank wall in the doctor report
          // (2026-09-19): it named the parameter and nothing else. Say what
          // goes in it, take the synonyms, and resolve loose names the way
          // ha_get_state does so "front door" works without a second call.
          const logRef = String(args.entity_id ?? args.entity ?? args.name ?? '').trim();
          if (!logRef) return this.error(toolCall, 'entity_id is required — the entity whose activity you want, e.g. entity_id="binary_sensor.front_door" or a loose name like "front door". Call ha_get_home_status to see what exists.');
          const everyEntity = await ha.listStates();
          const logExact = await exactEntity(ha, logRef);
          const logResolved = logExact ? { entityId: logExact } : await resolveEntity(ha, logRef, undefined, tied => pickFewestExtraWords(logRef, tied, everyEntity));
          if (!('entityId' in logResolved)) {
            return this.error(toolCall, await entityMissingText(ha, logRef, logResolved, 'Call ha_get_home_status to discover them.'));
          }
          const entityId = logResolved.entityId;

          const hours = Math.min(Math.max(Number(args.hours) || 24, 1), 168);
          const entries = await ha.getLogbook(entityId, hours);

          if (entries.length === 0) {
            return this.success(toolCall, {
              entity_id: entityId,
              period: `${hours} hours`,
              entries: [],
              note: `No logbook entries for ${entityId} in the last ${hours} hours`,
            });
          }

          return this.success(toolCall, {
            entity_id: entityId,
            period: `${hours} hours`,
            total_entries: entries.length,
            entries: entries.map(e => ({
              time: e.when,
              ...(e.state && { state: e.state }),
              ...(e.message && { message: e.message }),
            })),
          });
        }

        case 'ha_get_home_status': {
          const includeOff = args.include_off === true;
          const wantDetail = args.detail === true || includeOff;
          const focus = typeof args.focus === 'string' ? args.focus.trim() : '';
          const domainFilter = typeof args.domain === 'string' ? args.domain.trim().toLowerCase() : '';

          // Compact by default (Phase 1, 2026-09-12). The full dump of this
          // homestead is ~1,000 entities and 51k chars (~13k tokens) — the
          // single largest tool result in the system, and the one called on
          // nearly every grounding turn. The compact view is what a person
          // glancing at the house would notice; `focus`, `domain` and `detail`
          // open the rest one call at a time.
          if (!wantDetail && !focus && !domainFilter) {
            return this.success(toolCall, await ha.getCompactHomeStatus());
          }

          const groups = await ha.getHomeSummary(includeOff);
          const focusLower = focus.toLowerCase();
          // Even the "full" views are bounded. detail=true with no domain used
          // to return every entity (90k chars with include_off on 2026-09-12 —
          // DeepSeek reached for it to answer "is anything left on", which the
          // compact glance already answers). A domain or focus view shows up to
          // PER_VIEW_CAP entities; the unfiltered dump shows PER_DOMAIN_CAP per
          // domain and says how many more there are.
          const PER_DOMAIN_CAP = domainFilter || focusLower ? 80 : 25;
          const formatted: Record<string, unknown> = {};
          let totalEntities = 0;
          let matched = 0;
          let omitted = 0;
          for (const [domain, entities] of Object.entries(groups)) {
            totalEntities += entities.length;
            if (domainFilter && domain !== domainFilter) continue;
            const kept = focusLower
              ? entities.filter(e => e.id.toLowerCase().includes(focusLower) || e.name.toLowerCase().includes(focusLower))
              : entities;
            if (kept.length === 0) continue;
            matched += kept.length;
            const shown = kept.slice(0, PER_DOMAIN_CAP).map(e => ({
              id: e.id,
              name: e.name,
              state: e.state,
              ...(e.extras && { details: e.extras }),
            }));
            if (kept.length > shown.length) {
              omitted += kept.length - shown.length;
              formatted[domain] = { shown, more: kept.length - shown.length };
            } else {
              formatted[domain] = shown;
            }
          }

          return this.success(toolCall, {
            total_entities: totalEntities,
            matched_entities: matched,
            ...(focus && { focus }),
            ...(domainFilter && { domain: domainFilter }),
            domains: formatted,
            include_off: includeOff,
            ...(omitted > 0 && {
              note: `${omitted} entities not shown. Narrow with domain="<domain>" or focus="<keyword>" to see a specific set.`,
            }),
          });
        }

        case 'ha_get_camera_snapshot': {
          const camRef = (args.entity_id as string) || (args.camera as string);
          if (!camRef) return this.error(toolCall, 'entity_id is required — a camera name or id (e.g. "garage" or "camera.garage")');
          // The glass camera (on top of the Looking Glass at Donny's desk) isn't in Home Assistant:
          // the hologram on the NUC runs it. Donny can turn the Chooms' access off in Settings > Camera.
          const glass = isGlassCameraName(camRef);
          let glassImage: Buffer | null = null;
          if (glass) {
            const answer = await askGlassCamera('frame', { purpose: 'snapshot', width: 1280 });
            if (!answer.ok || !answer.image) {
              return this.error(toolCall, answer.error || 'The glass camera did not give a picture.');
            }
            glassImage = Buffer.from(answer.image, 'base64');
          }
          // Resolve a loose camera reference ("garage", "front cam") against the
          // camera domain (only a handful of cameras), so she doesn't need the
          // exact id. Vague/no match → return just the camera list to pick from.
          const camExact = glass ? null : await exactEntity(ha, camRef);
          const camResolved = glass
            ? { entityId: 'camera.glass', resolvedFrom: camRef === 'glass' ? undefined : camRef }
            : camExact && camExact.startsWith('camera.')
              ? { entityId: camExact }
              : await resolveEntity(ha, camRef, 'camera', pickCameraAmongTies);
          if (!('entityId' in camResolved)) {
            // "driveway" is a preset on three cameras, not a camera (2026-10-27,
            // 5 misses across all three Chooms): say where it is.
            let presetHint = '';
            try {
              const hits = camerasWithPreset(camRef.replace(/^camera\./i, ''), await ha.listStates());
              if (hits.length) {
                presetHint = ` "${camRef}" is a PTZ preset, not a camera: ${hits.map(h => `${h.camera} has preset "${h.preset}"`).join('; ')}. Take it in one call: ha_get_camera_snapshot(entity_id="${hits[0].camera}", preset="${hits[0].preset}").`;
              }
            } catch { /* the camera list below still helps */ }
            return this.error(
              toolCall,
              `No camera matches "${camRef}".${presetHint}${camResolved.candidates.length
                ? ` Cameras on THIS system: ${entityListText(camResolved.candidates)}, and "glass" (the camera on the Looking Glass at Donny's desk). Use one of these.`
                : ' No camera entities found on this Home Assistant.'}`,
            );
          }
          const entityId = camResolved.entityId;

          // A shut, still, dark shop needs no picture: the sensors already
          // say all the camera could (see DARK_WHEN_SHUT). force=true shoots anyway.
          if (!glass && args.force !== true && args.force !== 'true') {
            const shut = await shutStillAndDark(ha, entityId);
            if (shut) {
              return this.success(toolCall, {
                success: true,
                entity_id: entityId,
                skipped: true,
                [`${shut.place}_door`]: `closed since ${shut.doorSince}`,
                [`${shut.place}_motion`]: `none (PIR) since ${shut.stillSince}`,
                ...(shut.lux !== null && { [`${shut.place}_light_lx`]: shut.lux }),
                message: `No picture taken: the ${shut.place} door has been closed since ${shut.doorSince}, its motion sensor (PIR) has seen nothing since ${shut.stillSince}${shut.lux !== null ? `, and it is dark inside (${shut.lux} lx)` : ''}, so the ${shut.place} camera would only show black. Count the ${shut.place} as checked: shut and still. If you truly need the frame (Donny asked to see it), call again with force=true.`,
              });
            }
          }

          // A look at a preset in ONE call: move, settle, shoot (2026-10-29).
          // It used to take three rounds (select_option, snapshot, analyze_image),
          // and the select_option step was the one that kept arriving without
          // its entity. A camera with no presets just gives its fixed view.
          const presetReq = typeof args.preset === 'string' ? args.preset.trim() : '';
          let movedTo: string | undefined;
          let movedSettle = 0;
          let presetNote = '';
          if (presetReq && !glass) {
            const sel = await findCameraPresetSelect(ha, entityId);
            if (!sel || !sel.options.length) {
              presetNote = ` ${entityId} has no PTZ presets, so this is its fixed view (not "${presetReq}").`;
            } else {
              const option = matchPresetOption(presetReq, sel.options);
              if (!option) {
                const elsewhere = camerasWithPreset(presetReq, await ha.listStates())
                  .filter(h => h.camera !== entityId);
                return this.success(toolCall, {
                  redirected: true,
                  success: false,
                  entity_id: entityId,
                  message: `"${presetReq}" is not one of ${entityId}'s presets, so the camera did not move and no picture was taken.`,
                  valid_presets: sel.options,
                  ...(elsewhere.length && {
                    hint: `"${presetReq}" is a preset on a different camera: ${elsewhere.map(h => `${h.camera} ("${h.preset}")`).join(', ')}.`,
                  }),
                });
              }
              await ha.callService('select', 'select_option', sel.entity_id, { option });
              const s = Number(args.settle_seconds);
              movedSettle = Number.isFinite(s) && s > 0 ? Math.max(1, Math.min(20, s)) : 10;
              console.log(`   🎯 Camera ${entityId} → preset "${option}" via ${sel.entity_id}; settling ${movedSettle}s`);
              await new Promise(r => setTimeout(r, movedSettle * 1000));
              movedTo = option;
            }
          }

          // Optional settle BEFORE capture — a backstop for blur/focus. A preset
          // MOVE via ha_call_service already auto-waits ~10s, but pass settle_seconds
          // here to wait when the camera was just moved another way, is waking from
          // sleep, or a prior frame came back blurry. Clamped 1-20s.
          const snapSettle = Number(args.settle_seconds);
          if (!glass && !movedTo && Number.isFinite(snapSettle) && snapSettle > 0) {
            const s = Math.max(1, Math.min(20, snapSettle));
            console.log(`   ⏳ Camera snapshot settle: waiting ${s}s before capturing ${entityId}`);
            await new Promise(r => setTimeout(r, s * 1000));
          }

          const base = haSettings.baseUrl.replace(/\/+$/, '');
          const url = `${base}/api/camera_proxy/${entityId}`;
          let resp: Response;
          if (glassImage) {
            resp = new Response(new Uint8Array(glassImage), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
          } else try {
            resp = await fetch(url, {
              headers: { Authorization: `Bearer ${haSettings.accessToken}` },
            });
          } catch (fetchErr) {
            const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            return this.error(toolCall, `Could not reach HA at ${base} — ${msg}`);
          }
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            // A 404 is almost always a guessed camera id — list the real cameras
            // and suggest the closest ones rather than just saying "check the state".
            let suggestion = ` Check ha_get_state("${entityId}").`;
            if (resp.status === 404) {
              try {
                const cams = await ha.listStates('camera');
                if (cams.length) {
                  const top = rankEntityMatches(entityId, cams).slice(0, 8).map(e => {
                    const fn = String(e.attributes?.friendly_name || '');
                    return fn && fn !== e.entity_id ? `${e.entity_id} ("${fn}")` : e.entity_id;
                  }).join(', ');
                  suggestion = ` Real cameras on THIS system: ${top}. Use one of these exact ids — do NOT guess.`;
                }
              } catch { /* fall back to the generic hint */ }
            }
            return this.error(toolCall, `HA camera_proxy ${resp.status}: ${text.slice(0, 200) || resp.statusText}. The entity may be unavailable or not a streamable camera.${suggestion}`);
          }

          const arrayBuf = await resp.arrayBuffer();
          const imageBuffer = Buffer.from(arrayBuf);

          // Default save path: selfies_{slug}/camera/{entityName}_{YYYY-MM-DD_HH-mm}.jpg
          // — kept CAPTURE_RETENTION_HOURS, skipped by the selfie backup.
          const choomName = ((ctx.choom as Record<string, unknown>)?.name as string) || 'unassigned';
          const choomSlug = choomName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unassigned';
          const entityName = entityId.split('.').pop() || 'camera';
          // Local time, not UTC: a file named …_20-23 was read back as "8:23" (2026-09-13).
          const stamp = localFileStamp();
          const defaultPath = `${cameraSnapshotFolder(choomSlug)}/${entityName}_${stamp}.jpg`;
          await pruneExpiredCaptures(ctx.choomId, choomSlug);

          let savePath = args.save_path as string | undefined;
          if (!savePath) {
            savePath = defaultPath;
          } else {
            // sibling_journal is append-only text entries between Chooms — NOT an image dump.
            // Chooms keep putting snapshots there, then trying (and failing) to delete them.
            // Redirect to the default personal location and log a correction.
            if (savePath.startsWith('sibling_journal/') || savePath.includes('/sibling_journal/')) {
              console.warn(`   🔀 Camera snapshot redirected: "${savePath}" → "${defaultPath}" (sibling_journal/ is text-only, append-only)`);
              savePath = defaultPath;
            }
          }
          if (!/\.(jpg|jpeg|png)$/i.test(savePath)) {
            savePath = savePath.replace(/\/$/, '') + '.jpg';
          }

          const { sessionFileCount } = ctx;
          if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
            return this.error(toolCall, `Session file limit reached (${sessionFileCount.maxAllowed}). Cannot save more files.`);
          }

          const ws = new WorkspaceService(WORKSPACE_ROOT, MAX_SNAPSHOT_KB, WORKSPACE_IMAGE_EXTENSIONS);
          const result = await ws.writeFileBuffer(savePath, imageBuffer, WORKSPACE_IMAGE_EXTENSIONS);
          sessionFileCount.created++;
          ctx.send({ type: 'file_created', path: savePath });

          // Persist to GeneratedImage so the chat UI can render it inline the same way
          // it renders generate_image output. Also emit `image_generated` during the
          // turn so the user sees it immediately (streamingImage state).
          let savedImageId: string | undefined;
          let dataUrl: string | undefined;
          try {
            dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
            const savedImage = await prisma.generatedImage.create({
              data: {
                choomId: ctx.choomId,
                prompt: `Camera snapshot: ${entityId}`,
                imageUrl: dataUrl,
                settings: JSON.stringify({ source: glass ? 'glass_camera_snapshot' : 'ha_camera_snapshot', entity_id: entityId, path: savePath }),
              },
            });
            savedImageId = savedImage.id;
            ctx.send({
              type: 'image_generated',
              imageUrl: dataUrl,
              imageId: savedImage.id,
              prompt: `Camera snapshot: ${entityId}`,
            });
          } catch (persistErr) {
            console.warn(`   ⚠️ Camera snapshot persisted to disk but DB/UI display failed:`, persistErr instanceof Error ? persistErr.message : persistErr);
          }

          console.log(`   📷 Camera snapshot: ${entityId} → ${savePath} (${(imageBuffer.length / 1024).toFixed(1)}KB)${savedImageId ? ` [imageId ${savedImageId}]` : ''}`);

          // Drill-down level 2: surface THIS camera's PTZ presets (scoped — only
          // this camera's, not every entity) plus the one call that looks at any
          // of them, so she can reposition without hunting for the select id.
          const presetInfo = glass ? null : await findCameraPresetSelect(ha, entityId);

          // question: the look in the same call (2026-10-29). Every snapshot used
          // to cost a second round for analyze_image — 777 of them for Aloy in
          // five days, most of her overnight watch. Same vision settings, same
          // code: it is the analyze_image handler. A failed look still returns
          // the saved picture.
          const question = typeof args.question === 'string' ? args.question.trim() : '';
          let analysis: string | undefined;
          let analysisModel: string | undefined;
          let analysisError: string | undefined;
          if (question) {
            const look = await new ImageAnalysisHandler().execute(
              { id: `${toolCall.id}-look`, name: 'analyze_image', arguments: { image_path: savePath, prompt: question } },
              ctx,
            );
            const lr = look.result as { analysis?: string; model?: string } | null;
            if (look.error || !lr?.analysis) analysisError = look.error || 'The vision model gave no answer.';
            else { analysis = lr.analysis; analysisModel = lr.model; }
          }

          const presetsLine = presetInfo && presetInfo.options.length
            ? ` This camera's PTZ presets: ${presetInfo.options.join(', ')} — look at any of them in one call with preset="<name>".`
            : '';
          const viewLine = movedTo
            ? ` The camera was moved to preset "${movedTo}" and given ${movedSettle}s to settle, so this frame IS that view.`
            : ` This frame shows wherever the camera was already pointing; it is not any particular preset view unless you passed preset.${presetNote}`;
          const lookLine = analysis
            ? ' The vision answer to your question is in "analysis" — no need to call analyze_image for this frame.'
            : analysisError
              ? ` The picture was saved but the look failed (${analysisError.slice(0, 200)}).`
              : ` To look at it, pass question="…" next time (one call), or use analyze_image(image_path="${savePath}").`;

          return this.success(toolCall, {
            success: true,
            entity_id: entityId,
            ...(camResolved.resolvedFrom && { resolved_from: camResolved.resolvedFrom }),
            ...(movedTo && { preset: movedTo }),
            path: savePath,
            ...(savedImageId && { imageId: savedImageId }),
            sizeKB: Math.round(imageBuffer.length / 1024),
            captured_at: localTimeString(),
            ...(analysis && { analysis, analysis_model: analysisModel }),
            ...(analysisError && { analysis_error: analysisError }),
            ...(presetInfo && presetInfo.options.length && {
              presets: presetInfo.options,
              look_at_preset: `ha_get_camera_snapshot(entity_id="${entityId}", preset="<one of presets>", question="<what to check>")`,
            }),
            message: `Saved snapshot from ${entityId} to ${savePath}${savedImageId ? ' and displayed in chat' : ''}.${viewLine}${lookLine}${presetsLine} Snapshots are kept ${CAPTURE_RETENTION_HOURS}h and do not go in your gallery — if something in this frame matters longer, write what you saw to a note. To text it to the user use send_notification(file_paths=["${savePath}"]).`,
          });
        }

        default:
          return this.error(toolCall, `Unknown tool: ${toolCall.name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // HA's bare "400: Bad Request" is unhelpful. On ha_call_service, attach a
      // shape-diagnostic hint pointing at the most common fixes, because HA itself
      // won't tell us what was wrong.
      if (toolCall.name === 'ha_call_service' && /HA API 400\b/.test(msg)) {
        return this.error(
          toolCall,
          `${msg} — HA returned 400 with no detail. Common causes: (1) service_data must be an object like {"option":"Driveway"}, NOT a YAML/string like "option: Driveway"; (2) target must be an object like {"entity_id":"..."} if provided; (3) the option value must exactly match one of attributes.options from ha_get_state(entity_id) — names are case-sensitive; (4) the service may not exist — run ha_list_services(domain="${(toolCall.arguments?.domain as string) || ''}") to verify.`
        );
      }
      if (/HA API 404\b/.test(msg)) {
        const guessedId = (toolCall.arguments?.entity_id as string) || '';
        const domainHint = guessedId.includes('.') ? guessedId.split('.')[0] : '';
        // Don't just tell the model to list entities — DO the lookup and hand back
        // the real ids (closest matches first). The guess-and-retry loop was the
        // top driver of wasted iterations; surfacing actual ids ends it in one turn.
        let suggestion = '';
        try {
          const candidates = await ha.listStates(domainHint || undefined);
          if (candidates.length) {
            const ranked = rankEntityMatches(guessedId, candidates);
            const top = ranked.slice(0, 8);
            const label = top.map(e => {
              const fn = String(e.attributes?.friendly_name || '');
              return fn && fn !== e.entity_id ? `${e.entity_id} ("${fn}")` : e.entity_id;
            }).join(', ');
            suggestion = ` Real ${domainHint ? `${domainHint} ` : ''}entities on THIS system${top.length < candidates.length ? ' (closest matches)' : ''}: ${label}. Use one of these exact ids.`;
          }
        } catch {
          // Listing failed — fall back to the generic "go list" guidance below.
        }
        return this.error(
          toolCall,
          `Entity "${guessedId}" does not exist — do NOT guess entity IDs.${suggestion || ` Call ha_list_entities(${domainHint ? `domain="${domainHint}"` : ''}) to discover the actual ids on this system.`}`
        );
      }
      return this.error(toolCall, `Home Assistant error: ${msg}`);
    }
  }
}
