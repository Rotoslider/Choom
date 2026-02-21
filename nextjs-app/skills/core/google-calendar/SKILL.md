---
name: google-calendar
description: Manages Google Calendar events — view upcoming/past events, create, update, and delete events. Use when asking about schedule, appointments, or meetings.
version: 1.0.0
author: system
tools:
  - get_calendar_events
  - create_calendar_event
  - update_calendar_event
  - delete_calendar_event
dependencies: []
---

# Google Calendar

## When to Use
- View schedule → `get_calendar_events`
- Past events → `get_calendar_events` with `days_back`
- Create event → `create_calendar_event`
- Reschedule → `get_calendar_events` first (get event_id), then `update_calendar_event`
- Cancel event → `get_calendar_events` first (get event_id), then `delete_calendar_event`

## Important
- Timezone: America/Denver
- All-day events: use date-only format for start_time
- Default end_time: 1 hour after start
- Always get event_id from get_calendar_events before update/delete
