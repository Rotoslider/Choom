import type { ToolDefinition } from './types';

// ============================================================================
// Memory Tools - Based on existing long_term_memory_mcp.py
// ============================================================================

export const memoryTools: ToolDefinition[] = [
  {
    name: 'remember',
    description:
      'Store a new memory (fact, preference, event, or conversation snippet). Use when the user shares something important to remember or explicitly asks you to remember something.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the memory',
        },
        content: {
          type: 'string',
          description: 'Full text content to store',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags, e.g., "personal, preference"',
        },
        importance: {
          type: 'number',
          description: 'Importance level 1-10 (default 5). Higher = more important.',
        },
        memory_type: {
          type: 'string',
          description: 'Category: "conversation", "fact", "preference", "event", "task", "ephemeral"',
          enum: ['conversation', 'fact', 'preference', 'event', 'task', 'ephemeral'],
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'search_memories',
    description:
      'Search memories using natural language queries. Use for general recall when the user asks about past conversations, facts, or preferences.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_by_type',
    description:
      'Retrieve memories by category/type. Use when the user asks for a specific category like "show me all my preferences".',
    parameters: {
      type: 'object',
      properties: {
        memory_type: {
          type: 'string',
          description: 'Category to search: "conversation", "fact", "preference", "event", "task", "ephemeral"',
          enum: ['conversation', 'fact', 'preference', 'event', 'task', 'ephemeral'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 20)',
        },
      },
      required: ['memory_type'],
    },
  },
  {
    name: 'search_by_tags',
    description:
      'Find memories by specific tags. Use when the user mentions specific topics or themes to search for.',
    parameters: {
      type: 'object',
      properties: {
        tags: {
          type: 'string',
          description: 'Comma-separated tags to search for, e.g., "camping, truck"',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 20)',
        },
      },
      required: ['tags'],
    },
  },
  {
    name: 'get_recent_memories',
    description:
      'Get the most recently stored memories. Use for timeline-based recall like "what did we discuss today" or "recently".',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 20)',
        },
      },
    },
  },
  {
    name: 'search_by_date_range',
    description:
      'Find memories within a specific date range. Use when the user mentions specific dates.',
    parameters: {
      type: 'object',
      properties: {
        date_from: {
          type: 'string',
          description: 'Start date in ISO format, e.g., "2025-01-01"',
        },
        date_to: {
          type: 'string',
          description: 'End date in ISO format (defaults to now if omitted)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 50)',
        },
      },
      required: ['date_from'],
    },
  },
  {
    name: 'update_memory',
    description:
      'Update an existing memory by ID. Use when the user wants to correct or modify stored information.',
    parameters: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'The unique ID of the memory to update',
        },
        title: {
          type: 'string',
          description: 'New title (optional)',
        },
        content: {
          type: 'string',
          description: 'New content (optional)',
        },
        tags: {
          type: 'string',
          description: 'New comma-separated tags (optional)',
        },
        importance: {
          type: 'number',
          description: 'New importance 1-10 (optional)',
        },
        memory_type: {
          type: 'string',
          description: 'New category (optional)',
          enum: ['conversation', 'fact', 'preference', 'event', 'task', 'ephemeral'],
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'delete_memory',
    description:
      'Permanently delete a memory by ID. Use when the user explicitly asks to forget or erase something.',
    parameters: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'The unique ID of the memory to delete',
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'get_memory_stats',
    description:
      'Get statistics about the memory system. Use when the user asks about memory capacity or status.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

// ============================================================================
// Utility Tools
// ============================================================================

export const utilityTools: ToolDefinition[] = [
  {
    name: 'generate_image',
    description:
      'Generate an image using Stable Diffusion. Use when the user requests an image, picture, or artwork. Use self_portrait mode when generating an image of yourself.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate. For self-portraits, describe the scene, pose, expression, and setting.',
        },
        self_portrait: {
          type: 'boolean',
          description: 'Set to true when generating a picture of yourself/the AI companion. Uses your character-specific settings.',
        },
        negative_prompt: {
          type: 'string',
          description: 'Things to avoid in the image (optional, uses defaults if not specified)',
        },
        size: {
          type: 'string',
          description: 'Image size preset: "small" (768px), "medium" (1024px), "large" (1536px), "x-large" (1856px). Controls the longest dimension.',
          enum: ['small', 'medium', 'large', 'x-large'],
        },
        aspect: {
          type: 'string',
          description: 'Image aspect ratio: "portrait" (3:4), "portrait-tall" (9:16), "square" (1:1), "landscape" (16:9), "wide" (21:9). For self-portraits, prefer "portrait" or "portrait-tall".',
          enum: ['portrait', 'portrait-tall', 'square', 'landscape', 'wide'],
        },
        width: {
          type: 'number',
          description: 'Image width in pixels (optional, overrides size/aspect if set)',
        },
        height: {
          type: 'number',
          description: 'Image height in pixels (optional, overrides size/aspect if set)',
        },
        steps: {
          type: 'number',
          description: 'Number of generation steps (optional, uses mode defaults)',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for current information. Use when the user asks about recent events, current information, or things you need to look up.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results (default 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_weather',
    description:
      'Get CURRENT weather conditions. Use for "what\'s the weather now", "current temp", "is it raining". Omit location for user\'s home area, or pass a city name for a different location.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name (e.g. "Denver, CO"). Omit for user\'s home location.',
        },
      },
    },
  },
  {
    name: 'get_weather_forecast',
    description:
      'Get 5-day weather FORECAST. Use when user asks about FUTURE weather: "tomorrow", "this week", "will it rain", "forecast", "weekend weather". For current conditions use get_weather instead.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name (e.g. "Denver, CO"). Omit for user\'s home location.',
        },
        days: {
          type: 'number',
          description: 'Number of forecast days (1-5, default 5)',
        },
      },
    },
  },
];

// ============================================================================
// Google Tools - Calendar, Tasks, Reminders
// ============================================================================

export const googleTools: ToolDefinition[] = [
  {
    name: 'get_calendar_events',
    description:
      'Get calendar events — upcoming and/or past. Use when the user asks about their calendar, schedule, or "what\'s on my calendar". Use days_back for past events like "what did I have last week".',
    parameters: {
      type: 'object',
      properties: {
        days_ahead: {
          type: 'number',
          description: 'Number of days to look ahead (default 7)',
        },
        days_back: {
          type: 'number',
          description: 'Number of days to look backward. Use when asking about past events (e.g. "last week" = 7, "last month" = 30)',
        },
        query: {
          type: 'string',
          description: 'Optional search filter to match event titles/descriptions',
        },
      },
    },
  },
  {
    name: 'list_task_lists',
    description:
      'List all available Google Task list names. Use this FIRST when you are unsure of the exact list name, or when the user asks "what lists do I have".',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_task_list',
    description:
      'Get items from a Google Tasks list. Use when the user asks about a list like "what\'s on my groceries list" or "show my to do list".',
    parameters: {
      type: 'object',
      properties: {
        list_name: {
          type: 'string',
          description: 'Name of the task list (e.g. "groceries", "hardware store", "to do")',
        },
      },
      required: ['list_name'],
    },
  },
  {
    name: 'add_to_task_list',
    description:
      'Add an item to a Google Tasks list. Use when the user says "add X to my Y list" or "put X on the groceries list".',
    parameters: {
      type: 'object',
      properties: {
        list_name: {
          type: 'string',
          description: 'Name of the task list (e.g. "groceries", "hardware store", "to do")',
        },
        item_title: {
          type: 'string',
          description: 'Title of the item to add',
        },
        notes: {
          type: 'string',
          description: 'Optional notes or description for the item',
        },
      },
      required: ['list_name', 'item_title'],
    },
  },
  {
    name: 'remove_from_task_list',
    description:
      'Remove an item from a Google Tasks list. Use when the user says "remove X from my Y list" or "take X off the groceries list".',
    parameters: {
      type: 'object',
      properties: {
        list_name: {
          type: 'string',
          description: 'Name of the task list (e.g. "groceries", "hardware store", "to do")',
        },
        item_title: {
          type: 'string',
          description: 'Title of the item to remove (case-insensitive match)',
        },
      },
      required: ['list_name', 'item_title'],
    },
  },
  {
    name: 'create_reminder',
    description:
      'Set a timed reminder that will be delivered via Signal message. Use when the user says "remind me in X minutes to Y" or "set a reminder for 3pm to Z". IMPORTANT: For the time parameter, always use 12-hour format with colon like "4:00 PM" (not "4pm" or "4 PM"). The text should contain only the reminder message, not time abbreviations.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The reminder message text only (no time or a.m./p.m. in the text)',
        },
        minutes_from_now: {
          type: 'number',
          description: 'Minutes from now to send the reminder (e.g. 30 for "in 30 minutes")',
        },
        time: {
          type: 'string',
          description: 'Specific time in 12-hour format with colon (e.g. "4:00 PM", "3:30 AM") or 24-hour format (e.g. "15:00"). Use this OR minutes_from_now, not both.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_reminders',
    description:
      'Get all pending reminders. Use when the user asks "do I have any reminders", "what are my reminders", "show reminders", or asks about upcoming scheduled reminders.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Optional date filter in ISO format (e.g. "2026-02-09"). Only returns reminders for that date.',
        },
      },
    },
  },
  // Calendar Write
  {
    name: 'create_calendar_event',
    description:
      'Create a new Google Calendar event. Use when the user says "add to my calendar", "schedule a meeting", "set an appointment", or asks to create any calendar event.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Event title (e.g. "Dentist appointment", "Team meeting")',
        },
        start_time: {
          type: 'string',
          description: 'Start time in ISO 8601 format (e.g. "2026-02-10T14:00:00"). For all-day events, just the date "2026-02-10".',
        },
        end_time: {
          type: 'string',
          description: 'End time in ISO 8601 format. For all-day events, the day after (e.g. "2026-02-11"). If not provided, defaults to 1 hour after start.',
        },
        description: {
          type: 'string',
          description: 'Optional event description or notes',
        },
        location: {
          type: 'string',
          description: 'Optional event location',
        },
        all_day: {
          type: 'boolean',
          description: 'Set to true for all-day events (default false)',
        },
      },
      required: ['summary', 'start_time'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Update an existing Google Calendar event. Use when the user says "reschedule", "move my appointment", "change the meeting time", or wants to modify an event. Requires the event ID (get it from get_calendar_events first).',
    parameters: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The Google Calendar event ID (from get_calendar_events results)',
        },
        summary: {
          type: 'string',
          description: 'New event title (optional)',
        },
        start_time: {
          type: 'string',
          description: 'New start time in ISO 8601 format (optional)',
        },
        end_time: {
          type: 'string',
          description: 'New end time in ISO 8601 format (optional)',
        },
        description: {
          type: 'string',
          description: 'New event description (optional)',
        },
        location: {
          type: 'string',
          description: 'New event location (optional)',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete a Google Calendar event. Use when the user says "cancel my appointment", "remove the meeting", or "delete from calendar". Requires the event ID (get it from get_calendar_events first).',
    parameters: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'The Google Calendar event ID (from get_calendar_events results)',
        },
      },
      required: ['event_id'],
    },
  },
];

// ============================================================================
// Google Sheets Tools
// ============================================================================

export const sheetsTools: ToolDefinition[] = [
  {
    name: 'list_spreadsheets',
    description:
      'List recent Google Spreadsheets. Use when the user asks "what spreadsheets do I have", "show my sheets", or needs to find a spreadsheet.',
    parameters: {
      type: 'object',
      properties: {
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default 20)',
        },
      },
    },
  },
  {
    name: 'create_spreadsheet',
    description:
      'Create a new Google Spreadsheet. Use when the user asks to "create a spreadsheet", "make a budget sheet", "start a tracker", or needs a new spreadsheet for data.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Spreadsheet title (e.g. "February Budget", "Project Tracker")',
        },
        sheet_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of sheet/tab names (e.g. ["Income", "Expenses", "Summary"]). Defaults to "Sheet1".',
        },
        initial_data: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Optional 2D array of initial data to populate the first sheet (e.g. [["Name", "Amount"], ["Rent", "1200"]])',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'read_sheet',
    description:
      'Read data from a Google Spreadsheet. Use when the user asks to "read my spreadsheet", "show the budget data", or needs to see spreadsheet content.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID (from list_spreadsheets or create_spreadsheet)',
        },
        range: {
          type: 'string',
          description: 'A1 notation range (e.g. "Sheet1!A1:D10", "Sheet1!A:A", "Sheet1"). Defaults to entire first sheet.',
        },
      },
      required: ['spreadsheet_id', 'range'],
    },
  },
  {
    name: 'write_sheet',
    description:
      'Write data to a Google Spreadsheet (overwrites existing data in the range). Use for updating specific cells or ranges.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID',
        },
        range: {
          type: 'string',
          description: 'A1 notation range to write to (e.g. "Sheet1!A1:C3")',
        },
        values: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: '2D array of values to write (e.g. [["Name", "Amount"], ["Rent", "1200"]])',
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  {
    name: 'append_to_sheet',
    description:
      'Append rows to end of a Google Spreadsheet. Use for logging data, adding new entries to a tracker, or adding rows without overwriting.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID',
        },
        range: {
          type: 'string',
          description: 'A1 notation range that defines the table (e.g. "Sheet1!A:D"). New rows append after existing data.',
        },
        values: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: '2D array of rows to append (e.g. [["2026-02-09", "Groceries", "45.50"]])',
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
];

// ============================================================================
// Google Docs Tools
// ============================================================================

export const docsTools: ToolDefinition[] = [
  {
    name: 'list_documents',
    description:
      'List recent Google Docs. Use when the user asks "what documents do I have", "show my docs", or needs to find a document.',
    parameters: {
      type: 'object',
      properties: {
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default 20)',
        },
      },
    },
  },
  {
    name: 'create_document',
    description:
      'Create a new Google Doc with plain text content. Use when the user asks to "write a report", "create a document", "draft a letter", or needs a new Google Doc.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Document title',
        },
        content: {
          type: 'string',
          description: 'Plain text content for the document. Use newlines for paragraphs.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'read_document',
    description:
      'Read text content from a Google Doc. Use when the user asks to "read my document", "show the report", or needs to see document content.',
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'The Google Doc ID (from list_documents or create_document)',
        },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'append_to_document',
    description:
      'Append text to the end of an existing Google Doc. Use when the user asks to "add to the document", "update the report", or wants to append content.',
    parameters: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'The Google Doc ID',
        },
        text: {
          type: 'string',
          description: 'Text to append to the end of the document',
        },
      },
      required: ['document_id', 'text'],
    },
  },
];

// ============================================================================
// Google Drive Tools
// ============================================================================

export const driveTools: ToolDefinition[] = [
  {
    name: 'list_drive_files',
    description:
      'List files in Google Drive. Use when the user asks "what\'s in my Drive", "show my Drive files", or needs to browse Drive contents.',
    parameters: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'string',
          description: 'Optional folder ID to list contents of a specific folder. Omit for root.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default 20)',
        },
      },
    },
  },
  {
    name: 'search_drive',
    description:
      'Search for files by name in Google Drive. Use when the user asks to "find a file", "search Drive for...", or needs to locate a specific file.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against file names',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_drive_folder',
    description:
      'Create a folder in Google Drive. Use when the user asks to "create a folder in Drive", "organize my Drive", or needs a new folder.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Folder name',
        },
        parent_id: {
          type: 'string',
          description: 'Optional parent folder ID. Omit for root of My Drive.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'upload_to_drive',
    description:
      'Upload a file from the workspace to Google Drive. Use when the user asks to "back up to Drive", "save to Drive", "upload to Drive", or wants to store workspace files in Google Drive.',
    parameters: {
      type: 'object',
      properties: {
        workspace_path: {
          type: 'string',
          description: 'Relative path to the file in the workspace (e.g. "reports/summary.pdf")',
        },
        folder_id: {
          type: 'string',
          description: 'Optional Drive folder ID to upload into',
        },
        drive_filename: {
          type: 'string',
          description: 'Optional filename override for the Drive file (defaults to workspace filename)',
        },
      },
      required: ['workspace_path'],
    },
  },
  {
    name: 'download_from_drive',
    description:
      'Download a file from Google Drive to the workspace. Google Docs are exported as plain text, Sheets as CSV, other files downloaded as-is.',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'The Drive file ID (from list_drive_files or search_drive)',
        },
        workspace_path: {
          type: 'string',
          description: 'Relative workspace path to save the file to (e.g. "downloads/report.txt")',
        },
      },
      required: ['file_id', 'workspace_path'],
    },
  },
];

// ============================================================================
// Workspace Tools
// ============================================================================

export const workspaceTools: ToolDefinition[] = [
  {
    name: 'workspace_write_file',
    description:
      'Write or create a file in the project workspace. Use for saving reports, code, notes, or any text content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within workspace (e.g. "reports/summary.md", "code/script.py")',
        },
        content: {
          type: 'string',
          description: 'File content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'workspace_read_file',
    description:
      'Read a file from the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within workspace',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'workspace_list_files',
    description:
      'List files and folders in the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory path (omit for workspace root)',
        },
      },
    },
  },
  {
    name: 'workspace_create_folder',
    description:
      'Create a folder in the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative folder path to create',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'workspace_delete_file',
    description:
      'Delete a file from the project workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path of file to delete',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'workspace_rename_project',
    description:
      'Rename a project folder in the workspace. Updates the folder name and project metadata. Use when the user asks to rename, move, or change the name of a project.',
    parameters: {
      type: 'object',
      properties: {
        old_name: {
          type: 'string',
          description: 'Current project folder name (e.g. "My_Old_Project")',
        },
        new_name: {
          type: 'string',
          description: 'New project name (e.g. "My_New_Project"). Spaces will be converted to underscores.',
        },
      },
      required: ['old_name', 'new_name'],
    },
  },
  {
    name: 'workspace_generate_pdf',
    description:
      'Generate a PDF from markdown content or an existing markdown file in the workspace. Supports embedded images via markdown ![caption](path) syntax or an explicit images array.',
    parameters: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Path to existing .md file to convert (use this OR content, not both)',
        },
        content: {
          type: 'string',
          description: 'Markdown content to convert to PDF (use this OR source_path, not both). Use ![caption](workspace/path.png) to embed images.',
        },
        output_path: {
          type: 'string',
          description: 'Output PDF path (e.g. "reports/summary.pdf")',
        },
        title: {
          type: 'string',
          description: 'Optional document title',
        },
        images: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Workspace-relative path to the image (e.g. "My_Project/images/photo.png")',
              },
              width: {
                type: 'number',
                description: 'Optional max width in points (default: fit page width, ~468pt)',
              },
              caption: {
                type: 'string',
                description: 'Optional caption displayed below the image',
              },
            },
            required: ['path'],
          },
          description: 'Optional array of workspace images to embed. Images referenced in markdown ![](path) are auto-resolved; use this for additional images not in the markdown.',
        },
      },
      required: ['output_path'],
    },
  },
  {
    name: 'workspace_read_pdf',
    description:
      'Extract text content from a PDF file in the workspace. Use when you need to read, summarize, or analyze a PDF document. Returns the extracted text. For large PDFs, use page_start/page_end to read specific sections.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the PDF file in workspace (e.g. "research/paper.pdf")',
        },
        page_start: {
          type: 'number',
          description: 'First page to extract (1-based, optional)',
        },
        page_end: {
          type: 'number',
          description: 'Last page to extract (optional)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'send_notification',
    description:
      'Send a Signal message notification to the user. Use when a long task is complete, you found something interesting, or need the user\'s attention.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Notification message text',
        },
        include_audio: {
          type: 'boolean',
          description: 'Whether to include TTS audio (default true)',
        },
      },
      required: ['message'],
    },
  },
];

// ============================================================================
// Vision Tools
// ============================================================================

export const visionTools: ToolDefinition[] = [
  {
    name: 'analyze_image',
    description:
      'Analyze an image using a vision-capable LLM. Use when the user asks you to look at, describe, analyze, or answer questions about an image. Can read images from the workspace, a URL, raw base64 data, or a previously generated image by ID.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to analyze or describe about the image (e.g. "Describe this image in detail", "What objects are visible?", "Read the text in this image")',
        },
        image_path: {
          type: 'string',
          description: 'Relative path to an image file in the workspace (e.g. "photos/sample.png")',
        },
        image_url: {
          type: 'string',
          description: 'URL of an image to analyze (will be fetched and base64-encoded)',
        },
        image_base64: {
          type: 'string',
          description: 'Raw base64-encoded image data',
        },
        image_id: {
          type: 'string',
          description: 'ID of a previously generated image (from generate_image result). Use this to analyze your own generated images.',
        },
        mime_type: {
          type: 'string',
          description: 'MIME type of the image (default: auto-detected or image/png)',
        },
      },
      required: ['prompt'],
    },
  },
];

// ============================================================================
// Code Sandbox Tools
// ============================================================================

export const sandboxTools: ToolDefinition[] = [
  {
    name: 'execute_code',
    description:
      'Execute Python or Node.js code in a project workspace folder. Code runs in a temporary file that is automatically cleaned up. Use for testing, data processing, calculations, or running scripts. If a Python venv exists in the project, it will be used automatically.',
    parameters: {
      type: 'object',
      properties: {
        project_folder: {
          type: 'string',
          description: 'Project folder name in workspace (e.g. "My_Project")',
        },
        language: {
          type: 'string',
          description: 'Programming language to execute',
          enum: ['python', 'node'],
        },
        code: {
          type: 'string',
          description: 'The code to execute',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Maximum execution time in seconds (default 30, max 120)',
        },
      },
      required: ['project_folder', 'language', 'code'],
    },
  },
  {
    name: 'create_venv',
    description:
      'Create a Python virtual environment (venv) or initialize a Node.js project (npm init) in a workspace folder. Do this BEFORE installing packages.',
    parameters: {
      type: 'object',
      properties: {
        project_folder: {
          type: 'string',
          description: 'Project folder name in workspace',
        },
        runtime: {
          type: 'string',
          description: 'Runtime to initialize',
          enum: ['python', 'node'],
        },
      },
      required: ['project_folder', 'runtime'],
    },
  },
  {
    name: 'install_package',
    description:
      'Install packages via pip (Python) or npm (Node.js) in a project folder. For Python, creates/uses venv automatically. For Node.js, uses npm install. Create the venv/project first with create_venv.',
    parameters: {
      type: 'object',
      properties: {
        project_folder: {
          type: 'string',
          description: 'Project folder name in workspace',
        },
        runtime: {
          type: 'string',
          description: 'Package manager to use',
          enum: ['python', 'node'],
        },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of package names to install (e.g. ["requests", "pandas"] or ["axios", "express"])',
        },
      },
      required: ['project_folder', 'runtime', 'packages'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in a project workspace folder. Use for git commands, file operations, running scripts, or any other shell tasks. If a Python venv exists, it is auto-activated.',
    parameters: {
      type: 'object',
      properties: {
        project_folder: {
          type: 'string',
          description: 'Project folder name in workspace',
        },
        command: {
          type: 'string',
          description: 'Shell command to execute (runs in bash)',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Maximum execution time in seconds (default 30, max 120)',
        },
      },
      required: ['project_folder', 'command'],
    },
  },
];

// ============================================================================
// Web Image Download Tool
// ============================================================================

export const downloadTools: ToolDefinition[] = [
  {
    name: 'download_web_image',
    description:
      'Download an image from a URL and save it to the project workspace. Use during research to save reference images, diagrams, screenshots, or other visual assets. The image will be validated (must be image/* content-type) and optionally resized.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the image to download (must serve image/* content-type)',
        },
        save_path: {
          type: 'string',
          description: 'Relative path in workspace to save the image (e.g. "research/diagram.png", "images/reference.jpg")',
        },
        resize_max: {
          type: 'number',
          description: 'Optional: maximum dimension in pixels. Image will be resized to fit within this size while maintaining aspect ratio.',
        },
      },
      required: ['url', 'save_path'],
    },
  },
  {
    name: 'scrape_page_images',
    description:
      'Fetch a webpage and extract all image URLs from the HTML. Use this BEFORE download_web_image to find real image URLs — never guess CDN URLs. Returns a list of image URLs found on the page (from img src, srcset, og:image meta tags, etc.).',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the webpage to scrape for images (e.g. a product page, article, gallery)',
        },
        min_width: {
          type: 'number',
          description: 'Optional minimum image width to filter (ignores tiny icons/spacers). Default: 100',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of image URLs to return (default 20)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'download_web_file',
    description:
      'Download any file from a URL and save it to the project workspace. Use for PDFs, documents, archives, data files, or any non-image file. For images, prefer download_web_image instead (it supports resizing). The file extension in save_path must match the content being downloaded.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the file to download',
        },
        save_path: {
          type: 'string',
          description: 'Relative path in workspace to save the file (e.g. "research/paper.pdf", "data/dataset.csv")',
        },
      },
      required: ['url', 'save_path'],
    },
  },
];

// ============================================================================
// Combined Tools
// ============================================================================

export const allTools: ToolDefinition[] = [
  ...memoryTools, ...utilityTools, ...googleTools,
  ...sheetsTools, ...docsTools, ...driveTools,
  ...workspaceTools, ...visionTools, ...downloadTools,
  ...sandboxTools,
];

// Get tools by category
export function getToolsByCategory(
  category: 'memory' | 'utility' | 'all'
): ToolDefinition[] {
  switch (category) {
    case 'memory':
      return memoryTools;
    case 'utility':
      return utilityTools;
    case 'all':
    default:
      return allTools;
  }
}

// ============================================================================
// Skill Registry Bridge
// When USE_SKILL_DISPATCH=true, tools are served from the skill registry.
// This function initializes the registry and returns all skill-based tools.
// ============================================================================

import { loadCoreSkills } from './skill-loader';
import { getSkillRegistry } from './skill-registry';

/**
 * Get all tool definitions from the skill registry.
 * Loads core skills on first call. Returns the same array format as allTools.
 * Used by route.ts when USE_SKILL_DISPATCH=true.
 */
export function getAllToolsFromSkills(): ToolDefinition[] {
  loadCoreSkills();
  return getSkillRegistry().getAllToolDefinitions();
}

/**
 * Check if skill-based dispatch is enabled.
 * Defaults to true. Set USE_SKILL_DISPATCH=false to revert to old dispatch.
 */
export function useSkillDispatch(): boolean {
  return process.env.USE_SKILL_DISPATCH !== 'false';
}
