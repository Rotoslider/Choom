# Conditional Triggers Guide

Make your automations smarter by adding conditions. Instead of running blindly on a schedule, automations can check real-world conditions first — weather, time, day of week, calendar events — and only execute when those conditions are met.

---

## Table of Contents

1. [Overview](#overview)
2. [How Conditions Work](#how-conditions-work)
3. [Condition Types](#condition-types)
   - [Weather Conditions](#weather-conditions)
   - [Time Range Conditions](#time-range-conditions)
   - [Day of Week Conditions](#day-of-week-conditions)
   - [Calendar Conditions](#calendar-conditions)
4. [Combining Conditions (AND / OR)](#combining-conditions-and--or)
5. [Cooldown](#cooldown)
6. [Setting Up Conditions in the UI](#setting-up-conditions-in-the-ui)
7. [Examples](#examples)
   - [Freeze Warning Alert](#example-1-freeze-warning-alert)
   - [Weekday Morning Briefing](#example-2-weekday-morning-briefing)
   - [Meeting Prep Automation](#example-3-meeting-prep-automation)
   - [Wind Alert for Outdoor Work](#example-4-wind-alert-for-outdoor-work)
   - [Weekend Project Reminder](#example-5-weekend-project-reminder)
   - [Hot Weather Plant Watering Reminder](#example-6-hot-weather-plant-watering-reminder)
   - [Business Hours Calendar Check](#example-7-business-hours-calendar-check)
   - [Evening Humidity Alert](#example-8-evening-humidity-alert)
8. [How It Works Under the Hood](#how-it-works-under-the-hood)
9. [Troubleshooting](#troubleshooting)

---

## Overview

Conditional triggers add an "if" to your automations. Without conditions, an automation fires every time its schedule triggers. With conditions, the automation checks one or more criteria first:

- **Without conditions**: "Every day at 7 AM, send me a weather summary" (runs every day)
- **With conditions**: "Every day at 7 AM, **if the temperature is below 32°F**, send me a freeze warning" (only runs on cold days)

Conditions are evaluated by the Python scheduler at the moment the automation is scheduled to run. If conditions aren't met, the automation is silently skipped — no notification, no error. It simply waits for the next scheduled run.

---

## How Conditions Work

When an automation with conditions reaches its scheduled time:

1. **Cooldown check** — If a cooldown is set and the automation fired recently, skip immediately
2. **Condition evaluation** — Each condition is evaluated independently (weather API call, time check, calendar lookup, etc.)
3. **Logic application** — Results are combined using AND (all must pass) or OR (any must pass)
4. **Execute or skip** — If the combined result is `true`, the automation runs. If `false`, it skips silently
5. **Timestamp update** — If the automation fires, the `lastConditionMet` timestamp is updated for cooldown tracking

Automations with **no conditions** always run (preserving the original behavior).

---

## Condition Types

### Weather Conditions

Check current weather data against a threshold. The weather data comes from your configured OpenWeatherMap integration (same data your Choom uses for weather forecasts).

| Field | What It Measures | Typical Range |
|-------|-----------------|---------------|
| `temperature` | Current temperature in your configured units (°F or °C) | -20 to 120°F |
| `windSpeed` | Current wind speed (mph or km/h based on your units) | 0 to 100+ |
| `humidity` | Relative humidity percentage | 0 to 100% |

**Operators**: `<` (less than), `>` (greater than), `<=` (less than or equal), `>=` (greater than or equal)

#### Weather Condition Examples

| Scenario | Field | Operator | Value | Meaning |
|----------|-------|----------|-------|---------|
| Freeze warning | temperature | < | 32 | Fires when temp drops below freezing |
| Heat alert | temperature | > | 100 | Fires on extremely hot days |
| High wind | windSpeed | > | 25 | Fires when winds exceed 25 mph |
| Very humid | humidity | >= | 85 | Fires during muggy conditions |
| Mild weather | temperature | >= | 60 | Fires when it's at least 60°F |

**How it fetches data**: The scheduler calls the same weather endpoint your Choom uses (`/api/weather`). The data is cached for 30 minutes, so rapid condition checks don't spam the OpenWeatherMap API.

---

### Time Range Conditions

Check whether the current time falls within a specified window. Useful for restricting automations to business hours, daytime only, or evening hours.

| Field | Format | Description |
|-------|--------|-------------|
| `after` | HH:MM (24-hour) | Start of the allowed time window |
| `before` | HH:MM (24-hour) | End of the allowed time window |

**Overnight ranges are supported**: Setting `after: 22:00` and `before: 06:00` means "from 10 PM to 6 AM" (crosses midnight).

#### Time Range Examples

| Scenario | After | Before | When It Passes |
|----------|-------|--------|----------------|
| Business hours | 09:00 | 17:00 | 9 AM to 5 PM |
| Daytime only | 06:00 | 22:00 | 6 AM to 10 PM |
| Morning window | 06:00 | 09:00 | 6 AM to 9 AM |
| Evening only | 18:00 | 23:00 | 6 PM to 11 PM |
| Overnight (graveyard) | 22:00 | 06:00 | 10 PM to 6 AM (crosses midnight) |
| Lunch hour | 11:30 | 13:00 | 11:30 AM to 1 PM |

---

### Day of Week Conditions

Check whether today is one of the allowed days. Uses JavaScript day numbering (Sunday = 0, Saturday = 6).

| Day | Number |
|-----|--------|
| Sunday | 0 |
| Monday | 1 |
| Tuesday | 2 |
| Wednesday | 3 |
| Thursday | 4 |
| Friday | 5 |
| Saturday | 6 |

Select one or more days. If no days are selected, the condition always passes (same as no condition).

#### Day of Week Examples

| Scenario | Days | Numbers |
|----------|------|---------|
| Weekdays only | Mon-Fri | [1, 2, 3, 4, 5] |
| Weekends only | Sat-Sun | [0, 6] |
| MWF schedule | Mon, Wed, Fri | [1, 3, 5] |
| Tuesdays and Thursdays | Tue, Thu | [2, 4] |
| Every day except Sunday | Mon-Sat | [1, 2, 3, 4, 5, 6] |

---

### Calendar Conditions

Check your Google Calendar for events today. Requires Google Calendar to be connected (OAuth2 with Calendar scope).

| Field | Type | Description |
|-------|------|-------------|
| `has_events` | boolean | `true` = must have events today; `false` = must have no events |
| `keyword` | string | Only match events whose title contains this text (case-insensitive) |

**Priority**: If `keyword` is set, it takes precedence over `has_events`. The condition checks whether any event today contains the keyword in its title.

#### Calendar Condition Examples

| Scenario | has_events | keyword | When It Passes |
|----------|-----------|---------|----------------|
| Busy day | true | — | Any events exist on today's calendar |
| Free day | false | — | No events on today's calendar |
| Has a meeting | — | "meeting" | Any event with "meeting" in the title |
| Has a standup | — | "standup" | Any event with "standup" in the title |
| Doctor appointment | — | "doctor" | Any event with "doctor" in the title |

---

## Combining Conditions (AND / OR)

When you add multiple conditions to an automation, you choose how they combine:

### ALL (AND Logic) — Default

Every condition must be true for the automation to run. Use this when all criteria matter.

**Example**: "Only run if temperature is below 32°F **AND** it's between 6 AM and 10 PM"

- Condition 1: Weather — temperature < 32 ✅
- Condition 2: Time Range — 06:00 to 22:00 ✅
- **Result**: Both true → automation runs ✅

If it's below 32°F but it's 3 AM:
- Condition 1: Weather — temperature < 32 ✅
- Condition 2: Time Range — 06:00 to 22:00 ❌
- **Result**: Not all true → automation skips ❌

### ANY (OR Logic)

At least one condition must be true. Use this when any single trigger should fire the automation.

**Example**: "Run if temperature is above 100°F **OR** wind speed is above 40 mph"

- Condition 1: Weather — temperature > 100 ❌ (it's 85°F)
- Condition 2: Weather — windSpeed > 40 ✅ (50 mph gusts)
- **Result**: At least one true → automation runs ✅

### Choosing AND vs OR

| Use AND when... | Use OR when... |
|----------------|----------------|
| All conditions must align | Any one condition is enough to act |
| Narrowing down specific scenarios | Watching for multiple independent triggers |
| "Only during business hours on weekdays" | "Alert on extreme heat or extreme cold" |
| "If meeting AND it's morning" | "If high wind OR low temperature" |

---

## Cooldown

Cooldown prevents an automation from firing repeatedly in rapid succession. After conditions are met and the automation executes, it won't fire again until the cooldown period expires — even if conditions are still met at the next scheduled check.

### How Cooldown Works

1. Automation is scheduled to check every 30 minutes
2. At 8:00 AM, conditions are met → automation fires
3. Cooldown is set to 360 minutes (6 hours)
4. At 8:30 AM, conditions are still met → **skipped** (cooldown active until 2:00 PM)
5. At 9:00 AM, conditions are still met → **skipped**
6. At 2:30 PM, conditions are checked again → cooldown expired → if conditions met, fires again

### Cooldown Values

| Minutes | Duration | Good For |
|---------|----------|----------|
| 0 | No cooldown | Always check (every scheduled run) |
| 60 | 1 hour | Frequent monitoring (stock prices, server checks) |
| 120 | 2 hours | Moderate monitoring (weather alerts) |
| 360 | 6 hours | Twice-daily notifications |
| 720 | 12 hours | Twice-daily maximum |
| 1440 | 24 hours | Once-daily maximum |

### Example: Why Cooldown Matters

Without cooldown, a "temperature below 32°F" condition checked every 30 minutes would send you a freeze warning **every 30 minutes** all night long during a cold snap. With a 6-hour cooldown, you get warned once in the evening and once in the morning — practical without being annoying.

---

## Setting Up Conditions in the UI

### Step-by-Step

1. Open **Settings > Automations**
2. Click **Create Automation** (or edit an existing one)
3. Scroll down to the **Conditions** section (between Description and Schedule)
4. Click **Add Condition**
5. Select a condition type from the dropdown
6. Fill in the type-specific fields:
   - **Weather**: Choose field (temperature/windSpeed/humidity), operator (<, >, <=, >=), and threshold value
   - **Time Range**: Enter start time (After) and end time (Before) in HH:MM format
   - **Day of Week**: Check the boxes for allowed days
   - **Calendar**: Toggle "Has events" or enter a keyword to match
7. (Optional) Add more conditions by clicking **Add Condition** again
8. If you have 2+ conditions, select the logic: **ALL must match** or **ANY must match**
9. (Optional) Set a **Cooldown** in minutes
10. Configure the rest of the automation (steps, schedule, target Choom) and save

### UI Layout

```
[Conditions]
  Logic: [ALL must match ▼]

  ┌─────────────────────────────────────┐
  │ Condition 1: [Weather ▼]            │
  │   Field: [temperature ▼]            │
  │   Operator: [< ▼]                   │
  │   Value: [32]                       │
  │                          [Remove ✕] │
  └─────────────────────────────────────┘

  ┌─────────────────────────────────────┐
  │ Condition 2: [Time Range ▼]         │
  │   After: [06:00]                    │
  │   Before: [22:00]                   │
  │                          [Remove ✕] │
  └─────────────────────────────────────┘

  [+ Add Condition]

  Cooldown: [360] minutes (0 = no cooldown)
```

### Condition Badges on Automation Cards

Once conditions are set, the automation list shows a filter badge with a summary:

```
Daily Freeze Warning          [Enabled ✓]  🔄 Filter
  ⏰ Every day at 06:00 → MyChoom
  📊 Steps: get_weather → send_notification
  🔍 temperature < 32, 06:00–22:00
```

---

## Examples

### Example 1: Freeze Warning Alert

**Goal**: Get a Signal notification when it's freezing during waking hours. Don't spam — once every 6 hours is enough.

| Setting | Value |
|---------|-------|
| **Name** | Freeze Warning |
| **Schedule** | Every 30 minutes (interval mode) |
| **Condition 1** | Weather: temperature < 32 |
| **Condition 2** | Time Range: 06:00 to 22:00 |
| **Logic** | ALL must match |
| **Cooldown** | 360 minutes (6 hours) |
| **Steps** | 1. `get_weather` → 2. `send_notification` (message: "🥶 Freeze warning! Current temp: {{prev.result.formatted}}") |
| **Target Choom** | MyChoom |

**How it behaves**:
- Checks every 30 minutes
- If it's 28°F at 7:00 AM → conditions met → sends notification → cooldown starts
- At 7:30 AM, still 28°F → cooldown active → skips
- At 1:00 PM (cooldown expired), temp is 45°F → weather condition not met → skips
- At 6:00 PM, temp drops to 30°F → conditions met → sends notification again

---

### Example 2: Weekday Morning Briefing

**Goal**: Enhanced morning briefing that only runs on weekdays.

| Setting | Value |
|---------|-------|
| **Name** | Weekday Morning Brief |
| **Schedule** | Daily at 07:00 (cron mode) |
| **Condition 1** | Day of Week: Mon, Tue, Wed, Thu, Fri [1,2,3,4,5] |
| **Logic** | ALL (only one condition, logic doesn't matter) |
| **Cooldown** | 0 (runs once daily anyway) |
| **Steps** | 1. `get_weather` → 2. `get_calendar_events` (days_ahead: 1) → 3. `send_notification` (summary) |
| **Target Choom** | MyChoom |

**How it behaves**:
- Monday 7:00 AM → day_of_week check → Monday is day 1 → ✅ runs
- Saturday 7:00 AM → day_of_week check → Saturday is day 6, not in [1,2,3,4,5] → ❌ skips
- Sunday 7:00 AM → day_of_week check → Sunday is day 0, not in list → ❌ skips

---

### Example 3: Meeting Prep Automation

**Goal**: When there's a meeting today, search recent emails for agendas and send a prep summary. Only on weekdays during morning hours.

| Setting | Value |
|---------|-------|
| **Name** | Meeting Prep |
| **Schedule** | Daily at 08:00 |
| **Condition 1** | Calendar: keyword = "meeting" |
| **Condition 2** | Day of Week: Mon-Fri [1,2,3,4,5] |
| **Logic** | ALL must match |
| **Cooldown** | 720 (12 hours — once per morning) |
| **Steps** | 1. `get_calendar_events` (days_ahead: 0) → 2. `search_emails` (query: "meeting agenda") → 3. `send_notification` (message: "Meeting prep: {{step_1.result.formatted}}\n\nRecent emails: {{prev.result.formatted}}") |
| **Target Choom** | MyChoom |

**How it behaves**:
- Tuesday 8:00 AM, "Team Standup Meeting" on calendar → calendar keyword "meeting" matches → weekday check passes → runs meeting prep
- Tuesday 8:00 AM, only "Dentist Appointment" on calendar → "meeting" not in title → skips
- Saturday 8:00 AM → weekday check fails → skips regardless of calendar

---

### Example 4: Wind Alert for Outdoor Work

**Goal**: Alert when wind speeds are dangerously high for outdoor work.

| Setting | Value |
|---------|-------|
| **Name** | High Wind Alert |
| **Schedule** | Every 60 minutes |
| **Condition 1** | Weather: windSpeed > 30 |
| **Condition 2** | Time Range: 07:00 to 18:00 |
| **Logic** | ALL must match |
| **Cooldown** | 180 (3 hours) |
| **Steps** | 1. `get_weather` → 2. `send_notification` (message: "⚠️ High winds detected! {{prev.result.formatted}} — Consider postponing outdoor work.") |
| **Target Choom** | MyChoom |

---

### Example 5: Weekend Project Reminder

**Goal**: On weekends, remind about personal projects.

| Setting | Value |
|---------|-------|
| **Name** | Weekend Project Nudge |
| **Schedule** | Daily at 10:00 |
| **Condition 1** | Day of Week: Sat, Sun [0, 6] |
| **Logic** | ALL |
| **Cooldown** | 0 |
| **Steps** | 1. `workspace_list_files` (project: "Weekend Projects") → 2. `send_notification` (message: "Weekend project time! Here's what's in your project folder: {{prev.result.formatted}}") |
| **Target Choom** | MyChoom |

---

### Example 6: Hot Weather Plant Watering Reminder

**Goal**: When it's very hot, send a reminder to water the plants. Only during daytime.

| Setting | Value |
|---------|-------|
| **Name** | Plant Water Reminder |
| **Schedule** | Every 120 minutes |
| **Condition 1** | Weather: temperature > 95 |
| **Condition 2** | Time Range: 08:00 to 20:00 |
| **Logic** | ALL must match |
| **Cooldown** | 480 (8 hours) |
| **Steps** | 1. `send_notification` (message: "🌡️ It's over 95°F outside — don't forget to water the plants!") |
| **Target Choom** | MyChoom |

---

### Example 7: Business Hours Calendar Check

**Goal**: During business hours, if your calendar is free, suggest scheduling focus time.

| Setting | Value |
|---------|-------|
| **Name** | Focus Time Suggestion |
| **Schedule** | Daily at 09:30 |
| **Condition 1** | Calendar: has_events = false |
| **Condition 2** | Day of Week: Mon-Fri [1,2,3,4,5] |
| **Logic** | ALL must match |
| **Cooldown** | 1440 (24 hours) |
| **Steps** | 1. `send_notification` (message: "Your calendar is clear today — great opportunity for deep focus work!") |
| **Target Choom** | MyChoom |

**How it behaves**:
- If calendar is empty on a weekday → reminds you to use the time wisely
- If you have meetings → condition fails → no notification

---

### Example 8: Evening Humidity Alert

**Goal**: Alert in the evening when humidity is high (close windows).

| Setting | Value |
|---------|-------|
| **Name** | Humidity Window Alert |
| **Schedule** | Daily at 19:00 |
| **Condition 1** | Weather: humidity >= 80 |
| **Logic** | ALL |
| **Cooldown** | 720 (12 hours) |
| **Steps** | 1. `get_weather` → 2. `send_notification` (message: "💧 Humidity is at {{step_1.result.current.humidity}}% — consider closing windows tonight.") |
| **Target Choom** | MyChoom |

---

## How It Works Under the Hood

### Architecture

```
Scheduled Time Reached
        │
        ▼
┌──────────────────┐
│  Cooldown Check   │ ── cooldown active → SKIP
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Evaluate Each    │
│  Condition        │
│  ┌──────────────┐ │
│  │ Weather API  │ │  ← calls /api/weather (30min cache)
│  │ Time Check   │ │  ← pure datetime comparison
│  │ Day Check    │ │  ← pure datetime comparison
│  │ Calendar API │ │  ← calls Google Calendar
│  └──────────────┘ │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Apply Logic      │
│  ALL = every true │
│  ANY = one true   │
└────────┬─────────┘
         │
    true │  false
         │     └──→ SKIP (silent)
         ▼
┌──────────────────┐
│  Update Timestamp │ ← lastConditionMet = now
│  Execute Steps    │
└──────────────────┘
```

### Key Files

| File | Role |
|------|------|
| `services/signal-bridge/scheduler.py` | Condition evaluation logic (`_evaluate_conditions`, `_evaluate_single_condition`, type-specific evaluators) |
| `components/settings/automation-builder.tsx` | Condition editor UI (`ConditionEditor` component) |
| `components/settings/automation-list.tsx` | Condition display on automation cards |
| `components/settings/automations-settings.tsx` | Automation TypeScript interface with condition types |
| `services/signal-bridge/bridge-config.json` | Persistent storage for automation conditions and cooldown state |

### Data Format (bridge-config.json)

```json
{
  "automations": [
    {
      "id": "auto_1707890400000",
      "name": "Freeze Warning",
      "enabled": true,
      "conditions": [
        {
          "id": "cond_1",
          "type": "weather",
          "field": "temperature",
          "op": "<",
          "value": 32
        },
        {
          "id": "cond_2",
          "type": "time_range",
          "after": "06:00",
          "before": "22:00"
        }
      ],
      "conditionLogic": "all",
      "cooldown": { "minutes": 360 },
      "lastConditionMet": "2026-02-14T07:00:12.345678",
      "steps": [...],
      "schedule": { "type": "interval", "minutes": 30 },
      "choomName": "MyChoom"
    }
  ]
}
```

### Condition Type Schema

```typescript
interface AutomationCondition {
  id: string;
  type: 'weather' | 'time_range' | 'day_of_week' | 'calendar' | 'no_condition';

  // Weather-specific
  field?: 'temperature' | 'windSpeed' | 'humidity';
  op?: '<' | '>' | '<=' | '>=';
  value?: number;

  // Time range-specific
  after?: string;   // "HH:MM"
  before?: string;  // "HH:MM"

  // Day of week-specific
  days?: number[];  // [0-6] where 0=Sunday

  // Calendar-specific
  has_events?: boolean;
  keyword?: string;
}
```

---

## Troubleshooting

### Condition isn't triggering

1. **Check the weather data**: Ask your Choom "What's the weather?" to verify current temperature/wind/humidity values match what you expect
2. **Check the time**: Make sure your server's timezone matches your expectation. The scheduler uses the system clock
3. **Check the calendar**: Ask your Choom "What's on my calendar today?" to verify events are visible
4. **Check cooldown**: If the automation ran recently, it might be in cooldown. Look at `lastConditionMet` in bridge-config.json
5. **Check the schedule**: The condition is only evaluated when the schedule triggers. If the schedule is "daily at 7 AM" and it's 3 PM, the condition won't be checked until tomorrow at 7 AM

### Condition fires when it shouldn't

1. **Check operator direction**: `< 32` means "less than 32" — if it's 30°F, the condition is `true`
2. **Check AND vs OR**: With OR logic, any single true condition fires the automation
3. **Check overnight time ranges**: `after: 22:00, before: 06:00` means 10 PM to 6 AM (crosses midnight) — this is intentional

### Weather condition always fails

1. Verify your OpenWeatherMap API key is configured in Settings > Weather
2. Check that the weather service is responding: visit `/api/weather` in your browser
3. Make sure the field name matches: use `temperature` (not `temp`), `windSpeed` (not `wind_speed`), `humidity`

### Calendar condition always fails

1. Make sure Google Calendar is connected (OAuth2 with Calendar scope)
2. Re-auth if needed: `cd services/signal-bridge && rm google_auth/token.json && ./venv/bin/python3 -c "from google_client import GoogleClient; GoogleClient()"`
3. Restart the bridge: `sudo systemctl restart signal-bridge.service`
4. Keywords are case-insensitive: "Meeting" and "meeting" both match

### Automation runs but doesn't show condition info

Make sure you've updated to the latest UI code. The condition badges and summaries were added to `automation-list.tsx`. If upgrading, restart the Next.js dev server.
