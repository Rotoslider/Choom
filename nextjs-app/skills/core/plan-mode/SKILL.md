---
name: plan-mode
description: Create, execute, and adjust structured multi-step plans. Use when a task requires multiple tool calls in sequence with dependency tracking and error handling.
version: 1.0.0
author: system
tools:
  - create_plan
  - execute_plan
  - adjust_plan
dependencies: []
---

# Plan Mode

## When to Use
- Complex multi-step tasks -> `create_plan` first, then `execute_plan`
- Research + write workflows -> plan steps with dependencies
- Task failed mid-plan -> `adjust_plan` to modify remaining steps
- Any task requiring 3+ tool calls with ordering constraints

## How It Works
1. **create_plan**: Define a goal and ordered steps. Each step references a tool by name with arguments. Use `dependsOn` to express ordering. Use `{{step_N.result.field}}` to reference previous step outputs.
2. **execute_plan**: Runs the plan step-by-step. A watcher evaluates each step result and decides: continue, retry, skip, or abort. Streams progress events.
3. **adjust_plan**: If a step fails during execution, modify remaining steps (change args, skip steps, or add new steps).

## Important
- Maximum 10 steps per plan
- Tool names must exist in the skill registry
- Plans live in memory for the current request only
- Execute sends `plan_step_update` SSE events for real-time progress
