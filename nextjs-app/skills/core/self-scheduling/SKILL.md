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
- `at` (preferred): the wall-clock time you want it to fire, in **Donny's local (Mountain) time** — just say the time, no math. Accepts "2026-06-26 2:05pm", "June 26 at 14:05", "tomorrow 9am", or a bare "2:05pm" (next time it's that o'clock today/tomorrow). The current local time is at the top of your context, so you can read off the date.
- `delay_minutes` (alternative to `at`): minutes from now. Clamped to [15, 43200] (15 min → 30 days). Only use this if you genuinely want a relative interval; otherwise prefer `at`.
- Provide **either** `at` **or** `delay_minutes` (plus `prompt`). If you give neither, the call is rejected.
- `prompt` (required): what to tell future-you when the followup fires. Write it as a message TO yourself, third-person is fine. Example: "Ask Donny how the house work went yesterday — he mentioned finishing around 6pm and was worried about the heat."
- `reason` (optional): one-line log note for the Doctor. Example: "checking on yesterday's house project".

## TIME (CRITICAL)
- All scheduling is **Donny's local time (Mountain Time)**, NOT UTC. The current time at the top of your context is already in his local timezone — work from that.
- **Easiest path: use `at` and name the target wall-clock time directly.** "Wake me June 26th at 2:05pm" → `at: "June 26 2:05pm"`. The handler does the timezone conversion; you do NO minutes math. This avoids the local-vs-UTC mistakes.
- When you label a prompt with "morning"/"midday"/"evening", that label must match Donny's wall clock when the followup fires. Example: "evening reflection" should fire ~18:00–22:00 his time.
- Minimum lead time is **15 minutes** — a time sooner than that is bumped to 15 min out (the response says so).
- The tool response includes `trigger_at_local` — read it back. If it says "Sat, Apr 25, 5:08 AM MDT" but your prompt says "evening reflection", the time is wrong; cancel and re-queue.

## Limits (safety contract)
- **Concurrent pending cap: 100 per Choom.** This is a hard ceiling on how many UN-FIRED followups you can have queued at once — it is NOT a daily or per-request quota. Once a followup fires (or you cancel it with `cancel_self_followup`), its slot frees up immediately and you can schedule another. So 3/day × 30 days = 90 pending is fine; you'd still have room for 10 more ad-hoc followups on top of the schedule.
- Each Choom has its own independent counter. Eve's 100 does not affect Genesis's 100.
- Fire time is clamped to [15 min, 30 days] from now. Sooner is bumped to 15 min; later is rejected/capped.
- The prompt is capped at 1000 chars — be concise.
- If you hit the cap, use `list_self_followups` to review what you have, cancel stale ones, or wait until some fire. Do not retry the same schedule call in a loop.

## How it runs
- When the followup fires, you will receive it as a heartbeat-style prompt. You are free to call tools, save a memory, send a notification to Donny, or do nothing — same as any heartbeat.
- It does NOT automatically notify Donny. If you want to ping him, include that instruction in the prompt and call `send_notification` when the followup runs.
