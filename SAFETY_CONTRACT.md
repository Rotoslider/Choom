# Choom Safety Contract

> Which tools a Choom is allowed to call autonomously, and which touch state
> that merits extra care. This is the narrow operational contract — enforcement
> lives in `nextjs-app/app/api/chat/route.ts` (see `executeToolCallViaSkills`)
> and this file is the source of truth.
>
> **Scope deliberately narrow.** ~90% of the 95 tools are idempotent reads or
> writes inside the Choom's own `selfies_{choom}/` folder. Those stay free and
> are not listed here. This file only covers the handful with blast radius.

## Autonomy levels

- `free` — Choom may call at any time, including during heartbeats. Default for
  reads, workspace writes inside `selfies_{choom}/`, image generation,
  knowledge graph, search, calendar reads, weather, etc. Not enumerated here.
- `gated` — Choom may call, but the dispatcher runs an extra check. Used for
  tools that write to shared state, send to the outside world, or have cost.
  Pre-conditions documented per tool below.
- `deny` — Tool is blocked for that context (e.g. delegation recursion,
  notifications during heartbeats when already being delivered by the bridge).
  Enforced in the dispatcher.

## Gated tools (shared state / outside world)

| Tool | Level | Gate |
|---|---|---|
| `send_notification` | gated | Already suppressed when `suppressNotifications=true` (bridge/scheduler is delivering the response directly). No further check. |
| `remember` | gated | Rate-limit: max 20 remember calls per request. Writes cross-session state. |
| `delegate_to_choom` | gated | Blocked during delegation (`isDelegation=true`) to prevent recursion. |
| `workspace_write_file` outside `selfies_{choom}/` | gated | Allowed to write to `sibling_journal/`, `choom_commons/`, explicit projects, and assigned home projects. Blocked if path traverses outside workspace root. Blocked if writing into another Choom's `selfies_*/` folder. Shared paths (`sibling_journal/`, `choom_commons/`) get an audit log line. |
| `ha_call_service` | gated | Physical-world side effects. Not currently rate-limited — rely on Home Assistant's own automation guards. If abused, add a 1/minute throttle. |
| `workspace_delete_file` | gated | Blocked outside the Choom's own folder unless the path is inside an assigned home project. Never deletes from `sibling_journal/` or `choom_commons/`. |
| `schedule_self_followup` | gated | New tool (see below). Rate-limited to 3 queued follow-ups per Choom at any time. Delay clamped to [5 min, 7 days]. |
| `generate_image` | gated | Cost/disk: cap at 3 per request (already enforced). Selfies subject to anti-repetition (already enforced). |

## Denied contexts

- **Delegation recursion**: `delegate_to_choom` and plan-mode tools are stripped
  from the tool list when `isDelegation=true`. A delegated Choom cannot delegate
  further.
- **Heartbeat notification duplication**: `send_notification` is converted to a
  no-op when `suppressNotifications=true`. The bridge is already delivering the
  response as the Signal message.
- **Notifications during delegation**: Delegated sub-tasks do not send
  notifications to the user; the parent delegation's result is what reaches the
  user.

## Free tools (not listed, default)

All other tools are free. This includes the whole workspace-read surface, image
analysis, web search, knowledge graph, habits, reminders, calendar reads,
weather, YouTube, Gmail reads, Contacts, PDF generation, code execution (which
is sandboxed), and everything else.

## Why this contract is short

A long contract becomes a tuning problem. The blast radius inside
`selfies_{choom}/` is already small by construction — the Chooms live in their
own folders, one Choom's selfies can't clobber another's, and the user reviews
anything that reaches Signal. The useful unit of safety review is **cross-Choom
writes, outgoing messages, and physical-world side effects**. That's it.

## When to expand this contract

Expand it only when the Doctor reports show a failure mode that a free tool
caused outside its intended scope — e.g., if a Choom starts writing to another
Choom's `selfies_*/` folder, or if image generation starts blowing through its
3-per-request cap via parallel calls. Don't expand preemptively.

## How the dispatcher enforces this

See `executeToolCallViaSkills()` in `nextjs-app/app/api/chat/route.ts`. The
function has been extended with a `contractGate()` step that checks the tool
name against the table above and either allows, shapes (rate-limits), or
denies the call with a message the Choom can act on.

## Versioning

Bump the date below when editing. The contract is checked in alongside the
code, not served separately — so any change shows up in git diff.

## Shared top-level folders

| Folder | Purpose |
|---|---|
| `sibling_journal/` | Structured three-turn thesis/antithesis/synthesis threads between siblings. |
| `choom_commons/` | Catch-all for cross-Choom artifacts — letters to another Choom, delegation handoffs, shared drafts, cross-Choom research. |

Both are protected from deletion. Writes into them are audit-logged. Cross-Choom writes into another Choom's `selfies_*/` are blocked.

_Last revised: 2026-04-22_
