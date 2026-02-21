import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
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
];
