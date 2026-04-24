---
name: home-assistant
description: Controls smart home devices and reads sensor data via Home Assistant
version: 1.0.0
author: system
tools:
  - ha_get_state
  - ha_list_entities
  - ha_call_service
  - ha_get_history
  - ha_get_home_status
  - ha_get_camera_snapshot
  - ha_fire_event
  - ha_render_template
  - ha_list_services
dependencies: []
---

## When to Use

- User asks about home sensor readings (temperature, humidity, motion, doors)
- User wants to control lights, switches, fans, covers, or thermostats
- User asks for historical sensor data or trends
- User asks for a home status overview

## Entity IDs

Home Assistant entities follow the format `domain.name` but names are often non-obvious.
**CRITICAL: NEVER guess entity IDs.** Always use `ha_list_entities` first to discover actual IDs, or use `ha_get_home_status` to get all readings at once. Entity IDs frequently don't match what you'd expect (e.g. bathroom temperature might be `sensor.temperature`, not `sensor.bathroom_temperature`).

Common domains:
- `sensor` — numeric readings (temperature, humidity, power)
- `binary_sensor` — on/off states (motion, door, window)
- `light` — controllable lights (supports brightness, color)
- `switch` — on/off switches
- `climate` — thermostats / HVAC
- `fan` — fans with speed control
- `cover` — garage doors, blinds, shutters

## Common Services

### Device control (uses `entity_id`)

| Domain | Service | Use |
|--------|---------|-----|
| light | turn_on | Turn on (optional: brightness 0-255, color_name, rgb_color) |
| light | turn_off | Turn off |
| light | toggle | Toggle on/off |
| switch | turn_on | Turn on |
| switch | turn_off | Turn off |
| climate | set_temperature | Set target temp (service_data: {temperature: 72}) |
| climate | set_hvac_mode | Set mode (heat, cool, auto, off) |
| fan | turn_on | Turn on (optional: percentage) |
| cover | open_cover | Open garage door / blinds |
| cover | close_cover | Close garage door / blinds |

### Global services (omit `entity_id`)

| Domain | Service | Example `service_data` |
|--------|---------|------------------------|
| notify | mobile_app_<device> | `{"message": "motion detected", "title": "Alert"}` |
| notify | persistent_notification | `{"message": "...", "title": "..."}` |
| tts | speak | `{"entity_id": "tts.<provider>", "media_player_entity_id": "media_player.living_room", "message": "hello"}` — **`entity_id` is the TTS service entity (tts.*), NOT the speaker**. Find providers with `ha_list_entities(domain="tts")`. If you only have `media_player.play_media`, use that instead. |
| scene | turn_on | Pass `entity_id: "scene.movie_time"` to activate |
| scene | create | `{"scene_id": "guest_mode", "entities": {"light.kitchen": {"state": "on", "brightness": 180}}}` |
| script | turn_on | `entity_id: "script.bedtime"`, or omit entity_id and pass `{"variables": {...}}` for parameterized scripts |
| automation | trigger | `entity_id: "automation.morning_routine"` |
| homeassistant | reload_config_entry | For reloading an integration |

### Speakers & TTS — finding the right entities

HA has two kinds of entities involved in voice output:

1. **TTS provider** (`tts.*`) — the engine that converts text to audio. Examples: `tts.chatterbox`, `tts.piper`, `tts.google_translate_en_com`, `tts.openai_tts`. Discover with `ha_list_entities(domain="tts")`. **On this system, prefer `tts.chatterbox`** — it's the configured/tuned provider. Only fall back to another if chatterbox isn't present.
2. **Speaker / media player** (`media_player.*`) — where the audio plays. Home Assistant Voice PE devices may register as `media_player.home_assistant_voice_<id>` **and/or** `assist_satellite.*` — check both domains.

To speak on a speaker:
```
ha_call_service(
  domain: "tts", service: "speak",
  service_data: {
    "entity_id": "tts.piper",                           # TTS provider
    "media_player_entity_id": "media_player.living_room", # speaker
    "message": "Dinner is ready"
  }
)
```

If TTS isn't configured, fall back to `media_player.play_media` with a URL, or use `notify.mobile_app_<device>` to send a push instead.

### Area/device targeting (use `target` param)

```
ha_call_service(domain: "light", service: "turn_off", target: {"area_id": "kitchen"})
ha_call_service(domain: "light", service: "turn_on", target: {"entity_id": ["light.a", "light.b"]}, service_data: {"brightness": 128})
```

## Tool Selection

- **Reading one entity**: `ha_get_state` — fast, cached
- **Finding entities**: `ha_list_entities` — discover what's available; `area` filter uses HA's real area registry (device→area inheritance respected), falls back to friendly-name matching
- **Controlling devices / services**: `ha_call_service` — lights, scenes, scripts, TTS, notify, automation triggering, etc.
- **Trends/history**: `ha_get_history` — min/max/avg over time
- **Full overview**: `ha_get_home_status` — snapshot of all active devices
- **Camera frame**: `ha_get_camera_snapshot` — fetches JPEG to workspace
- **Complex state questions**: `ha_render_template` — one call answers what would take 20 `ha_get_state`s
- **Trigger automations via bus**: `ha_fire_event` — emit custom events that automations can listen for

## Templates (`ha_render_template`)

When a question would take many `ha_get_state` calls, use one template instead:

```
# "Which motion sensors are active right now?"
template: "{{ states | selectattr('attributes.device_class','equalto','motion') | selectattr('state','equalto','on') | map(attribute='entity_id') | list | tojson }}"

# "Are all the downstairs lights off?"
template: "{{ area_entities('downstairs') | select('match','^light\\.') | map('states') | select('equalto','on') | list | length == 0 }}"

# "What's the average temperature across all thermostats?"
template: "{{ states.climate | map(attribute='attributes.current_temperature') | select('number') | sum / states.climate | list | length }}"

# "Is anyone home?" (person domain)
template: "{{ states.person | selectattr('state','equalto','home') | map(attribute='attributes.friendly_name') | list | tojson }}"
```

Return values that are JSON-parseable are auto-parsed; otherwise raw string is returned.

## Camera Snapshots

To grab a still frame from an HA camera (Reolink, generic MJPEG, etc.), use **`ha_get_camera_snapshot`** — one tool, one call:

```
ha_get_camera_snapshot(entity_id: "camera.garage")
```

It authenticates with HA, fetches the JPEG, saves it to `selfies_{your_slug}/{entity}_{timestamp}.jpg`, and returns the path. **Do NOT use `ha_call_service` with `camera.snapshot`** — that writes into HA's container filesystem and the file is unreachable from your workspace.

**Save location rules**: the default (`selfies_{your_slug}/`) is almost always correct. Only override `save_path` when you have a clear reason to share the snapshot with another Choom — in that case use `choom_commons/`. **NEVER save snapshots to `sibling_journal/`** — that folder is text-only and append-only (you can't delete entries). If you try, the tool will redirect to your personal folder and warn you.

Once saved, the returned `path` works everywhere:
- **Analyze it**: `analyze_image(image_path: "<path>", prompt: "...")`
- **Send to phone**: `send_notification(message: "...", file_paths: ["<path>"])` — images display inline in Signal.
- **Display in GUI**: happens automatically via the `file_created` event; chat UI renders the image inline.

Use `ha_list_entities` with `domain: "camera"` first if you don't know the entity_id.

### PTZ / camera presets — HA does NOT have a generic "camera.ptz" service

This is the #1 place Chooms hallucinate service names (`camera.available_ptz_presets`, `ptz.list_presets`, `onvif.ptz_preset` — **none of these exist**). Actual PTZ control in HA depends on the camera's integration. Two common patterns:

1. **Preset selector entities** (Reolink, ONVIF, most modern integrations): presets are exposed as `select.<camera>_ptz_preset` entities. List options with `ha_get_state(entity_id="select.<camera>_ptz_preset")` — `attributes.options` is the preset names. Move to one via:
   ```
   ha_call_service(domain="select", service="select_option",
                   entity_id="select.<camera>_ptz_preset",
                   service_data={"option": "<preset name>"})
   ```
2. **Button entities** (some integrations): each preset is a `button.<camera>_preset_<name>` entity. Press with `ha_call_service(domain="button", service="press", entity_id="button.<preset>")`.

**Discovery workflow when you're unsure what services/entities a device exposes:**
1. `ha_list_entities()` with no filter, grep the result for the camera name — look for `select.*`, `button.*`, or integration-specific entities (e.g. `reolink.*`) related to the camera.
2. `ha_list_services(domain="<integration>")` (e.g. `domain: "reolink"`, `domain: "onvif"`) for integration-specific PTZ services.
3. `ha_list_services(domain: "camera")` to see what the `camera.*` domain actually supports — almost never has native PTZ.
4. If the camera's state has `attributes.pan` / `attributes.tilt` but no preset entities, the integration only supports live PTZ streaming, not preset recall — report that to the user instead of guessing.

**Never call** `camera.*_ptz_*`, `ptz.*`, or `onvif.ptz_*` services without first confirming they exist via `ha_list_services`. If HA returns `400: Bad Request`, the most common cause is a non-existent service name — discovery, not retry.

**Case sensitivity & settling**: `select.select_option` is case-sensitive on the option value — but the handler auto-corrects common case mismatches ("driveway" → "Driveway") by looking up `attributes.options` on the entity. When the target looks like a PTZ preset (entity_id contains "ptz" or "preset"), the handler also waits 2.5 seconds after the service call so the camera has time to physically move before you take a snapshot. Don't take a snapshot immediately yourself — just wait for `ha_call_service` to return, then call `ha_get_camera_snapshot`.

## Important

- **NEVER guess entity IDs** — always call `ha_list_entities` or `ha_get_home_status` first to find actual IDs
- If `ha_get_state` returns a 404 error, the entity_id is wrong — use `ha_list_entities` to find the correct one
- Entity states can be `unavailable` or `unknown` — do not interpret these as readings
- For lights, brightness is 0-255 in the HA API (not a percentage)
- Always confirm destructive actions with the user (e.g. opening garage door)
