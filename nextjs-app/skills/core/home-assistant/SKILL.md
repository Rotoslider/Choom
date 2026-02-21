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

## Tool Selection

- **Reading one entity**: `ha_get_state` — fast, cached
- **Finding entities**: `ha_list_entities` — discover what's available
- **Controlling devices**: `ha_call_service` — change device state
- **Trends/history**: `ha_get_history` — min/max/avg over time
- **Full overview**: `ha_get_home_status` — snapshot of all active devices

## Important

- **NEVER guess entity IDs** — always call `ha_list_entities` or `ha_get_home_status` first to find actual IDs
- If `ha_get_state` returns a 404 error, the entity_id is wrong — use `ha_list_entities` to find the correct one
- Entity states can be `unavailable` or `unknown` — do not interpret these as readings
- For lights, brightness is 0-255 in the HA API (not a percentage)
- Always confirm destructive actions with the user (e.g. opening garage door)
