---
name: reminders
description: Creates and retrieves timed reminders delivered via Signal message. Supports specific times (12h/24h format) or relative minutes.
version: 1.0.0
author: system
tools:
  - create_reminder
  - get_reminders
dependencies: []
---

# Reminders

## When to Use
- "Remind me in X minutes" → `create_reminder` with minutes_from_now
- "Remind me at 3pm" → `create_reminder` with time "3:00 PM"
- "Show my reminders" → `get_reminders`
- Reminders for specific date → `get_reminders` with date param

## Important
- Time format: "4:00 PM", "3:30 AM", or "15:00" (with colon)
- Bare times accepted: "4pm", "4 PM"
- If time is in the past today, schedules for next day
- Duplicate detection: similar text + time within ±30 min blocked
- Delivered via Signal message
