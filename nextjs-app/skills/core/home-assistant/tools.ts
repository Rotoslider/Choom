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
    description: 'Call any Home Assistant service. Works for device control (light, switch, climate, fan, cover), global services (notify.*, tts.speak, scene.turn_on, scene.create, automation.trigger, script.turn_on, homeassistant.*), and area/device-targeted calls. Only domain + service are required — use entity_id for single-entity control, target for area/device/multi-entity, or neither for global services. NOTE: for camera snapshots use ha_get_camera_snapshot, not camera.snapshot here.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Service domain: light, switch, climate, notify, tts, scene, script, automation, homeassistant, etc.',
        },
        service: {
          type: 'string',
          description: 'Service name: turn_on, turn_off, toggle, set_temperature, create, trigger, speak, mobile_app_<device>, etc.',
        },
        entity_id: {
          type: 'string',
          description: 'Optional target entity ID for single-entity services, e.g. "light.kitchen". Omit for global services like notify.* or scene.create.',
        },
        target: {
          type: 'object',
          description: 'Optional modern-form target. Use for area/device targeting or multi-entity calls. Example: {"area_id": "kitchen"} or {"entity_id": ["light.a", "light.b"]} or {"device_id": "abc123"}. Preferred over entity_id for newer integrations.',
        },
        service_data: {
          type: 'object',
          description: 'Service parameters. Examples: {"brightness": 128} for lights, {"temperature": 72} for climate, {"message": "hello", "title": "alert"} for notify, {"message": "hi", "entity_id": "media_player.x"} for tts.speak, {"variables": {...}} for script.turn_on, {"scene_id": "guest_mode", "entities": {...}} for scene.create.',
        },
      },
      required: ['domain', 'service'],
    },
  },
  {
    name: 'ha_list_services',
    description: 'List real services available on this HA instance. Use this BEFORE calling ha_call_service with a service you\'re not sure exists (e.g. PTZ/preset/camera-control services vary wildly by integration). Prevents wasted iterations on hallucinated service names. Returns services grouped by domain with their field schemas.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Optional domain filter: "camera", "light", "reolink", "select", "button", etc. Omit to get everything (can be large).',
        },
      },
    },
  },
  {
    name: 'ha_fire_event',
    description: 'Fire a custom event on the Home Assistant bus. Useful for triggering automations that listen via "event:" triggers, or signaling other integrations. Different from calling a service.',
    parameters: {
      type: 'object',
      properties: {
        event_type: {
          type: 'string',
          description: 'The event name, e.g. "choom_detected_motion", "guest_arrived"',
        },
        event_data: {
          type: 'object',
          description: 'Optional event payload. Listeners receive this verbatim.',
        },
      },
      required: ['event_type'],
    },
  },
  {
    name: 'ha_render_template',
    description: 'Render a Jinja2 template against live Home Assistant state. Powerful for complex state questions that would take many ha_get_state calls. Supports HA helpers like states(...), is_state(...), area_entities(...), state_attr(...), expand(...), now(), etc. Returns the rendered string.',
    parameters: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          description: 'Jinja2 template string. Examples: "{{ states(\'sensor.temperature\') }}" · "{{ area_entities(\'kitchen\') | list | tojson }}" · "{% set on_lights = states.light | selectattr(\'state\', \'equalto\', \'on\') | list %}{{ on_lights | length }}" · "{{ states | selectattr(\'attributes.device_class\', \'equalto\', \'motion\') | selectattr(\'state\', \'equalto\', \'on\') | map(attribute=\'entity_id\') | list | tojson }}"',
        },
      },
      required: ['template'],
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
    name: 'ha_get_camera_snapshot',
    description: 'Fetch a JPEG frame from a Home Assistant camera entity and save it to the workspace. Use this for camera.* entities (Reolink, generic MJPEG, etc.) — do NOT use ha_call_service with camera.snapshot. Returns a workspace path usable with analyze_image, send_notification(file_paths=...), or inline display in chat.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Camera entity ID, e.g. "camera.tower_clear", "camera.garage". Use ha_list_entities with domain="camera" if unsure.',
        },
        save_path: {
          type: 'string',
          description: 'Optional workspace-relative path, must end in .jpg. Defaults to selfies_{choom}/{entity}_{YYYY-MM-DD_HH-mm}.jpg. Valid destinations: selfies_{slug}/ (personal, default) or choom_commons/ (shared with other Chooms). NEVER use sibling_journal/ — that folder is text-only and append-only; snapshots there cannot be deleted later. If omitted or misrouted, the tool will place it in your personal selfies folder.',
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
