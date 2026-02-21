import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'list_spreadsheets',
    description:
      'List Google Spreadsheets accessible to the user. Returns name and URL for each spreadsheet.',
    parameters: {
      type: 'object',
      properties: {
        max_results: {
          type: 'number',
          description: 'Maximum number of spreadsheets to return (default 20).',
        },
      },
    },
  },
  {
    name: 'create_spreadsheet',
    description:
      'Create a new Google Spreadsheet. Optionally provide tab names and initial data rows.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the new spreadsheet.',
        },
        sheet_names: {
          type: 'array',
          description: 'Optional list of tab/sheet names to create (e.g. ["Income", "Expenses"]).',
          items: { type: 'string' },
        },
        initial_data: {
          type: 'array',
          description: 'Optional 2D array of initial data rows, e.g. [["Name","Amount"],["Rent","1200"]].',
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'read_sheet',
    description:
      'Read data from a Google Spreadsheet range. Returns rows of cell values.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID (from the URL or a previous create/list call).',
        },
        range: {
          type: 'string',
          description: 'A1 notation range to read, e.g. "Sheet1!A1:D10" or "Income!A:D".',
        },
      },
      required: ['spreadsheet_id', 'range'],
    },
  },
  {
    name: 'write_sheet',
    description:
      'Write (overwrite) data to a Google Spreadsheet range. Replaces existing values in the range.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID.',
        },
        range: {
          type: 'string',
          description: 'A1 notation range to write to, e.g. "Sheet1!A1:D10".',
        },
        values: {
          type: 'array',
          description: '2D array of values to write, e.g. [["Name","Amount"],["Rent","1200"]].',
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  {
    name: 'append_to_sheet',
    description:
      'Append rows to the end of a Google Spreadsheet range. Adds data after the last row with content.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: {
          type: 'string',
          description: 'The spreadsheet ID.',
        },
        range: {
          type: 'string',
          description: 'A1 notation range indicating the table to append to, e.g. "Sheet1!A:D".',
        },
        values: {
          type: 'array',
          description: '2D array of rows to append, e.g. [["Groceries","150"],["Gas","60"]].',
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
];
