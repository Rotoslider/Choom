---
name: memory-management
description: Stores, searches, and manages per-Choom semantic memories using ChromaDB. Use when remembering information, recalling past conversations, or managing stored facts/preferences.
version: 1.0.0
author: system
tools:
  - remember
  - search_memories
  - search_by_type
  - search_by_tags
  - search_by_date_range
  - get_recent_memories
  - update_memory
  - delete_memory
  - get_memory_stats
dependencies: []
---

# Memory Management

## When to Use
- User asks to remember something → `remember`
- User asks "do you remember..." → `search_memories`
- User asks about memory stats → `get_memory_stats`
- User asks about recent conversations → `get_recent_memories`
- User asks for specific category → `search_by_type`
- User mentions specific topics/tags → `search_by_tags`
- User asks to correct stored info → `update_memory`
- User explicitly asks to forget → `delete_memory`

## Important
- Each Choom has isolated memories via companion_id
- Memory types: conversation, fact, preference, event, task, ephemeral
- Tags are comma-separated strings
- Importance ranges 1-10 (default 5)

## Tagging Followups & Open Loops

When you save a memory that represents an *unresolved thread* — something that may need a nudge or revisit on a future day — tag it `followup`.

Use `followup` when the memory captures one of:
- Waiting on someone (response, decision, delivery, callback)
- A decision Donny is "percolating on" but hasn't committed to
- Something you or Donny said you'd revisit later ("let me think about it", "ask me again next week")
- A blocked task — can't proceed until X happens
- A promise made ("I'll get back to you on that")
- A research thread paused mid-investigation

Do NOT tag `followup` when:
- The item already exists as a calendar event (calendar surfaces it)
- The item already exists as a reminder (reminders surface it)
- It's a completed action — no followup needed
- It's a transient observation with no owed action ("Donny seemed tired today")
- It's a `relationship` memory about emotional patterns — those have their own type

### Examples

Save with `followup`:
- title: "Waiting on Eve's CAD review of articulated feet"
  tags: "followup, lizard-robot, blocked"
  memory_type: "task"
- title: "Donny percolating on Lizard battery placement — spine vs. legs"
  tags: "followup, design-decision, lizard-robot"
  memory_type: "task"
- title: "Promised to send shopping list once specs are confirmed"
  tags: "followup, owed-action"
  memory_type: "task"

Do NOT save with `followup`:
- title: "Donny prefers his coffee black"
  tags: "preference"   ← stable preference, nothing to follow up
- title: "Discussed consciousness architecture today"
  tags: "conversation"   ← reflection, not an open loop

### Sub-tags (optional, layer with `followup`)
- `blocked` — can't proceed until something external happens
- `owed-action` — *I* (the Choom) owe a deliverable
- `decision-pending` — Donny needs to decide
- `research-paused` — investigation suspended mid-thread

Keep `followup` items concise and action-oriented in the title. The morning briefing may pull these to surface to Donny — write them so a one-line read makes the open loop obvious.
