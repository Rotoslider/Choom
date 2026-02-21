import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'remember',
    description: 'Store a new memory (fact, preference, event, or conversation snippet). Use when the user shares something important to remember or explicitly asks you to remember something.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the memory' },
        content: { type: 'string', description: 'Full text content to store' },
        tags: { type: 'string', description: 'Comma-separated tags, e.g., "personal, preference"' },
        importance: { type: 'number', description: 'Importance level 1-10 (default 5). Higher = more important.' },
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
    description: 'Search memories using natural language queries. Use for general recall when the user asks about past conversations, facts, or preferences.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Maximum results to return (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_by_type',
    description: 'Retrieve memories by category/type. Use when the user asks for a specific category like "show me all my preferences".',
    parameters: {
      type: 'object',
      properties: {
        memory_type: {
          type: 'string',
          description: 'Category to search: "conversation", "fact", "preference", "event", "task", "ephemeral"',
          enum: ['conversation', 'fact', 'preference', 'event', 'task', 'ephemeral'],
        },
        limit: { type: 'number', description: 'Maximum results to return (default 20)' },
      },
      required: ['memory_type'],
    },
  },
  {
    name: 'search_by_tags',
    description: 'Find memories by specific tags. Use when the user mentions specific topics or themes to search for.',
    parameters: {
      type: 'object',
      properties: {
        tags: { type: 'string', description: 'Comma-separated tags to search for, e.g., "camping, truck"' },
        limit: { type: 'number', description: 'Maximum results to return (default 20)' },
      },
      required: ['tags'],
    },
  },
  {
    name: 'get_recent_memories',
    description: 'Get the most recently stored memories. Use for timeline-based recall like "what did we discuss today" or "recently".',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum results to return (default 20)' },
      },
    },
  },
  {
    name: 'search_by_date_range',
    description: 'Find memories within a specific date range. Use when the user mentions specific dates.',
    parameters: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Start date in ISO format, e.g., "2025-01-01"' },
        date_to: { type: 'string', description: 'End date in ISO format (defaults to now if omitted)' },
        limit: { type: 'number', description: 'Maximum results to return (default 50)' },
      },
      required: ['date_from'],
    },
  },
  {
    name: 'update_memory',
    description: 'Update an existing memory by ID. Use when the user wants to correct or modify stored information.',
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'The unique ID of the memory to update' },
        title: { type: 'string', description: 'New title (optional)' },
        content: { type: 'string', description: 'New content (optional)' },
        tags: { type: 'string', description: 'New comma-separated tags (optional)' },
        importance: { type: 'number', description: 'New importance 1-10 (optional)' },
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
    description: 'Permanently delete a memory by ID. Use when the user explicitly asks to forget or erase something.',
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'The unique ID of the memory to delete' },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'get_memory_stats',
    description: 'Get statistics about the memory system. Use when the user asks about memory capacity or status.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];
