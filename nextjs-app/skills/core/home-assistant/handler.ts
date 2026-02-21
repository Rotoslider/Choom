import { BaseSkillHandler, type SkillHandlerContext } from '@/lib/skill-handler';
import { HomeAssistantService, type HomeAssistantSettings } from '@/lib/homeassistant-service';
import type { ToolCall, ToolResult } from '@/lib/types';

const TOOL_NAMES = new Set([
  'ha_get_state',
  'ha_list_entities',
  'ha_call_service',
  'ha_get_history',
  'ha_get_home_status',
]);

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
          const entityId = args.entity_id as string;
          const serviceData = args.service_data as Record<string, unknown> | undefined;

          if (!domain || !service || !entityId) {
            return this.error(toolCall, 'domain, service, and entity_id are all required');
          }

          const result = await ha.callService(domain, service, entityId, serviceData);

          // Get the updated state
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

        case 'ha_get_history': {
          const entityId = args.entity_id as string;
          if (!entityId) return this.error(toolCall, 'entity_id is required');

          const hours = Math.min(Math.max(Number(args.hours) || 24, 1), 168);
          const summary = await ha.getHistory(entityId, hours);

          return this.success(toolCall, {
            entity_id: summary.entity_id,
            friendly_name: summary.friendly_name,
            period: `${hours} hours`,
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

        default:
          return this.error(toolCall, `Unknown tool: ${toolCall.name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.error(toolCall, `Home Assistant error: ${msg}`);
    }
  }
}
