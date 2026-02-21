import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'search_contacts',
    description:
      'Search Google Contacts by name or email. Use when the user asks "who is...", "find contact for...", or needs someone\'s phone number or email.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — name, email, or phone number',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results (default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_contact',
    description:
      'Get full details for a specific Google Contact. Requires resource_name from search_contacts results.',
    parameters: {
      type: 'object',
      properties: {
        resource_name: {
          type: 'string',
          description: 'The contact resource name (e.g. "people/c1234567890") from search_contacts results',
        },
      },
      required: ['resource_name'],
    },
  },
];
