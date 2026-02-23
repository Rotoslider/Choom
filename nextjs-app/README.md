# Choom

A multi-agent AI companion framework built with Next.js 16. Chooms are independent AI agents with their own system prompts, models, and voices that can collaborate on complex tasks through delegation, plan execution, and shared workspaces.

## Features

### Multi-Agent Collaboration

- **Choom Delegation** — Agents delegate tasks to each other via internal API calls. An orchestrator Choom can assign research to one agent, coding to another, and image analysis to a third, then synthesize results.
- **Plan Mode** — Multi-step plans with `tool` and `delegate` step types. Plans support dependency tracking, retry/rollback, and template variable substitution across steps.
- **Per-Choom Configuration** — Each Choom has its own LLM model, endpoint, provider, system prompt, voice, and image generation settings. Supports `<!-- allowed_skills: ... -->` and `<!-- max_iterations: N -->` directives in system prompts.
- **Recursive Delegation Prevention** — `isDelegation` flag strips delegation/plan tools from target Chooms, caps iterations at 6, and disables multi-step detection to prevent loops.

### Skills System (22 Skills, 79 Tools)

Skills are modular tool bundles with progressive disclosure. Each skill has a SKILL.md manifest, tool definitions, and a handler.

| Skill | Tools | Description |
|-------|-------|-------------|
| **choom-delegation** | `delegate_to_choom`, `list_team`, `get_delegation_result` | Send tasks to other Chooms and collect responses |
| **plan-mode** | `create_plan`, `execute_plan`, `adjust_plan` | Multi-step planning with delegation support |
| **workspace-files** | `workspace_write_file`, `workspace_read_file`, `workspace_list_files`, `workspace_create_folder`, `workspace_create_project`, `workspace_delete_file`, `workspace_rename_project` | Sandboxed project file operations |
| **code-execution** | `execute_code`, `create_venv`, `install_package`, `run_command` | Python/Node.js sandbox with venv support |
| **google-gmail** | `list_emails`, `read_email`, `send_email`, `draft_email`, `search_emails`, `archive_email`, `reply_to_email` | Gmail API integration |
| **google-calendar** | `get_calendar_events`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event` | Calendar read/write |
| **google-sheets** | `list_spreadsheets`, `create_spreadsheet`, `read_sheet`, `write_sheet`, `append_to_sheet` | Spreadsheet CRUD |
| **google-docs** | `list_documents`, `create_document`, `read_document`, `append_to_document` | Document operations |
| **google-drive** | `list_drive_files`, `search_drive`, `create_drive_folder`, `upload_to_drive`, `download_from_drive` | File/folder management |
| **google-contacts** | `search_contacts`, `get_contact` | People API integration |
| **google-youtube** | `search_youtube`, `get_video_details`, `get_channel_info`, `get_playlist_items` | YouTube Data API v3 |
| **google-tasks** | `list_task_lists`, `get_task_list`, `add_to_task_list`, `remove_from_task_list` | Task list management |
| **home-assistant** | `ha_get_state`, `ha_list_entities`, `ha_call_service`, `ha_get_history`, `ha_get_home_status` | Smart home control and monitoring |
| **image-generation** | `generate_image`, `save_generated_image` | Stable Diffusion with checkpoint/LoRA switching |
| **image-analysis** | `analyze_image` | Vision model analysis |
| **memory-management** | `remember`, `search_memories`, `search_by_type`, `search_by_tags`, `search_by_date_range`, `get_recent_memories`, `update_memory`, `delete_memory`, `get_memory_stats` | ChromaDB semantic memory |
| **weather-forecasting** | `get_weather`, `get_weather_forecast` | OpenWeather current + 5-day forecast |
| **web-searching** | `web_search` | Brave Search or SearXNG |
| **web-scraping** | `scrape_page_images`, `download_web_image`, `download_web_file` | Page scraping and file downloads |
| **pdf-processing** | `workspace_generate_pdf`, `workspace_read_pdf` | Markdown to PDF with embedded images |
| **notifications** | `send_notification` | Signal message delivery |
| **reminders** | `create_reminder`, `get_reminders` | Timed reminders via Signal |

### Custom Skills

- **Skill Builder** — Create custom skills with TypeScript handlers, esbuild transpilation, and JSON import
- **External Installer** — Install skills from GitHub URLs with safety verification and sandbox isolation
- **Skill Evaluation** — Auto-generated test suites (happy-path + missing-param + enum-coverage)

### AI & Model Support

- **LLM Providers** — Local (LM Studio, Ollama), Anthropic, OpenAI with per-Choom provider assignment
- **Model Profiles** — 18 built-in LLM profiles + 5 vision profiles with per-model parameter defaults (topK, repetitionPenalty, enableThinking)
- **Vision** — Configurable maxImageDimension per model profile, auto-resize via Sharp
- **Image Generation** — Stable Diffusion/Forge with checkpoint switching, LoRA support, race condition protection
- **TTS/STT** — Text-to-speech and speech-to-text with per-Choom voice selection

### Integrations

- **Signal Bridge** — Bidirectional messaging with voice transcription name matching for all Chooms
- **Google APIs** — OAuth2 integration for Gmail, Sheets, Docs, Drive, Calendar, Tasks, Contacts, YouTube
- **Home Assistant** — Entity state/history, service calls, prompt injection with entity context
- **Brave Search / SearXNG** — Web search with configurable backend
- **OpenWeather** — Current conditions and forecasts
- **ChromaDB** — Semantic memory with type/tag/date filtering
- **YouTube Music Downloader** — Cron-based MP3 downloads with ID3 tags

### Automation

- **Cron Jobs** — Scheduled tasks with Signal bridge execution
- **Heartbeats** — Periodic Choom activities with quiet-period awareness
- **Conditional Triggers** — Weather, time range, day of week, calendar, and Home Assistant conditions
- **Automation Builder** — Visual step-chain builder with condition editor (ALL/ANY logic) and cooldown

## Architecture

### Agentic Loop

The chat API (`app/api/chat/route.ts`) runs a multi-iteration agentic loop:

- Up to 70 iterations per request with 60s timeout per API call
- Automatic tool nudging when the LLM forgets to use available tools
- Tool call deduplication cache prevents re-running identical calls
- Image generation cap (3 per request) with base64 stripping between iterations
- Context compaction at 50% budget (cross-turn summary + within-turn tool truncation)
- SSE streaming with resilient error handling (closed-stream protection)

### Settings Hierarchy (6 Layers)

1. Code defaults
2. Settings panel (global)
2b. Global provider config
3. Per-Choom overrides
3b. Per-Choom provider (`llmProviderId`)
4. Per-project provider
5. Model profile auto-application

### Data Model (SQLite + Prisma)

| Model | Purpose |
|-------|---------|
| **Choom** | AI companion with system prompt, model, voice, image settings |
| **Chat** | Conversation thread with optional compaction summary |
| **Message** | Individual message (user/assistant/system/tool roles) |
| **GeneratedImage** | Image generation history with prompt and settings |
| **ActivityLog** | Structured events (llm/tts/stt/image/memory/agent/system) |
| **Notification** | Pending Signal messages |
| **Settings** | Global configuration (single "global" row) |

## Project Structure

```
nextjs-app/
├── app/
│   ├── api/
│   │   ├── chat/              # Agentic chat loop with skill dispatch
│   │   ├── chooms/            # Choom CRUD
│   │   ├── chats/             # Chat history
│   │   ├── skills/            # Skill management, eval, install
│   │   ├── automations/       # Automation scheduling
│   │   ├── image-gen/         # Stable Diffusion integration
│   │   ├── tts/ / stt/        # Voice services
│   │   ├── memory/            # ChromaDB operations
│   │   ├── notifications/     # Signal bridge
│   │   ├── homeassistant/     # Home Assistant REST client
│   │   └── ...                # weather, search, tasks, projects, logs
│   ├── page.tsx               # Main chat interface
│   ├── settings/page.tsx      # Settings (17 sections)
│   └── skills/page.tsx        # Skill catalog + builder
├── lib/
│   ├── skill-*.ts             # Skill system (registry, handler, loader, eval, installer, sandbox)
│   ├── llm-client.ts          # OpenAI-compatible client with extended params
│   ├── anthropic-client.ts    # Anthropic adapter
│   ├── model-profiles.ts      # LLM + vision profile system
│   ├── vision-service.ts      # Vision model integration
│   ├── planner-loop.ts        # Plan execution with delegation
│   ├── compaction-service.ts  # Context summarization
│   ├── workspace-service.ts   # Sandboxed file operations
│   ├── code-sandbox.ts        # Python/Node.js execution
│   └── ...                    # pdf, weather, search, memory, google, homeassistant
├── skills/core/               # 22 core skill directories
│   └── [skill-name]/
│       ├── SKILL.md           # Manifest and documentation
│       ├── tools.ts           # Tool definitions
│       └── handler.ts         # Tool implementation
├── services/signal-bridge/    # Python Signal bridge
│   ├── bridge.py              # Main bridge + scheduler
│   ├── choom_client.py        # REST API client
│   ├── google_client.py       # Google API wrapper
│   └── signal_handler.py      # Message routing with name matching
├── prisma/
│   ├── schema.prisma          # SQLite schema
│   └── create-views.sql       # DB Browser views
└── package.json
```

## Setup

### Prerequisites

- Node.js 18+
- An LLM endpoint (LM Studio, Ollama, or cloud API key)

### Installation

```bash
git clone <repo-url>
cd nextjs-app
npm install
npx prisma db push
npx prisma generate
npm run db:seed           # Optional: seed initial data
cp .env.example .env      # Configure environment
npm run dev
```

### Environment Variables

```bash
# Required
LLM_ENDPOINT=http://localhost:1234/v1     # LM Studio / Ollama

# Optional services
VISION_ENDPOINT=http://localhost:1234      # Vision model
MEMORY_ENDPOINT=http://localhost:8100      # ChromaDB memory server
TTS_ENDPOINT=http://localhost:8004         # Text-to-speech
STT_ENDPOINT=http://localhost:5000         # Speech-to-text
IMAGE_GEN_ENDPOINT=http://localhost:7860   # Stable Diffusion / Forge

# Optional API keys
OPENWEATHER_API_KEY=                       # Weather data
BRAVE_API_KEY=                             # Web search
ANTHROPIC_API_KEY=                         # Anthropic LLM provider
OPENAI_API_KEY=                            # OpenAI LLM provider

# Google OAuth (for Gmail, Sheets, Drive, Calendar, YouTube, Contacts)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

### NPM Scripts

```bash
npm run dev            # Start app + memory server
npm run dev:app        # Start app only
npm run build          # Production build
npm run db:push        # Sync Prisma schema
npm run db:studio      # Visual DB editor
npm run db:views       # Create SQLite views
npm run db:seed        # Seed database
npm run test           # Run tests
npm run signal:logs    # Watch Signal bridge logs
npm run signal:restart # Restart Signal bridge
```

## Multi-Agent Setup Example

To set up an orchestrator Choom (e.g., Aloy) that delegates to specialists:

1. **Create Chooms** in the UI with appropriate system prompts and models
2. **Add skill directives** to the orchestrator's system prompt:
   ```
   <!-- allowed_skills: choom-delegation, plan-mode, workspace-files, web-searching, weather-forecasting -->
   <!-- max_iterations: 12 -->
   ```
3. **Test delegation**: Ask the orchestrator to "have [ChoomName] research [topic]"
4. **Plan Mode**: Ask multi-step questions — the orchestrator creates plans with delegate steps

### Delegation Flow

```
User → Orchestrator Choom
         ├── delegate_to_choom("Researcher", "Find info on X")
         │     └── Researcher runs tools → returns result
         ├── delegate_to_choom("Coder", "Build component for X")
         │     └── Coder runs tools → returns result
         └── Orchestrator synthesizes results → User
```

## Signal Bridge

The Signal bridge (`services/signal-bridge/`) enables messaging Chooms via Signal:

- Messages are routed to Chooms by name detection (e.g., "Aloy, check the weather")
- Voice transcription variants are handled (e.g., "alloy" → Aloy, "lisa" → Lissa)
- Supports TTS audio responses, image delivery, and notification scheduling
- Runs as a systemd service with Python scheduler for automations and cron jobs

## License

Private project.
