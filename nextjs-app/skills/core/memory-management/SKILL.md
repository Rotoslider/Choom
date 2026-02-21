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
