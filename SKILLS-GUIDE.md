# Choom Skills Guide

A step-by-step guide for getting the most out of Choom's skills, automations, and agentic capabilities. Written for non-programmers.

---

## Table of Contents

1. [What Are Skills?](#what-are-skills)
2. [The Skills Page](#the-skills-page)
3. [Using Built-In Skills](#using-built-in-skills)
4. [Creating Custom Skills](#creating-custom-skills)
5. [Installing External Skills](#installing-external-skills)
6. [Automations: Combining Skills](#automations-combining-skills)
7. [Cron Jobs and Heartbeats](#cron-jobs-and-heartbeats)
8. [Multi-Step Requests (Planner Mode)](#multi-step-requests-planner-mode)
9. [Testing and Debugging](#testing-and-debugging)
10. [Tips and Best Practices](#tips-and-best-practices)

---

## What Are Skills?

Skills are bundles of related tools that your Choom can use. Think of them like apps on a phone -- each skill gives your Choom a specific capability.

For example:
- The **weather-forecasting** skill gives your Choom the ability to check the weather and get forecasts
- The **google-calendar** skill lets your Choom read, create, update, and delete calendar events
- The **google-gmail** skill lets your Choom read, send, draft, search, and archive emails
- The **image-generation** skill lets your Choom create images using Stable Diffusion

Choom comes with **20 built-in skills** containing **70 tools** total. You can also create your own custom skills or install skills made by others.

### Why Skills Matter

Before the skills system, every tool definition and its documentation was sent with every single message to the LLM. That's like handing someone a 20-page instruction manual every time you ask a simple question.

With skills, Choom uses a smart system called **progressive disclosure**:
- **Always**: The LLM sees a brief one-line summary of each skill (like a table of contents)
- **When needed**: If you ask about weather, only the weather skill's full documentation is loaded
- **On demand**: If a tool needs detailed reference material, it's loaded only at that moment

This makes your Choom faster, more accurate, and less likely to get confused by irrelevant information.

---

## The Skills Page

Access the Skills page by clicking the **Skills** button in the sidebar (the blocks/puzzle icon).

### What You'll See

- **Search bar**: Filter skills by name, description, or tool name
- **Category filters**: Show All, Core (built-in), Custom (your creations), or External (installed from GitHub)
- **Skill cards**: Each card shows the skill's name, description, tool count, type badge, and an enable/disable toggle
- **Stats bar**: Total counts of enabled skills and available tools
- **Create Skill button**: Opens the custom skill builder
- **Reload button**: Refreshes the skill registry (useful after manual file changes)

### Viewing Skill Details

Click any skill card to open its detail panel. You'll see:

- **Documentation**: The skill's full documentation (from SKILL.md)
- **Tools list**: Every tool in the skill with its description
- **Tool parameters**: Select a tool to see its parameters (what inputs it accepts)
- **Handler code**: The actual code that runs when the tool is called (read-only for core skills)
- **Test runner**: A button to test any tool with sample inputs

### Enabling and Disabling Skills

Every skill card has a toggle switch. Turn it off to disable a skill -- its tools will no longer be available to any Choom. Turn it back on to re-enable.

This is useful if:
- You don't use certain Google tools and want to reduce clutter
- You want to temporarily disable a custom skill while debugging
- You want to prevent a Choom from using certain capabilities

---

## Using Built-In Skills

You don't need to do anything special to use built-in skills. Just talk to your Choom naturally, and it will use the right tools automatically.

### Quick Reference: What Each Skill Does

| Skill | What to Say | What Happens |
|-------|------------|--------------|
| **memory-management** | "Remember that I like hiking" | Stores the fact in your Choom's memory |
| **memory-management** | "Do you remember my favorite food?" | Searches memories for the answer |
| **image-generation** | "Draw a sunset over mountains" | Generates an image with Stable Diffusion |
| **image-generation** | "Take a selfie" | Uses self-portrait mode with your Choom's dedicated checkpoint and LoRAs |
| **web-searching** | "Search for best hiking trails in New Mexico" | Runs a web search and summarizes results |
| **weather-forecasting** | "What's the weather like?" | Gets current weather conditions |
| **weather-forecasting** | "Will it rain this week?" | Gets the 5-day forecast |
| **google-calendar** | "What's on my calendar tomorrow?" | Lists upcoming events |
| **google-calendar** | "Schedule a meeting Friday at 2pm" | Creates a calendar event |
| **google-tasks** | "Add milk to my grocery list" | Adds item to a Google Tasks list |
| **google-sheets** | "Create a spreadsheet for my budget" | Creates a new Google Sheet |
| **google-docs** | "Write a document about..." | Creates a Google Doc with content |
| **google-drive** | "Upload my report to Drive" | Uploads workspace files to Google Drive |
| **workspace-files** | "Write a file called notes.md" | Creates/edits files in workspace projects |
| **pdf-processing** | "Generate a PDF of that report" | Converts markdown to a styled PDF |
| **web-scraping** | "Find all images on this webpage" | Scrapes image URLs from a page |
| **web-scraping** | "Download that image" | Downloads images with auto-conversion |
| **image-analysis** | "What's in this image?" | Analyzes images using vision AI |
| **code-execution** | "Run this Python code..." | Executes code in a sandboxed environment |
| **google-gmail** | "Check my inbox" | Lists recent emails |
| **google-gmail** | "Draft an email to John about..." | Creates a draft email (doesn't send) |
| **google-gmail** | "Search my emails for invoices" | Searches Gmail with Gmail syntax |
| **google-contacts** | "Find John's email address" | Searches Google Contacts by name |
| **google-youtube** | "Search YouTube for drone reviews" | Searches YouTube for videos |
| **notifications** | "Send me a Signal message about..." | Sends a proactive notification |
| **reminders** | "Remind me in 30 minutes to..." | Sets a timed Signal reminder |
| **plan-mode** | "Research X and write a report about it" | Creates and executes a structured plan |

### Agentic Chaining

Chooms don't just use one tool at a time. They can chain multiple tools in a single conversation turn. For example, if you say:

> "Check the weather and add it to my daily notes file"

Your Choom will:
1. Call `get_weather` to get current conditions
2. Call `workspace_write_file` to append the weather to your notes
3. Respond with a summary of what it did

This happens automatically -- you don't need to tell your Choom to use specific tools. It figures out the best approach on its own.

---

## Creating Custom Skills

Custom skills let you add entirely new capabilities to your Choom. Here's how to create one step by step.

### Step 1: Open the Skill Creator

1. Go to the **Skills** page (sidebar > Skills)
2. Click the **"Create Skill"** button in the top right
3. A dialog will open with the skill builder form

### Step 2: Name Your Skill

- Enter a **lowercase name** using letters, numbers, hyphens, or underscores
- Examples: `price-checker`, `recipe_finder`, `daily-summary`
- The name must start with a letter
- Keep it short and descriptive

### Step 3: Add a Description

Write a brief description of what your skill does. This helps the LLM understand when to use it.

Good: "Checks product prices from online stores and compares them"
Bad: "A skill" (too vague for the LLM)

### Step 4: Define Your Tools

Each skill contains one or more tools. A tool is a specific action your Choom can perform.

1. Click **"Add Tool"** to create your first tool
2. Fill in:
   - **Tool name**: Lowercase with underscores (e.g., `check_price`)
   - **Description**: What the tool does (shown to the LLM)
3. Add **parameters** (the inputs the tool needs):
   - Click "Add Parameter"
   - Enter the parameter name (e.g., `product_name`)
   - Choose a type: string (text), number, boolean (true/false), array (list), or object (complex data)
   - Write a description so the LLM knows what to pass
   - Toggle "Required" if the parameter must be provided

**Example**: A `check_price` tool might have:
- `product_name` (string, required) - "The name of the product to look up"
- `max_results` (number, optional) - "Maximum number of prices to return (default 5)"

### Step 5: Write the Handler Code

The handler is the code that actually runs when the tool is called. Don't worry if you're not a programmer -- there's a shortcut.

**Easy way**: Click **"Generate Skeleton"** to auto-create a template based on your tools. This gives you a working starting point with `TODO` comments showing where to add your logic.

**The generated code looks like this**:
```typescript
import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';

export default class MySkillHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return ['check_price'].includes(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'check_price':
        // TODO: Implement check_price
        const productName = toolCall.arguments.product_name as string;
        return this.success(toolCall, { message: `Checked price for ${productName}` });
      default:
        return this.error(toolCall, `Unknown tool: ${toolCall.name}`);
    }
  }
}
```

**Key patterns for handler code**:
- `toolCall.arguments.param_name` -- access the parameters the LLM passed
- `this.success(toolCall, { ... })` -- return a successful result (the data goes back to the LLM)
- `this.error(toolCall, "message")` -- return an error
- `ctx.settings` -- access Choom settings
- `ctx.choomId` -- the current Choom's ID
- `ctx.send({ type: '...', ... })` -- send data to the chat UI in real time

### Step 6: Create the Skill

Click **"Create Skill"** at the bottom of the dialog. Your skill will be:
1. Saved to `~/choom-projects/.choom-skills/your-skill-name/`
2. Registered in the skill registry
3. Immediately available to all Chooms

### Step 7: Test Your Skill

1. Click on your new skill card in the Skills page
2. In the detail panel, select a tool from the dropdown
3. Click **"Run Test"**
4. The tool will execute with default test values and show the result

If something goes wrong, you can:
- Edit the skill by clicking on it and modifying the handler code
- Check the browser console (F12) for error messages
- Disable the skill temporarily while you fix issues

---

## Installing External Skills

You can install skills created by other people from GitHub repositories.

### Step 1: Find a Skill

Look for GitHub repositories that contain Choom-compatible skills. A valid skill repository has:
- A `SKILL.md` file with YAML frontmatter
- A `tools.ts` or `tools.js` file with tool definitions
- A `handler.ts` or `handler.js` file with the implementation

### Step 2: Install via API

Currently, external skills are installed via the API. Use the Skills page or send a request to:

```
POST /api/skills/install
Body: { "url": "https://github.com/username/repo-name" }
```

The system will:
1. Fetch the skill files from GitHub
2. Run a **safety scan** checking for dangerous code patterns
3. Show you any warnings or blockers
4. If safe, install to the external skills directory

### Step 3: Safety Review

The installer checks for dangerous patterns:

**Blockers** (skill will NOT be installed):
- Code that spawns processes (`exec`, `spawn`)
- Code that evaluates strings as code (`eval`, `new Function`)
- Code that can crash the app (`process.exit`)
- Obfuscated/encoded code (potential hidden malicious behavior)

**Warnings** (you'll be informed, but can proceed):
- Network requests to external URLs
- Reading environment variables
- Writing files

### Step 4: Verify and Enable

After installation:
1. The skill appears in the Skills page under the "External" filter
2. It's enabled by default
3. Test it using the built-in test runner
4. Disable or uninstall if it doesn't work as expected

### Uninstalling

To remove an external skill:
```
DELETE /api/skills/install
Body: { "skillName": "the-skill-name" }
```

This removes all files and unregisters the skill.

---

## Automations: Combining Skills

Automations let you chain multiple tools together into scheduled workflows. Think of them as recipes -- "do this, then do that, then notify me." Automations can also have **conditional triggers** that check weather, time, day of week, or calendar events before running. See the [Conditional Triggers Guide](CONDITIONAL-TRIGGERS.md) for detailed documentation and examples.

### Accessing the Automation Builder

1. Go to **Settings** (gear icon)
2. Click **Automations** in the left sidebar
3. You'll see a list of existing automations (if any) and a "Create Automation" button

### Creating Your First Automation

#### Example: Daily Weather Report to File

Let's create an automation that checks the weather every morning and saves it to a file.

**Step 1**: Click "Create Automation"

**Step 2**: Fill in the basics:
- **Name**: "Daily Weather Report"
- **Description**: "Checks weather and saves to daily notes" (optional)

**Step 3**: Add Step 1 -- Get Weather:
- Click "Add Step"
- **Skill**: Select "weather-forecasting"
- **Tool**: Select "get_weather"
- Parameters are optional (it uses your configured location by default)

**Step 4**: Add Step 2 -- Write to File:
- Click "Add Step" again
- **Skill**: Select "workspace-files"
- **Tool**: Select "workspace_write_file"
- **Parameters**:
  - `project`: "Daily Notes"
  - `path`: "weather-log.md"
  - `content`: "Weather update: {{prev.result.formatted}}"
  - `append`: true

Notice the `{{prev.result.formatted}}` -- this is a **template variable** that pulls data from the previous step's output.

**Step 5**: Add Step 3 -- Notify (optional):
- Click "Add Step"
- **Skill**: Select "notifications"
- **Tool**: Select "send_notification"
- **Parameters**:
  - `message`: "Daily weather report saved."

**Step 6**: Set the Schedule:
- **Mode**: Cron (specific time)
- **Time**: 07:00
- **Days**: Leave empty for every day, or check specific days

**Step 7**: Configure Options:
- **Target Choom**: Select which Choom runs this (e.g., "MyChoom")
- **Respect quiet hours**: Toggle on if you don't want it running during sleep hours
- **Send notification on complete**: Toggle on to get a Signal message when done

**Step 8**: Click "Create"

Your automation now appears in the list with a play button, edit button, and enable/disable toggle.

### Template Variables

Template variables let steps reference outputs from previous steps:

| Variable | What It Does |
|----------|-------------|
| `{{prev.result.field}}` | Gets `field` from the immediately previous step's output |
| `{{step_1.result.field}}` | Gets `field` from step 1's output (any previous step) |
| `{{date}}` | Current date |

**Example chain**: Search the web, then write results to a file:
- Step 1: `web_search` with query "latest AI news"
- Step 2: `workspace_write_file` with content `{{prev.result.formatted}}`

The search results flow automatically into the file content.

### Managing Automations

Each automation card in the list shows:
- **Status badge**: Success (green), Partial (yellow), or Failed (red) from the last run
- **Schedule**: Plain English description (e.g., "Weekdays at 07:00", "Every 2h")
- **Target Choom**: Which Choom is assigned
- **Step preview**: Visual chain of tool names with arrows
- **Last run**: How long ago it last executed

**Controls**:
- **Play button**: Run immediately (bypasses schedule and quiet hours)
- **Edit button**: Open the builder to modify
- **Delete button**: Remove the automation
- **Toggle switch**: Enable/disable without deleting

---

## Cron Jobs and Heartbeats

Cron jobs and heartbeats are the original scheduling system in Choom. They work alongside automations.

### How They Differ from Automations

| Feature | Cron Jobs/Heartbeats | Automations |
|---------|---------------------|-------------|
| **Setup** | Settings > Cron Jobs / Heartbeats | Settings > Automations |
| **Steps** | Single prompt to LLM | Multi-step tool chains |
| **Flexibility** | Pre-defined task types | Any combination of tools |
| **Template vars** | No | Yes (`{{prev.result}}`) |
| **Visual builder** | Time pickers only | Full step-by-step builder |

**Use cron jobs** for: recurring LLM-driven tasks like morning briefings, weather checks, aurora forecasts
**Use heartbeats** for: periodic health checks, system monitoring, background awareness tasks
**Use automations** for: multi-step workflows that chain specific tools together with data flowing between steps

### Existing Cron Jobs

These are configured in **Settings > Cron Jobs**:

| Job | Default Time | What It Does |
|-----|-------------|-------------|
| Morning Briefing | 7:01 AM | Weather + calendar summary via Signal |
| Weather Check | 7:02 AM, 12:01 PM, 6:01 PM | Weather update |
| Aurora Forecast | 12:02 PM, 6:02 PM | Northern lights forecast |
| YouTube Music Download | 4:00 AM | Download new music from configured channels |

Each has a "Run Now" button to trigger immediately.

### Custom Heartbeats

Configured in **Settings > Heartbeats**:

- Set the **interval** (how often, in minutes)
- Set **quiet hours** (e.g., 9 PM to 6 AM -- heartbeats won't fire)
- Add **custom heartbeat prompts** per Choom (e.g., "Check on my projects and give me a status update")
- Each Choom can have its own heartbeat with its own prompt

Heartbeats automatically **defer** when you're actively chatting with a Choom. If you sent a message to a Choom within the last 2 minutes, its heartbeat will wait until you're done. This prevents the Choom from interrupting your conversation.

### Combining Cron, Heartbeats, and Automations

You can use all three systems together. A typical setup might be:

- **Morning briefing (cron)**: 7:01 AM -- your Choom gives you a natural language summary of weather and calendar
- **Weather automation**: 12:00 PM -- automation chain: get_weather -> workspace_write_file -> send_notification (structured data saved to file)
- **Project heartbeat**: Every 4 hours -- your Choom checks on workspace projects and sends a Signal update if anything changed
- **Backup automation**: Sunday at 2:00 AM -- automation chain: workspace_list_files -> upload_to_drive -> send_notification

---

## Multi-Step Requests (Planner Mode)

When you give your Choom a complex request that involves multiple steps, it automatically activates **Planner Mode**. Chooms can also explicitly create and execute plans using the `plan-mode` skill. See the [Plan Mode Guide](PLAN-MODE.md) for detailed documentation and examples.

### What Triggers the Planner

The planner activates when your message contains patterns like:
- "Research X **and then** write a report"
- "**Compare** A and B"
- "**Step by step**, do the following..."
- "**First** do X, **then** do Y"
- "**Analyze** this **and** create a summary"
- Any compound instruction with multiple distinct actions

### What You'll See

When the planner activates, you'll see a **plan checklist** appear in the chat:

```
Plan: Research and Write Weather Report
  [x] Step 1: Search for weather data      -- completed
  [>] Step 2: Get 5-day forecast            -- running
  [ ] Step 3: Write report to file          -- pending
  [ ] Step 4: Generate PDF                  -- pending
```

Each step updates in real time as it executes:
- Empty checkbox = pending
- Arrow = currently running
- Checkmark = completed
- X = failed
- Curved arrow = rolled back

### What Happens Behind the Scenes

1. Your Choom reads your request and creates a structured plan
2. Each step specifies which tool to call and what parameters to use
3. Steps execute one at a time, and each step's output is available to the next
4. If a step fails, the system tries to fix it:
   - Missing parameter? Tries a reasonable default
   - Network error? Retries up to 2 times
   - Depends on a failed step? Skips gracefully
5. After all steps complete, your Choom summarizes the results

### When the Planner Doesn't Activate

Simple, single-action requests use the regular agentic loop (which is still multi-tool capable). The planner is only for complex, structured workflows. If you ask "What's the weather?", your Choom will just call `get_weather` directly without creating a plan.

---

## Testing and Debugging

### Testing Skills from the Skills Page

1. Go to **Skills** page
2. Click on any skill card
3. In the detail panel, select a tool from the dropdown
4. Click **"Run Test"**
5. The tool executes with default/sample parameters
6. Results appear in the panel

This is useful for:
- Verifying a custom skill works before relying on it
- Checking if external services (weather API, Google, etc.) are properly configured
- Debugging parameter issues

### Running Evals

Evals are automated test suites that verify a skill works correctly.

1. Open a skill's detail panel
2. Access evals via `GET /api/skills/{skill-name}/eval` (generates test cases)
3. Run them via `POST /api/skills/{skill-name}/eval`
4. Review results: each eval shows pass/fail and any error messages

Auto-generated evals test:
- **Happy path**: Does the tool work with valid inputs?
- **Missing parameters**: Does it properly reject calls missing required inputs?
- **Enum values**: Does it handle each valid option?

### Checking Logs

- **Browser console** (F12): Shows JavaScript errors and network requests
- **Server console**: Shows tool execution logs with timestamps and parameters
- **Activity log panel**: In the Choom chat UI, the activity panel shows tool calls, timing, and results

### Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| Skill not appearing | Registry not reloaded | Click "Reload" on Skills page |
| Tool returns error | Missing API key or config | Check Settings for the relevant service |
| Custom skill crashes | Handler code bug | Check browser console, fix handler code |
| Automation not running | Disabled or wrong schedule | Check toggle and schedule in Settings > Automations |
| Template variable empty | Previous step failed | Check step order and ensure referenced fields exist |
| Black images | Wrong checkpoint settings | Verify image settings in Choom edit panel (selfPortrait/general mode) |

---

## Tips and Best Practices

### Writing Good Tool Descriptions

The LLM reads your tool descriptions to decide when to use them. Good descriptions make your Choom smarter about tool selection.

**Good**: "Search for the current price of a product on major online retailers. Returns prices from up to 5 stores sorted by lowest price."

**Bad**: "Price tool" (the LLM won't know when to use this)

### Naming Conventions

- **Skill names**: lowercase with hyphens (e.g., `price-checker`, `email-sender`)
- **Tool names**: lowercase with underscores (e.g., `check_price`, `send_email`)
- **Parameter names**: lowercase with underscores (e.g., `product_name`, `max_results`)

### Automation Design Tips

1. **Start simple**: Begin with 2-step automations and add complexity gradually
2. **Test with Run Now**: Always test manually before relying on scheduled runs
3. **Use notifications**: Add a `send_notification` step at the end so you know when it completes
4. **Check dependencies**: Make sure step 2 actually needs step 1's output before using template variables
5. **Respect quiet hours**: For non-urgent automations, enable quiet hours to avoid middle-of-the-night notifications

### Skill Organization

- **One concern per skill**: A skill should do one thing well (weather, not weather-and-calendar)
- **Descriptive names**: The name should tell you what the skill does at a glance
- **Keep tools focused**: Each tool should be a single action, not a Swiss Army knife

### Performance Tips

- **Disable unused skills**: Every enabled skill adds tokens to the system prompt. Disabling skills you don't use (e.g., Google Sheets if you never use spreadsheets) reduces prompt size
- **Keep automations lean**: Each step is a full tool execution. More steps = longer runtime
- **Use the right tool for scheduling**: Cron jobs for simple LLM prompts, automations for structured multi-step chains

### Security Notes

- **Custom skills have full access** to the Choom API and database. Only create skills you understand
- **External skills are sandboxed** with limited workspace access and no database access
- **Always review external skills** before installing, even if they pass the safety scan
- **API keys in settings** are not accessible to external skills (stripped from context)
