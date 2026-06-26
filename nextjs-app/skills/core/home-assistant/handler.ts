import { BaseSkillHandler, type SkillHandlerContext } from '@/lib/skill-handler';
import { HomeAssistantService, type HomeAssistantSettings, type HAEntity } from '@/lib/homeassistant-service';
import { WorkspaceService } from '@/lib/workspace-service';
import { WORKSPACE_ROOT } from '@/lib/config';
import prisma from '@/lib/db';
import type { ToolCall, ToolResult } from '@/lib/types';

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
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score++;
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
): Promise<{ entityId: string; resolvedFrom?: string } | { candidates: HAEntity[]; domain: string }> {
  const refTrim = (ref || '').trim();
  const dom = domain || (refTrim.includes('.') ? refTrim.split('.')[0] : undefined);
  const entities = await ha.listStates(dom);
  const exact = entities.find(e => e.entity_id.toLowerCase() === refTrim.toLowerCase());
  if (exact) return { entityId: exact.entity_id };
  if (!entities.length) return { candidates: [], domain: dom || '' };
  const scored = scoreEntities(refTrim, entities);
  const top = scored[0];
  const topCount = scored.filter(s => s.score === top.score).length;
  if (top.score > 0 && topCount === 1) return { entityId: top.e.entity_id, resolvedFrom: refTrim };
  return { candidates: top.score > 0 ? scored.map(s => s.e) : entities, domain: dom || '' };
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
    const selects = all.filter(e => e.entity_id.startsWith('select.') && /ptz|preset/i.test(e.entity_id));
    if (!selects.length) return null;
    const cam = all.find(e => e.entity_id === cameraEntityId);
    const camName = `${cameraEntityId.replace(/^camera\./, '')} ${String(cam?.attributes?.friendly_name || '')}`;
    const best = scoreEntities(camName, selects)[0];
    const chosen = best && best.score > 0 ? best.e : (selects.length === 1 ? selects[0] : null);
    if (!chosen) return null;
    const options = Array.isArray(chosen.attributes?.options) ? chosen.attributes.options as string[] : [];
    return { entity_id: chosen.entity_id, options };
  } catch {
    return null;
  }
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

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
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
            const r = await resolveEntity(ha, ref);
            if ('entityId' in r) {
              entity = await ha.getState(r.entityId);
              resolvedFrom = ref;
            } else {
              return this.error(
                toolCall,
                `Entity "${ref}" doesn't exist — don't guess ids.${r.candidates.length
                  ? ` Real ${r.domain ? `${r.domain} ` : ''}entities on THIS system: ${entityListText(r.candidates)}. Use one of these exact ids.`
                  : ` Call ha_list_entities(${r.domain ? `domain="${r.domain}"` : ''}) to discover them.`}`,
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
          const entities = await ha.listStates(domain, area);

          const list = entities.map(e => ({
            entity_id: e.entity_id,
            friendly_name: String(e.attributes.friendly_name || e.entity_id),
            state: e.state,
            domain: e.entity_id.split('.')[0],
          }));

          return this.success(toolCall, {
            count: list.length,
            entities: list,
            ...(domain && { filtered_by_domain: domain }),
            ...(area && { filtered_by_area: area }),
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

          // Specific entity_id-missing catch for entity-scoped services. Chooms often
          // forget to specify which entity to act on, sending {service, service_data,
          // domain} only. HA responds with a bare 400 which our generic diagnostic
          // can't disambiguate from real shape errors. Detect this pre-dispatch.
          const hasAnyEntityTarget = Boolean(
            entityId
            || (target && (target.entity_id || target.area_id || target.device_id))
          );
          const ENTITY_SCOPED_SERVICES = /^(select|light|switch|fan|cover|climate|button|media_player|lock|input_boolean|input_select|input_number|input_text|input_datetime|scene|automation|script)\./;
          if (!hasAnyEntityTarget && ENTITY_SCOPED_SERVICES.test(`${domain}.${service}`)) {
            return this.error(
              toolCall,
              `Service "${domain}.${service}" requires you to specify WHICH entity to act on. You provided service_data but no entity_id or target. Add either entity_id:"<entity>" at the top level OR target:{"entity_id":"<entity>"}. Example for your call: ha_call_service(domain="${domain}", service="${service}", entity_id="<your entity>", service_data=${JSON.stringify(serviceData || {})}).`
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
            if (Number.isFinite(v)) settleOverride = Math.max(1, Math.min(15, v));
            delete serviceData.settle_seconds;
          }

          const result = await ha.callService(domain, service, entityId, serviceData, target);

          // PTZ preset selectors are mechanical — the camera needs time to physically
          // pan/tilt/zoom after the service call returns. Without a settle delay, the
          // next ha_get_camera_snapshot catches the old frame. 6s covers full 180° pans
          // with zoom changes on typical home PTZ cams. Caller can override via
          // service_data.settle_seconds (clamped 1-15) for smaller moves.
          const isPtzPreset = domain === 'select' && service === 'select_option'
            && (selectTargetEntity?.includes('ptz') || selectTargetEntity?.includes('preset'));
          if (isPtzPreset) {
            const settleSeconds = settleOverride !== undefined ? settleOverride : 6;
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
                note: `Camera moved to "${requested}". The select entity reports state "unknown" because Reolink/HA does not read the active preset back — this is NORMAL and does NOT mean the move failed. Do not re-select or call ha_get_state to "confirm"; trust this success. To see the new view, call ha_get_camera_snapshot.`,
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
            note: isPtzPreset
              ? `PTZ preset selected. Waited for camera to move — now safe to call ha_get_camera_snapshot to capture the new view. If the next snapshot still shows the wrong view, the move took longer than the default 6s settle; retry the same select_option call with service_data={"option":"<name>","settle_seconds":10} for large pans.`
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
          const rendered = await ha.renderTemplate(template);
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
            ...(typeof parsed === 'string' && parsed !== rendered && { raw: rendered }),
          });
        }

        case 'ha_get_history': {
          const entityId = args.entity_id as string;
          if (!entityId) return this.error(toolCall, 'entity_id is required');

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
          const entityId = args.entity_id as string;
          if (!entityId) return this.error(toolCall, 'entity_id is required');

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
          const groups = await ha.getHomeSummary(includeOff);

          // Format for readability
          const formatted: Record<string, unknown[]> = {};
          let totalEntities = 0;
          for (const [domain, entities] of Object.entries(groups)) {
            formatted[domain] = entities.map(e => ({
              name: e.name,
              state: e.state,
              ...(e.extras && { details: e.extras }),
            }));
            totalEntities += entities.length;
          }

          return this.success(toolCall, {
            total_entities: totalEntities,
            domains: formatted,
            include_off: includeOff,
          });
        }

        case 'ha_get_camera_snapshot': {
          const camRef = (args.entity_id as string) || (args.camera as string);
          if (!camRef) return this.error(toolCall, 'entity_id is required — a camera name or id (e.g. "garage" or "camera.garage")');
          // Resolve a loose camera reference ("garage", "front cam") against the
          // camera domain (only a handful of cameras), so she doesn't need the
          // exact id. Vague/no match → return just the camera list to pick from.
          const camResolved = await resolveEntity(ha, camRef, 'camera');
          if (!('entityId' in camResolved)) {
            return this.error(
              toolCall,
              `No camera matches "${camRef}".${camResolved.candidates.length
                ? ` Cameras on THIS system: ${entityListText(camResolved.candidates)}. Use one of these.`
                : ' No camera entities found on this Home Assistant.'}`,
            );
          }
          const entityId = camResolved.entityId;

          const base = haSettings.baseUrl.replace(/\/+$/, '');
          const url = `${base}/api/camera_proxy/${entityId}`;
          let resp: Response;
          try {
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

          // Default save path: selfies_{slug}/{entityName}_{YYYY-MM-DD_HH-mm}.jpg
          const choomName = ((ctx.choom as Record<string, unknown>)?.name as string) || 'unassigned';
          const choomSlug = choomName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unassigned';
          const entityName = entityId.split('.').pop() || 'camera';
          const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '-');
          const defaultPath = `selfies_${choomSlug}/${entityName}_${stamp}.jpg`;

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
                settings: JSON.stringify({ source: 'ha_camera_snapshot', entity_id: entityId, path: savePath }),
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
          // this camera's, not every entity) plus the exact call to move it, so she
          // can reposition without hunting for the select.*_ptz entity id.
          const presetInfo = await findCameraPresetSelect(ha, entityId);

          return this.success(toolCall, {
            success: true,
            entity_id: entityId,
            ...(camResolved.resolvedFrom && { resolved_from: camResolved.resolvedFrom }),
            path: savePath,
            ...(savedImageId && { imageId: savedImageId }),
            sizeKB: Math.round(imageBuffer.length / 1024),
            captured_at: new Date().toISOString(),
            ...(presetInfo && presetInfo.options.length && {
              presets: presetInfo.options,
              move_to_preset: `ha_call_service(domain="select", service="select_option", entity_id="${presetInfo.entity_id}", service_data={"option":"<one of presets>"})`,
            }),
            message: `Saved snapshot from ${entityId} to ${savePath}${savedImageId ? ' and displayed in chat' : ''}.${presetInfo && presetInfo.options.length ? ` This camera's PTZ presets: ${presetInfo.options.join(', ')} — move it with the move_to_preset call, then snapshot again.` : ''} IMPORTANT: this snapshot shows whatever the camera was pointing at when you called this tool — it is NOT associated with any PTZ preset unless you successfully called select.select_option on the preset selector entity BEFORE this snapshot and that call succeeded. Do NOT claim the image shows a specific preset view unless you verified the preset change succeeded. For analysis use analyze_image(image_path="${savePath}"). To text it to the user use send_notification(file_paths=["${savePath}"]).`,
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
