---
name: plan-mode
description: Create, execute, and adjust structured multi-step plans. Use when a task requires multiple tool calls in sequence with dependency tracking and error handling. Supports delegation to other Chooms.
version: 1.1.0
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
- Multi-Choom collaboration -> delegate steps to specialist Chooms
- Task failed mid-plan -> `adjust_plan` to modify remaining steps
- Any task requiring 3+ tool calls with ordering constraints

## How It Works
1. **create_plan**: Define a goal and ordered steps. Each step is either a `tool` step (calls a tool directly) or a `delegate` step (sends a task to another Choom). Use `dependsOn` to express ordering. Use `{{step_N.result.field}}` to reference previous step outputs.
2. **execute_plan**: Runs the plan step-by-step. Delegate steps are routed through `delegate_to_choom` automatically. A watcher evaluates each step result and decides: continue, retry, skip, or abort. Streams progress events.
3. **adjust_plan**: If a step fails during execution, modify remaining steps (change args, skip steps, or add new steps).

## Step Types

### Tool Steps (type: "tool")
Standard tool calls routed through the skill registry:
```json
{ "id": "step_1", "type": "tool", "toolName": "web_search", "args": { "query": "..." } }
```

### Delegate Steps (type: "delegate")
Send a task to another Choom and get their response:
```json
{ "id": "step_2", "type": "delegate", "choomName": "Genesis", "task": "Research the topic and summarize findings", "dependsOn": ["step_1"] }
```

## Important
- Maximum 10 steps per plan
- Tool names must exist in the skill registry
- Delegate steps require choom-delegation skill to be enabled
- Use `{{step_N.result.response}}` to reference a delegation result's text content
- Plans live in memory for the current request only
- Execute sends `plan_step_update` SSE events for real-time progress
