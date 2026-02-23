---
name: choom-delegation
description: Delegate tasks to other Chooms and collect their responses. Use when orchestrating multi-agent collaboration — assigning research, coding, analysis, or other work to specialist Chooms.
version: 1.0.0
author: system
tools:
  - delegate_to_choom
  - list_team
  - get_delegation_result
dependencies: []
---

# Choom Delegation

## When to Use
- You need another Choom's expertise (research, coding, image analysis, etc.)
- Multi-step project requiring parallel or sequential work across specialists
- Orchestrating a team of Chooms to produce a combined deliverable
- Checking on or retrieving previous delegation results

## How It Works
1. **list_team**: See all available Chooms and their specializations
2. **delegate_to_choom**: Send a task to a specific Choom by name. The Choom processes the task with its own system prompt, model, and tools, then returns the result.
3. **get_delegation_result**: Retrieve the result of a previous delegation by its ID

## Best Practices
- **Be specific**: Write detailed task briefs with context, constraints, and desired output format
- **One task per delegation**: Don't overload a single delegation with multiple unrelated asks
- **Use workspace for large artifacts**: If you need a Choom to produce a file, ask them to write it to the shared workspace, then read it yourself
- **Chain with Plan Mode**: Use `create_plan` with delegate steps for complex multi-Choom workflows
- **Review before delivering**: Always review delegated results before passing them to the user

## Important
- Delegations use the target Choom's own model, endpoint, and system prompt
- Each delegation creates a dedicated chat session for traceability
- Delegations have a 120-second timeout to prevent hanging
- The delegating Choom's settings are forwarded (weather, search, etc.) so the target has access to shared services
- Results are cached by delegation ID for retrieval
