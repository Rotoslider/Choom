import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'ha_get_state',
    description: 'Get the current state and attributes of a single Home Assistant entity. Returns state value, friendly name, and relevant attributes.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'The entity ID in domain.name format, e.g. "sensor.bathroom_temperature", "light.kitchen"',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'ha_list_entities',
    description: 'List available Home Assistant entities. Use to discover entity IDs. Filter by domain (e.g. "light", "sensor") or area/room name.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Filter by domain: light, switch, sensor, binary_sensor, climate, fan, cover, etc.',
        },
        area: {
          type: 'string',
          description: 'Filter by area/room name (e.g. "kitchen", "bathroom", "garage")',
        },
      },
    },
  },
  {
    name: 'ha_call_service',
    description: 'Call a Home Assistant service to control a device. Use for turning on/off lights, switches, setting thermostat temperature, etc.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Service domain: light, switch, climate, fan, cover, etc.',
        },
        service: {
          type: 'string',
          description: 'Service name: turn_on, turn_off, toggle, set_temperature, set_hvac_mode, etc.',
        },
        entity_id: {
          type: 'string',
          description: 'Target entity ID, e.g. "light.kitchen", "switch.heater"',
        },
        service_data: {
          type: 'object',
          description: 'Optional service data, e.g. {"brightness": 128} for lights or {"temperature": 72} for climate',
        },
      },
      required: ['domain', 'service', 'entity_id'],
    },
  },
  {
    name: 'ha_get_history',
    description: 'Get historical state data for a Home Assistant entity. Returns summarized min/max/avg and trend direction over the time period.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Entity to get history for, e.g. "sensor.bathroom_temperature"',
        },
        hours: {
          type: 'number',
          description: 'Number of hours to look back (default 24, max 168/7 days)',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'ha_get_home_status',
    description: 'Get a full snapshot of all monitored Home Assistant entities, grouped by domain. Shows all active sensors, lights, switches, etc.',
    parameters: {
      type: 'object',
      properties: {
        include_off: {
          type: 'boolean',
          description: 'Include entities that are currently off (default: false)',
        },
      },
    },
  },
];
