import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { getGoogleClient } from '@/lib/google-client';
import { promises as dns } from 'dns';

const EMAIL_FMT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Guidance appended whenever a recipient is rejected. Chooms invent "creative"
// addresses to reach each other or Donny; those bounce out of the real Gmail
// account. Point them at the channels that actually work.
const NON_EMAIL_CHANNELS =
  'Email is ONLY for real, external people — never for reaching a sibling Choom or Donny. ' +
  'To reach another Choom, use delegate_to_choom, or leave them a letter with ' +
  'workspace_write_file (path "<their_name>_inbox/…"). To reach Donny, use send_notification (Signal). ' +
  'If this really is a real person, verify the exact address with the user or search_contacts first.';

/**
 * Can `domain` actually receive mail? Checks MX, then falls back to A/AAAA
 * (RFC 5321 implicit MX). Returns:
 *   'ok'      — has a mail-capable record
 *   'no-mail' — domain resolves to nothing / has no usable record (will bounce)
 *   'unknown' — transient DNS failure (SERVFAIL/timeout) → caller should fail OPEN
 */
async function domainMailStatus(domain: string): Promise<'ok' | 'no-mail' | 'unknown'> {
  const withTimeout = <T,>(p: Promise<T>): Promise<T | 'timeout'> =>
    Promise.race([p, new Promise<'timeout'>(res => setTimeout(() => res('timeout'), 4000))]);
  const isMissing = (e: unknown) => {
    const code = (e as { code?: string })?.code;
    return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
  };
  try {
    const mx = await withTimeout(dns.resolveMx(domain));
    if (mx === 'timeout') return 'unknown';
    if (Array.isArray(mx) && mx.length > 0) return 'ok';
  } catch (e) {
    if (!isMissing(e)) return 'unknown'; // SERVFAIL etc. — don't block on transient
  }
  // No MX — try implicit A/AAAA record.
  try {
    const a = await withTimeout(dns.resolve(domain));
    if (a === 'timeout') return 'unknown';
    if (Array.isArray(a) && a.length > 0) return 'ok';
    return 'no-mail';
  } catch (e) {
    return isMissing(e) ? 'no-mail' : 'unknown';
  }
}

const GMAIL_TOOLS = new Set([
  'list_emails',
  'read_email',
  'send_email',
  'draft_email',
  'search_emails',
  'archive_email',
  'reply_to_email',
]);

export default class GoogleGmailHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return GMAIL_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'list_emails':
        return this.listEmails(toolCall);
      case 'read_email':
        return this.readEmail(toolCall);
      case 'send_email':
        return this.sendEmail(toolCall);
      case 'draft_email':
        return this.draftEmail(toolCall);
      case 'search_emails':
        return this.searchEmails(toolCall);
      case 'archive_email':
        return this.archiveEmail(toolCall);
      case 'reply_to_email':
        return this.replyToEmail(toolCall);
      default:
        return this.error(toolCall, `Unknown Gmail tool: ${toolCall.name}`);
    }
  }

  private async listEmails(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const maxResults = Math.min((toolCall.arguments.max_results as number) || 20, 50);
      const label = (toolCall.arguments.label as string) || 'INBOX';
      const query = toolCall.arguments.query as string | undefined;

      const client = getGoogleClient();
      const emails = await client.listEmails(maxResults, label, query);

      const formatted = emails.length === 0
        ? 'No emails found.'
        : emails.map(e =>
            `- ${e.from} | ${e.subject} (${e.date})${e.snippet ? ` — ${e.snippet}` : ''}`
          ).join('\n');

      console.log(`   📧 Gmail: ${emails.length} emails listed`);
      return this.success(toolCall, { success: true, emails, formatted, count: emails.length });
    } catch (err) {
      console.error('   ❌ Gmail list error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Gmail list failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async readEmail(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const messageId = toolCall.arguments.message_id as string;
      if (!messageId) return this.error(toolCall, 'message_id is required');

      const client = getGoogleClient();
      const email = await client.readEmail(messageId);

      console.log(`   📧 Gmail: read email "${email.subject}"`);
      return this.success(toolCall, { success: true, email });
    } catch (err) {
      console.error('   ❌ Gmail read error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Gmail read failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate every recipient across to/cc/bcc: well-formed address AND a domain
   * that can actually receive mail. Returns a ToolResult error to short-circuit
   * the send, or null if all recipients are deliverable. This is the guardrail
   * against Chooms inventing addresses that bounce out of the real Gmail account.
   */
  private async validateRecipients(toolCall: ToolCall, to: string, cc?: string, bcc?: string): Promise<ToolResult | null> {
    const addrs = [to, cc, bcc]
      .filter(Boolean)
      .join(',')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      // Accept "Display Name <addr@x.com>" — pull the address out of the angle brackets.
      .map(a => { const m = a.match(/<([^>]+)>/); return (m ? m[1] : a).trim(); });

    const badFormat = addrs.filter(a => !EMAIL_FMT.test(a));
    if (badFormat.length) {
      return this.error(toolCall, `Not a valid email address: ${badFormat.join(', ')}. ${NON_EMAIL_CHANNELS}`);
    }

    const domains = [...new Set(addrs.map(a => a.split('@')[1].toLowerCase()))];
    const unreachable: string[] = [];
    for (const d of domains) {
      if ((await domainMailStatus(d)) === 'no-mail') unreachable.push(d);
    }
    if (unreachable.length) {
      return this.error(
        toolCall,
        `These recipient domains can't receive email — they don't exist or have no mail server, so the message would bounce: ${unreachable.join(', ')}. This usually means the address was made up. ${NON_EMAIL_CHANNELS}`
      );
    }
    return null;
  }

  private async sendEmail(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const to = toolCall.arguments.to as string;
      const subject = toolCall.arguments.subject as string;
      const body = toolCall.arguments.body as string;
      const cc = toolCall.arguments.cc as string | undefined;
      const bcc = toolCall.arguments.bcc as string | undefined;

      if (!to || !subject || !body) return this.error(toolCall, 'to, subject, and body are required');

      const invalid = await this.validateRecipients(toolCall, to, cc, bcc);
      if (invalid) return invalid;

      const client = getGoogleClient();
      const result = await client.sendEmail(to, subject, body, cc, bcc);

      console.log(`   📧 Gmail: sent email to ${to} — "${subject}"`);
      return this.success(toolCall, { success: true, ...result, message: `Email sent to ${to}.` });
    } catch (err) {
      console.error('   ❌ Gmail send error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Gmail send failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async draftEmail(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const to = toolCall.arguments.to as string;
      const subject = toolCall.arguments.subject as string;
      const body = toolCall.arguments.body as string;
      const cc = toolCall.arguments.cc as string | undefined;
      const bcc = toolCall.arguments.bcc as string | undefined;

      if (!to || !subject || !body) return this.error(toolCall, 'to, subject, and body are required');

      const invalid = await this.validateRecipients(toolCall, to, cc, bcc);
      if (invalid) return invalid;

      const client = getGoogleClient();
      const result = await client.createDraft(to, subject, body, cc, bcc);

      console.log(`   📧 Gmail: created draft to ${to} — "${subject}"`);
      return this.success(toolCall, { success: true, ...result, message: `Draft created for ${to}. The user can review and send it from Gmail.` });
    } catch (err) {
      console.error('   ❌ Gmail draft error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Gmail draft failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async searchEmails(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const query = toolCall.arguments.query as string;
      const maxResults = Math.min((toolCall.arguments.max_results as number) || 20, 50);

      if (!query) return this.error(toolCall, 'query is required');

      const client = getGoogleClient();
      const emails = await client.searchEmails(query, maxResults);

      const formatted = emails.length === 0
        ? 'No emails found matching your search.'
        : emails.map(e =>
            `- ${e.from} | ${e.subject} (${e.date})${e.snippet ? ` — ${e.snippet}` : ''}`
          ).join('\n');

      console.log(`   📧 Gmail: ${emails.length} emails found for "${query}"`);
      return this.success(toolCall, { success: true, emails, formatted, count: emails.length });
    } catch (err) {
      console.error('   ❌ Gmail search error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Gmail search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async archiveEmail(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const messageId = toolCall.arguments.message_id as string;
      if (!messageId) return this.error(toolCall, 'message_id is required');

      const client = getGoogleClient();
      await client.archiveEmail(messageId);

      console.log(`   📧 Gmail: archived email ${messageId}`);
      return this.success(toolCall, { success: true, message: 'Email archived.' });
    } catch (err) {
      console.error('   ❌ Gmail archive error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Gmail archive failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async replyToEmail(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const messageId = toolCall.arguments.message_id as string;
      const body = toolCall.arguments.body as string;

      if (!messageId || !body) return this.error(toolCall, 'message_id and body are required');

      const client = getGoogleClient();
      const result = await client.replyToEmail(messageId, body);

      console.log(`   📧 Gmail: replied to email ${messageId}`);
      return this.success(toolCall, { success: true, ...result, message: 'Reply sent.' });
    } catch (err) {
      console.error('   ❌ Gmail reply error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Gmail reply failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
