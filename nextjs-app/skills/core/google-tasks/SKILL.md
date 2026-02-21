---
name: google-tasks
description: Manages Google Tasks lists — view available lists, get items, add items, and remove items. Use for task/shopping/to-do list management.
version: 1.0.0
author: system
tools:
  - list_task_lists
  - get_task_list
  - add_to_task_list
  - remove_from_task_list
dependencies: []
---

# Google Tasks

## When to Use
- "What lists do I have?" → `list_task_lists`
- "Show my groceries list" → `get_task_list`
- "Add X to my Y list" → `add_to_task_list`
- "Remove X from my Y list" → `remove_from_task_list`

## Important
- Common list names: groceries, hardware store, to do
- If unsure of exact name, call `list_task_lists` first
- If tool returns "not found", check available list names in error and retry
