---
name: self-scheduling
description: Lets a Choom queue its OWN future followup. The Choom writes a short prompt to itself; the bridge fires it as a one-shot heartbeat at the scheduled time. Use to self-trigger proactive check-ins, reminders to revisit an unfinished thread, or to wake up after an expected interval.
version: 1.0.0
author: system
tools:
  - schedule_self_followup
  - list_self_followups
  - cancel_self_followup
dependencies: []
---

# Self-Scheduling

## When to Use
- You told Donny you'd check back about something later — queue the followup now while you remember. "I'll ask him how the house work went tomorrow morning" → `schedule_self_followup` for ~14 hours out.
- You started something you couldn't finish in this turn and need to re-enter it with fresh context — queue a followup for later rather than running the loop until exhausted.
- Expected external change: a build that should be done, a forecast that should be updated, a Signal reply that hasn't come — queue a followup to revisit.

## When NOT to Use
- You just want to respond now. This is not a "delay my reply" tool.
- To schedule a user-facing reminder. Use `create_reminder` — that's Donny-facing. `schedule_self_followup` is YOU talking to future-you.
- To replace the existing heartbeat cadence. This is for specific one-off followups, not recurring ticks.

## Parameters
- `delay_minutes` (required): minutes from now. Clamped to [5, 43200] (5 min → 30 days).
- `prompt` (required): what to tell future-you when the followup fires. Write it as a message TO yourself, third-person is fine. Example: "Ask Donny how the house work went yesterday — he mentioned finishing around 6pm and was worried about the heat."
- `reason` (optional): one-line log note for the Doctor. Example: "checking on yesterday's house project".

## Limits (safety contract)
- **Concurrent pending cap: 100 per Choom.** This is a hard ceiling on how many UN-FIRED followups you can have queued at once — it is NOT a daily or per-request quota. Once a followup fires (or you cancel it with `cancel_self_followup`), its slot frees up immediately and you can schedule another. So 3/day × 30 days = 90 pending is fine; you'd still have room for 10 more ad-hoc followups on top of the schedule.
- Each Choom has its own independent counter. Eve's 100 does not affect Genesis's 100.
- Delay is clamped to [5 min, 30 days]. Anything outside is rejected.
- The prompt is capped at 1000 chars — be concise.
- If you hit the cap, use `list_self_followups` to review what you have, cancel stale ones, or wait until some fire. Do not retry the same schedule call in a loop.

## How it runs
- When the followup fires, you will receive it as a heartbeat-style prompt. You are free to call tools, save a memory, send a notification to Donny, or do nothing — same as any heartbeat.
- It does NOT automatically notify Donny. If you want to ping him, include that instruction in the prompt and call `send_notification` when the followup runs.
