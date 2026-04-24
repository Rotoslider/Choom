import { BaseSkillHandler, type SkillHandlerContext } from '@/lib/skill-handler';
import { HomeAssistantService, type HomeAssistantSettings } from '@/lib/homeassistant-service';
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
          const entityId = args.entity_id as string;
          if (!entityId) return this.error(toolCall, 'entity_id is required');

          const entity = await ha.getState(entityId);
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
          const entityId = args.entity_id as string | undefined;
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
                      const opts = Array.isArray(e.attributes?.options) ? (e.attributes.options as string[]).slice(0, 12).join(', ') : '';
                      return `  • ${e.entity_id}${opts ? ` (options: ${opts}${(e.attributes.options as string[]).length > 12 ? '…' : ''})` : ''}`;
                    });
                  // Also look for button.*_preset_* entities (some integrations use these).
                  const buttons = all
                    .filter(e => e.entity_id.startsWith('button.') && /preset|ptz/i.test(e.entity_id))
                    .slice(0, 8)
                    .map(e => `  • ${e.entity_id}`);
                  if (selectors.length > 0) {
                    ptzHint = `\n\nHA does NOT have generic PTZ services — presets are exposed as select entities. On this system:\n${selectors.join('\n')}\n\nTo move the camera, call:\n  ha_call_service(domain="select", service="select_option", entity_id="<the select entity above>", service_data={"option":"<preset name>"})\n\nThe handler will auto-wait 2.5s for the camera to move before you take a snapshot.`;
                  } else if (buttons.length > 0) {
                    ptzHint = `\n\nHA does NOT have generic PTZ services. This system has preset button entities — press one with:\n  ha_call_service(domain="button", service="press", entity_id="<button entity>")\n\nAvailable preset buttons:\n${buttons.join('\n')}`;
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
          const selectTargetEntity = entityId
            || (typeof target?.entity_id === 'string' ? target.entity_id : undefined);
          if (domain === 'select' && service === 'select_option' && serviceData?.option && selectTargetEntity) {
            try {
              const state = await ha.getState(selectTargetEntity);
              const options = state.attributes?.options as string[] | undefined;
              const requested = String(serviceData.option);
              if (Array.isArray(options) && !options.includes(requested)) {
                const ciMatch = options.find(o => String(o).toLowerCase() === requested.toLowerCase());
                if (ciMatch) {
                  console.log(`   🔀 select_option case-corrected: "${requested}" → "${ciMatch}"`);
                  serviceData.option = ciMatch;
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
          const entityId = args.entity_id as string;
          if (!entityId) return this.error(toolCall, 'entity_id is required (e.g. "camera.garage")');
          if (!entityId.startsWith('camera.')) {
            return this.error(toolCall, `entity_id must be a camera entity (got "${entityId}"). Use ha_list_entities with domain="camera" to discover cameras.`);
          }

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
            return this.error(toolCall, `HA camera_proxy ${resp.status}: ${text.slice(0, 200) || resp.statusText}. The entity may be unavailable or not a streamable camera — check ha_get_state("${entityId}").`);
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

          return this.success(toolCall, {
            success: true,
            entity_id: entityId,
            path: savePath,
            ...(savedImageId && { imageId: savedImageId }),
            sizeKB: Math.round(imageBuffer.length / 1024),
            captured_at: new Date().toISOString(),
            message: `Saved snapshot from ${entityId} to ${savePath}${savedImageId ? ' and displayed in chat' : ''}. IMPORTANT: this snapshot shows whatever the camera was pointing at when you called this tool — it is NOT associated with any PTZ preset unless you successfully called select.select_option on the preset selector entity BEFORE this snapshot and that call succeeded (the 400 errors you may have received on ptz_preset services mean the camera did NOT move). Do NOT claim the image shows a specific preset view unless you verified the preset change succeeded. For analysis use analyze_image(image_path="${savePath}"). To text it to the user use send_notification(file_paths=["${savePath}"]).`,
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
      return this.error(toolCall, `Home Assistant error: ${msg}`);
    }
  }
}
