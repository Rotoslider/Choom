import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { getGoogleClient } from '@/lib/google-client';

const CONTACTS_TOOLS = new Set([
  'search_contacts',
  'get_contact',
]);

export default class GoogleContactsHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return CONTACTS_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'search_contacts':
        return this.searchContacts(toolCall);
      case 'get_contact':
        return this.getContact(toolCall);
      default:
        return this.error(toolCall, `Unknown contacts tool: ${toolCall.name}`);
    }
  }

  private async searchContacts(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const query = toolCall.arguments.query as string;
      const maxResults = Math.min((toolCall.arguments.max_results as number) || 10, 30);

      if (!query) return this.error(toolCall, 'query is required');

      const client = getGoogleClient();
      const contacts = await client.searchContacts(query, maxResults);

      const formatted = contacts.length === 0
        ? 'No contacts found.'
        : contacts.map(c => {
            const parts = [c.name];
            if (c.email) parts.push(c.email);
            if (c.phone) parts.push(c.phone);
            return `- ${parts.join(' | ')}`;
          }).join('\n');

      console.log(`   👤 Contacts: ${contacts.length} results for "${query}"`);
      return this.success(toolCall, { success: true, contacts, formatted, count: contacts.length });
    } catch (err) {
      console.error('   ❌ Contacts search error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Contacts search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async getContact(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const resourceName = toolCall.arguments.resource_name as string;
      if (!resourceName) return this.error(toolCall, 'resource_name is required');

      const client = getGoogleClient();
      const contact = await client.getContact(resourceName);

      console.log(`   👤 Contacts: retrieved ${contact.name || resourceName}`);
      return this.success(toolCall, { success: true, contact });
    } catch (err) {
      console.error('   ❌ Contacts get error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Contacts get failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
