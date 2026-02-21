import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'list_emails',
    description:
      'List recent emails from Gmail inbox. Use when the user asks to check their email, inbox, or recent messages.',
    parameters: {
      type: 'object',
      properties: {
        max_results: {
          type: 'number',
          description: 'Maximum number of emails to return (default 20, max 50)',
        },
        label: {
          type: 'string',
          description: 'Gmail label to filter by (default "INBOX"). Common labels: INBOX, SENT, DRAFT, SPAM, TRASH, STARRED, IMPORTANT',
        },
        query: {
          type: 'string',
          description: 'Gmail search query (e.g. "is:unread", "from:user@example.com", "subject:meeting")',
        },
      },
    },
  },
  {
    name: 'read_email',
    description:
      'Read the full content of a specific email. Use when the user wants to see the body of an email. Requires message_id from list_emails or search_emails.',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The Gmail message ID (from list_emails or search_emails results)',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'send_email',
    description:
      'Send a new email IMMEDIATELY. Only use this when the user explicitly says "send". If the user says "draft", "compose", "write", or "prepare" an email, use draft_email instead. This tool sends instantly and CANNOT be undone.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address',
        },
        subject: {
          type: 'string',
          description: 'Email subject line',
        },
        body: {
          type: 'string',
          description: 'Email body text (plain text)',
        },
        cc: {
          type: 'string',
          description: 'CC recipients (comma-separated email addresses)',
        },
        bcc: {
          type: 'string',
          description: 'BCC recipients (comma-separated email addresses)',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'draft_email',
    description:
      'Create an email draft in Gmail without sending it. Use when the user says "draft", "compose", "write", or "prepare" an email. The draft can be reviewed and sent later from Gmail. PREFER this over send_email unless the user explicitly says "send".',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address',
        },
        subject: {
          type: 'string',
          description: 'Email subject line',
        },
        body: {
          type: 'string',
          description: 'Email body text (plain text)',
        },
        cc: {
          type: 'string',
          description: 'CC recipients (comma-separated email addresses)',
        },
        bcc: {
          type: 'string',
          description: 'BCC recipients (comma-separated email addresses)',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'search_emails',
    description:
      'Search emails using Gmail search syntax. Use when the user wants to find specific emails by sender, subject, date, etc.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Gmail search query. Examples: "from:boss@company.com", "subject:invoice newer_than:7d", "has:attachment is:unread"',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results (default 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'archive_email',
    description:
      'Archive an email (remove from inbox). Use when the user wants to archive or clean up their inbox. Requires message_id.',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The Gmail message ID to archive',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'reply_to_email',
    description:
      'Reply to an existing email thread. Use when the user wants to respond to an email. Preserves the thread and adds proper reply headers.',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The Gmail message ID to reply to',
        },
        body: {
          type: 'string',
          description: 'Reply body text (plain text)',
        },
      },
      required: ['message_id', 'body'],
    },
  },
];
