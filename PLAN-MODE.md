# Plan Mode Guide

Choom's Plan Mode lets your AI handle complex, multi-step tasks with structure and visibility. Instead of throwing tools at a problem one at a time, Plan Mode creates an explicit step-by-step plan, executes it with error handling, and shows you real-time progress.

---

## Table of Contents

1. [Overview](#overview)
2. [Two Ways Plans Happen](#two-ways-plans-happen)
3. [The Plan Mode Skill (3 Tools)](#the-plan-mode-skill-3-tools)
   - [create_plan](#create_plan)
   - [execute_plan](#execute_plan)
   - [adjust_plan](#adjust_plan)
4. [How Execution Works](#how-execution-works)
5. [Template Variables](#template-variables)
6. [Error Handling and Recovery](#error-handling-and-recovery)
7. [What You See in the Chat UI](#what-you-see-in-the-chat-ui)
8. [Examples](#examples)
   - [Research and Write Report](#example-1-research-and-write-report)
   - [Weather Summary Document](#example-2-weather-summary-document)
   - [Email Digest to Google Doc](#example-3-email-digest-to-google-doc)
   - [Project Status Report](#example-4-project-status-report)
   - [YouTube Research and Notes](#example-5-youtube-research-and-notes)
   - [Contact Lookup and Email Draft](#example-6-contact-lookup-and-email-draft)
   - [Multi-Source Data Collection](#example-7-multi-source-data-collection)
   - [Recovery After Failure](#example-8-recovery-after-failure-adjust_plan)
9. [Automatic vs Explicit Plan Mode](#automatic-vs-explicit-plan-mode)
10. [Limits and Constraints](#limits-and-constraints)
11. [Tips for Better Plans](#tips-for-better-plans)
12. [Troubleshooting](#troubleshooting)

---

## Overview

Plan Mode works like a project checklist for your Choom. Given a complex request, the Choom:

1. **Plans** — Breaks the task into discrete steps, each targeting a specific tool
2. **Executes** — Runs steps one at a time, passing data between them
3. **Watches** — Evaluates each result and decides: continue, retry, skip, or abort
4. **Adjusts** — If something goes wrong, modifies the remaining plan without starting over
5. **Reports** — Summarizes what was accomplished

This is different from the regular agentic loop (where the LLM calls tools one at a time and decides the next action after each result). Plan Mode creates the full plan up front, giving you visibility and enabling smarter error recovery.

---

## Two Ways Plans Happen

### 1. Automatic Detection

When your message contains patterns suggesting a multi-step task, the planner activates automatically:

- "Research solar panels **and write a comparison** document"
- "**First** check the weather, **then** create a calendar event"
- "**Step by step**, compile a report on drone regulations"
- "**Compare** GPU prices **and** create a spreadsheet"
- "**Analyze** my inbox **and then** draft a summary"

Keywords that trigger the planner: "research and write", "compare X and Y", "step by step", "first...then...", "analyze and create", compound instructions with multiple verbs.

### 2. Explicit Plan Mode (via Tools)

The LLM can also call the plan-mode skill tools directly:

1. `create_plan` — Define a goal and steps
2. `execute_plan` — Run the plan
3. `adjust_plan` — Modify remaining steps if something fails

This is useful when:
- The automatic detector doesn't trigger (simple phrasing, but complex task)
- You want the Choom to plan before acting
- You want visibility into exactly what will happen before it runs

---

## The Plan Mode Skill (3 Tools)

### create_plan

Creates a structured execution plan without running it. Returns a `plan_id` for later execution.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `goal` | string | Yes | Brief description of the overall goal |
| `steps` | array | Yes | Array of step objects (max 10) |

**Each step object**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | Yes | What this step does (human-readable) |
| `toolName` | string | Yes | The tool to call (must exist in the skill registry) |
| `args` | object | No | Arguments to pass to the tool |
| `dependsOn` | string[] | No | IDs of steps that must complete first |

**Returns**:
```json
{
  "success": true,
  "plan_id": "plan_1_1707890400000",
  "goal": "Research weather and write summary",
  "steps": [
    { "id": "step_1", "description": "Get current weather", "toolName": "get_weather", "dependsOn": [] },
    { "id": "step_2", "description": "Get 5-day forecast", "toolName": "get_forecast", "dependsOn": [] },
    { "id": "step_3", "description": "Write summary to file", "toolName": "workspace_write_file", "dependsOn": ["step_1", "step_2"] }
  ],
  "warnings": [],
  "message": "Plan created with 3 steps. Use execute_plan with plan_id \"plan_1_1707890400000\" to run it."
}
```

**Validation**:
- Tool names are checked against the skill registry. Unknown tools generate warnings (not errors — the plan is still created)
- Steps are capped at 10 maximum
- Step IDs are auto-assigned if not provided (`step_1`, `step_2`, etc.)

---

### execute_plan

Executes a previously created plan step by step.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan_id` | string | Yes | The plan ID from `create_plan` |

**What happens during execution**:

1. Steps run sequentially (respecting `dependsOn` ordering)
2. Each step dispatches through the skill registry to the appropriate handler
3. After each step, the watcher evaluates the result:
   - **Success** → continue to next step
   - **Error** → retry with parameter fix (max 2 retries), then skip
   - **Timeout** → retry
   - **Missing dependency** → skip (if a step depends on a failed step)
4. Real-time SSE events are sent to the chat UI (`plan_step_update`)

**Returns**:
```json
{
  "success": true,
  "summary": "Plan \"Research and write weather summary\": 3/3 steps succeeded",
  "succeeded": 3,
  "failed": 0,
  "total": 3,
  "steps": [
    { "id": "step_1", "description": "Get current weather", "toolName": "get_weather", "status": "completed", "result": "{\"temperature\":72,...}" },
    { "id": "step_2", "description": "Get forecast", "toolName": "get_forecast", "status": "completed", "result": "{\"forecast\":[...]}" },
    { "id": "step_3", "description": "Write summary", "toolName": "workspace_write_file", "status": "completed", "result": "{\"success\":true}" }
  ]
}
```

---

### adjust_plan

Modifies remaining steps of a plan that is mid-execution. Only works on steps with status `pending`.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan_id` | string | Yes | The plan ID to modify |
| `modifications` | array | Yes | Array of modification objects |

**Each modification object**:

| Field | Type | Description |
|-------|------|-------------|
| `stepId` | string | The step ID to modify |
| `action` | string | `"modify"` (change args), `"skip"` (skip step), or `"add"` (add new step) |
| `newArgs` | object | New arguments (for `modify` action — merged with existing args) |
| `newStep` | object | New step definition (for `add` action — `{ description, toolName, args, dependsOn }`) |

**Returns**:
```json
{
  "success": true,
  "plan_id": "plan_1_1707890400000",
  "modified": 1,
  "skipped": 1,
  "added": 1,
  "remainingSteps": [
    { "id": "step_3", "description": "Write summary (modified)", "toolName": "workspace_write_file" },
    { "id": "step_added_5", "description": "Send notification", "toolName": "send_notification" }
  ],
  "message": "Plan adjusted: 1 modified, 1 skipped, 1 added."
}
```

---

## How Execution Works

### Step Lifecycle

```
  pending → running → completed
                  └→ failed (after 2 retries)
                  └→ skipped (dependency failed or manually skipped)
                  └→ rolled_back (watcher decided to undo)
```

### Execution Flow

```
Plan: 4 steps
  │
  ▼
Step 1: get_weather
  ├─ Call handler → success → result stored
  └─ Watcher: ✅ continue
  │
  ▼
Step 2: get_forecast
  ├─ Call handler → error (API timeout)
  ├─ Watcher: 🔄 retry (attempt 1)
  ├─ Call handler → success → result stored
  └─ Watcher: ✅ continue
  │
  ▼
Step 3: workspace_write_file
  ├─ Depends on step_1, step_2 → both completed ✅
  ├─ Template vars resolved: {{step_1.result.temperature}} → "72"
  ├─ Call handler → success → result stored
  └─ Watcher: ✅ continue
  │
  ▼
Step 4: send_notification
  ├─ Call handler → success
  └─ Watcher: ✅ plan complete
  │
  ▼
Summary: 4/4 steps succeeded
```

### Dependency Resolution

Steps with `dependsOn` won't execute until all their dependencies have completed successfully. If a dependency fails, the dependent step is automatically skipped.

```
step_1 (get_weather)       → runs first (no dependencies)
step_2 (get_forecast)      → runs after step_1 (dependsOn: ["step_1"])
step_3 (write_file)        → runs after step_1 AND step_2 (dependsOn: ["step_1", "step_2"])
```

If step_2 fails, step_3 is skipped (missing dependency).

---

## Template Variables

Steps can reference the output of previous steps using template variables:

| Syntax | What It References |
|--------|-------------------|
| `{{step_1.result.field}}` | A specific field from step 1's result |
| `{{step_2.result.formatted}}` | The `formatted` field from step 2 |
| `{{step_N.result}}` | The entire result object from step N |

### How Templates Resolve

When step 3 has an argument like:
```json
{ "content": "Weather: {{step_1.result.temperature}}°F, Forecast: {{step_2.result.formatted}}" }
```

At execution time, the values from step 1 and step 2's results are substituted:
```json
{ "content": "Weather: 72°F, Forecast: Mon: 75°F sunny, Tue: 68°F cloudy..." }
```

### Important Notes

- Template variables only work when the referenced step has completed successfully
- If a referenced step failed or was skipped, the variable remains as-is (literal `{{step_1.result.field}}`)
- Variables are resolved just before the step executes (not at plan creation time)

---

## Error Handling and Recovery

### Automatic Recovery (Watcher)

The watcher evaluates each step's result and can:

| Situation | Watcher Response | Max |
|-----------|-----------------|-----|
| Tool returned an error | Retry with modified parameters | 2 retries |
| Network timeout | Retry the same call | 2 retries |
| Dependency failed | Skip the step | — |
| Unknown error | Skip the step | — |

After 2 failed retries, the step is marked as `failed` and execution continues with remaining steps (those not dependent on the failed step).

### Manual Recovery (adjust_plan)

If the automatic watcher can't fix the problem, the LLM can call `adjust_plan` to:

- **Modify** a pending step's arguments (e.g., change the search query, use a different file path)
- **Skip** a step that's no longer needed
- **Add** a new step (e.g., an alternative approach, a notification about the failure)

Then call `execute_plan` again to continue executing the remaining (modified) steps.

---

## What You See in the Chat UI

When Plan Mode activates, a plan checklist appears in the chat:

```
📋 Plan: Research and Write Weather Report
  ✅ Step 1: Get current weather conditions       [completed]
  ⏳ Step 2: Get 5-day forecast                    [running...]
  ⬜ Step 3: Write report to workspace file        [pending]
  ⬜ Step 4: Generate PDF of the report            [pending]
```

Status icons update in real-time:
- ⬜ **Pending** — waiting to execute
- ⏳ **Running** — currently executing
- ✅ **Completed** — finished successfully
- ❌ **Failed** — failed after retries
- ⏭️ **Skipped** — skipped due to dependency failure or manual skip
- ↩️ **Rolled back** — watcher decided to undo

After all steps complete, the Choom provides a natural language summary of what was accomplished.

---

## Examples

### Example 1: Research and Write Report

**User says**: "Research the best drones under $500 and write a comparison report in my Projects folder"

**What the Choom does**:

```
create_plan:
  goal: "Research drones under $500 and write comparison report"
  steps:
    - step_1: { description: "Search for drone reviews", toolName: "web_search", args: { query: "best drones under $500 2026 comparison" } }
    - step_2: { description: "Search for budget drone specs", toolName: "web_search", args: { query: "budget drones DJI Mini specs vs price" } }
    - step_3: { description: "Write comparison report", toolName: "workspace_write_file", args: { project: "Drone Research", path: "drone-comparison.md", content: "{{step_1.result.formatted}}\n\n{{step_2.result.formatted}}" } }
    - step_4: { description: "Generate PDF", toolName: "workspace_generate_pdf", args: { project: "Drone Research", source: "drone-comparison.md", output: "drone-comparison.pdf" } }
    - step_5: { description: "Notify when done", toolName: "send_notification", args: { message: "Drone comparison report is ready in your Drone Research project!" } }

execute_plan: plan_id = "plan_1_..."
```

**Result**: 5 steps execute, producing a markdown report, a PDF, and a Signal notification.

---

### Example 2: Weather Summary Document

**User says**: "Get the weather and the 5-day forecast, then create a Google Doc with a summary"

```
create_plan:
  goal: "Create weather summary Google Doc"
  steps:
    - step_1: { description: "Get current weather", toolName: "get_weather" }
    - step_2: { description: "Get 5-day forecast", toolName: "get_forecast" }
    - step_3: { description: "Create summary document", toolName: "create_document", args: { title: "Weather Summary - Feb 14", content: "## Current Conditions\n{{step_1.result.formatted}}\n\n## 5-Day Forecast\n{{step_2.result.formatted}}" } }

execute_plan: plan_id = "plan_2_..."
```

**Result**: Current weather and forecast are fetched, then combined into a formatted Google Doc.

---

### Example 3: Email Digest to Google Doc

**User says**: "Check my recent emails, find anything about invoices, and write a summary doc"

```
create_plan:
  goal: "Create invoice email digest"
  steps:
    - step_1: { description: "Search for invoice emails", toolName: "search_emails", args: { query: "subject:invoice newer_than:7d" } }
    - step_2: { description: "Create digest document", toolName: "create_document", args: { title: "Invoice Digest - Week of Feb 14", content: "## Recent Invoice Emails\n\n{{step_1.result.formatted}}" } }
    - step_3: { description: "Notify with link", toolName: "send_notification", args: { message: "Invoice digest ready: {{step_2.result.url}}" } }

execute_plan: plan_id = "plan_3_..."
```

**Result**: Gmail is searched for recent invoice emails, a Google Doc is created with the digest, and you get a Signal notification with the link.

---

### Example 4: Project Status Report

**User says**: "List my active projects and their files, then write a status report"

```
create_plan:
  goal: "Generate project status report"
  steps:
    - step_1: { description: "List workspace files in Project A", toolName: "workspace_list_files", args: { project: "LIDAR Backpack" } }
    - step_2: { description: "List workspace files in Project B", toolName: "workspace_list_files", args: { project: "Drone Research" } }
    - step_3: { description: "Get calendar events", toolName: "get_calendar_events", args: { days_ahead: 7 } }
    - step_4: { description: "Write status report", toolName: "workspace_write_file", args: { project: "Daily Notes", path: "status-report.md", content: "# Weekly Status\n\n## LIDAR Backpack\n{{step_1.result.formatted}}\n\n## Drone Research\n{{step_2.result.formatted}}\n\n## Upcoming Events\n{{step_3.result.formatted}}" } }

execute_plan: plan_id = "plan_4_..."
```

---

### Example 5: YouTube Research and Notes

**User says**: "Search YouTube for the latest drone reviews and save the top results to my notes"

```
create_plan:
  goal: "YouTube drone research to notes"
  steps:
    - step_1: { description: "Search YouTube for drone reviews", toolName: "search_youtube", args: { query: "best drone 2026 review", max_results: 5, type: "video" } }
    - step_2: { description: "Save results to workspace", toolName: "workspace_write_file", args: { project: "Drone Research", path: "youtube-reviews.md", content: "# YouTube Drone Reviews\n\n{{step_1.result.formatted}}" } }

execute_plan: plan_id = "plan_5_..."
```

---

### Example 6: Contact Lookup and Email Draft

**User says**: "Find John's email address and draft him a message about the project update"

```
create_plan:
  goal: "Find contact and draft email"
  steps:
    - step_1: { description: "Search for John in contacts", toolName: "search_contacts", args: { query: "John" } }
    - step_2: { description: "Draft project update email", toolName: "draft_email", args: { to: "{{step_1.result.contacts[0].email}}", subject: "Project Update", body: "Hi John,\n\nHere's a quick update on the project..." }, dependsOn: ["step_1"] }

execute_plan: plan_id = "plan_6_..."
```

**Note**: The Choom uses `draft_email` (not `send_email`) since the user said "draft". The draft appears in Gmail for review.

---

### Example 7: Multi-Source Data Collection

**User says**: "Get the weather, check my calendar, search for local events, and create a weekend plan"

```
create_plan:
  goal: "Create weekend activity plan"
  steps:
    - step_1: { description: "Get weather forecast", toolName: "get_forecast" }
    - step_2: { description: "Check calendar for weekend", toolName: "get_calendar_events", args: { days_ahead: 3 } }
    - step_3: { description: "Search for local events", toolName: "web_search", args: { query: "events this weekend in my area" } }
    - step_4: { description: "Write weekend plan", toolName: "workspace_write_file", args: { project: "Daily Notes", path: "weekend-plan.md", content: "# Weekend Plan\n\n## Weather\n{{step_1.result.formatted}}\n\n## Calendar\n{{step_2.result.formatted}}\n\n## Local Events\n{{step_3.result.formatted}}" }, dependsOn: ["step_1", "step_2", "step_3"] }
    - step_5: { description: "Send notification", toolName: "send_notification", args: { message: "Your weekend plan is ready in Daily Notes!" }, dependsOn: ["step_4"] }

execute_plan: plan_id = "plan_7_..."
```

**Note**: Steps 1-3 have no dependencies and could theoretically run in parallel. Step 4 depends on all three, and step 5 depends on step 4.

---

### Example 8: Recovery After Failure (adjust_plan)

**Scenario**: Step 2 of a 4-step plan fails because the web search returned no results.

```
Plan status after step 2 failure:
  step_1: completed (get_weather)
  step_2: failed (web_search — no results)
  step_3: pending (workspace_write_file — depends on step_2)
  step_4: pending (send_notification)
```

The Choom calls `adjust_plan`:

```
adjust_plan:
  plan_id: "plan_1_..."
  modifications:
    - { stepId: "step_3", action: "modify", newArgs: { content: "Weather only report: {{step_1.result.formatted}}\n\n(Web search returned no results)" } }
    - { stepId: "step_4", action: "modify", newArgs: { message: "Partial report ready — web search failed, weather data only." } }
```

Then continues execution:

```
execute_plan: plan_id = "plan_1_..."  (resumes from step_3)
```

**Result**: The plan adapts instead of failing completely. You get a partial report with a note about what didn't work.

---

## Automatic vs Explicit Plan Mode

| Aspect | Automatic | Explicit (Tools) |
|--------|-----------|------------------|
| **Trigger** | Keyword detection in user message | LLM calls `create_plan` directly |
| **Visibility** | Plan appears in chat UI | Plan appears in chat UI |
| **Adjustment** | Watcher handles automatically | LLM can call `adjust_plan` |
| **Control** | LLM decides plan structure | LLM decides plan structure |
| **When to use** | Complex compound requests | When you want explicit plan control, or when auto-detection doesn't trigger |

Both paths ultimately use the same infrastructure: `ExecutionPlan`, `WatcherLoop`, and SSE progress events.

---

## Limits and Constraints

| Limit | Value | Why |
|-------|-------|-----|
| Max steps per plan | 10 | Prevents runaway plans and excessive tool calls |
| Max retries per step | 2 | Avoids infinite retry loops |
| Plan lifetime | Current request only | Plans are stored in memory, not persisted to disk |
| Tool validation | Warning only | Unknown tools generate warnings but don't block plan creation |
| Step timeout | Inherited from tool | Each tool has its own timeout (typically 30-120s) |

### Plans Are Not Persistent

Plans exist only in server memory during the request that created them. If the server restarts or the conversation moves to a new API call, the plan is lost. This is by design — plans are meant for immediate execution, not long-term storage.

For long-running scheduled workflows, use [Automations](CONDITIONAL-TRIGGERS.md) instead.

---

## Tips for Better Plans

### Keep Steps Focused

Each step should do one thing. Don't combine "search the web and write a file" into one step — make them two steps so the watcher can retry each independently.

**Good**:
```
step_1: web_search (query: "solar panels")
step_2: workspace_write_file (content: {{step_1.result.formatted}})
```

**Bad**:
```
step_1: [tries to do everything in one tool call]
```

### Use Dependencies Wisely

Only add `dependsOn` when a step truly needs another step's output. Independent steps can run without dependencies, making the plan more resilient to failures.

```
step_1: get_weather          (no deps)
step_2: get_calendar_events  (no deps)
step_3: write_summary        (dependsOn: [step_1, step_2])  ← needs both
```

If step 1 and step 2 were independent but you made step 2 depend on step 1 unnecessarily, a failure in step 1 would skip step 2 — losing data you could have still collected.

### Use Template Variables for Data Flow

Template variables (`{{step_N.result.field}}`) are the glue that connects steps. Use them to pipe data from one tool to another without the LLM having to manually extract and reformat results.

### Keep Plans Under 10 Steps

If you need more than 10 steps, consider breaking the task into two plans or using the regular agentic loop for simpler parts and a plan for the structured parts.

### Let the Choom Handle Formatting

You don't need to micromanage how the Choom formats the plan. Just describe what you want naturally:

**Good**: "Research solar panels and write a comparison report"
**Fine**: "Create a plan to check the weather, search for events, and write a weekend activity guide"
**Unnecessary**: "Create a plan with 5 steps: step 1 should use get_weather with no args..."

The Choom knows which tools to use and how to structure the plan. Trust it.

---

## Troubleshooting

### Plan doesn't get created

- Make sure the message contains a multi-step request. Single-action requests ("What's the weather?") use the simple agentic loop
- Try phrasing with explicit structure: "First check X, then do Y, and finally write Z"
- If auto-detection doesn't trigger, you can ask: "Create a plan to do X, Y, and Z"

### Step fails but should succeed

- Check if the tool is enabled in the Skills page
- Check if the tool requires specific configuration (API keys, OAuth, endpoints)
- Look at the step's error message in the plan result — it usually says exactly what went wrong

### Template variable not resolving

- Make sure the referenced step completed successfully (`status: "completed"`)
- Check the field name: `{{step_1.result.formatted}}` needs the step's result to actually have a `formatted` field
- If the step's result is deeply nested, you may need: `{{step_1.result.data.items}}`

### Plan created but never executed

- After `create_plan`, the LLM must call `execute_plan` with the returned `plan_id`
- If the Choom describes the plan but doesn't execute it, ask: "Execute the plan" or "Run it"

### Plan expires / plan not found

- Plans live in server memory only. If you refresh the page, restart the server, or start a new conversation, the plan is gone
- Always execute plans in the same conversation turn they were created
