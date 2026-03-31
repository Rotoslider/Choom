/**
 * Context Compaction Service
 * Two-layer context window management modeled after Claude Code:
 * 1. Cross-turn compaction — summarize old messages into a rolling summary before each LLM call
 * 2. Within-turn compaction — truncate old tool results during the agentic loop
 */

import type { LLMSettings, ToolDefinition } from './types';
import type { ChatMessage } from './llm-client';

interface BudgetInfo {
  totalBudget: number;
  fixedOverhead: number;
  availableForMessages: number;
}

interface CrossTurnResult {
  messages: ChatMessage[];
  summaryUpdated: boolean;
  newSummary: string | null;
  tokensBeforeCompaction: number;
  tokensAfterCompaction: number;
  messagesDropped: number;
}

interface WithinTurnResult {
  messages: ChatMessage[];
  truncatedCount: number;
  tokensRecovered: number;
}

/** Estimate tokens from text using chars/4 heuristic */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a single message */
function messageTokens(msg: ChatMessage): number {
  let tokens = estimateTokens(msg.content || '');
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(tc.function.name + (tc.function.arguments || ''));
    }
  }
  // Small overhead for role, metadata
  tokens += 4;
  return tokens;
}

/** Estimate tokens for tool definitions */
function toolSchemaTokens(tools: ToolDefinition[]): number {
  if (!tools || tools.length === 0) return 0;
  let total = 0;
  for (const t of tools) {
    total += estimateTokens(t.name + t.description + JSON.stringify(t.parameters));
  }
  return total;
}

const SUMMARIZATION_PROMPT = `You are a conversation summarizer. Produce a concise rolling summary of the conversation history below.

Instructions:
- Preserve key facts, decisions, file paths, user preferences, and project names
- Note tool calls and their outcomes (success/failure, key results)
- Track current task state and progress
- Write in third person past tense
- Target 200-400 words
- If an existing summary is provided, incorporate its key information (don't just append — regenerate a unified summary)
- Focus on information the assistant would need to continue the conversation coherently

Existing summary (if any):
{EXISTING_SUMMARY}

Conversation messages to summarize:
{MESSAGES}

Write the summary now:`;

export class CompactionService {
  private llmSettings: LLMSettings;
  private budgetRatio: number;

  constructor(llmSettings: LLMSettings, budgetRatio: number = 0.85) {
    this.llmSettings = llmSettings;
    this.budgetRatio = budgetRatio;
  }

  /**
   * Calculate the token budget for messages given fixed overhead.
   */
  calculateBudget(systemPrompt: string, tools: ToolDefinition[]): BudgetInfo {
    const totalBudget = Math.floor(this.llmSettings.contextLength * this.budgetRatio);
    const systemTokens = estimateTokens(systemPrompt);
    const toolTokens = toolSchemaTokens(tools);
    const responseReserve = this.llmSettings.maxTokens || 4096;
    const fixedOverhead = systemTokens + toolTokens + responseReserve;
    const availableForMessages = Math.max(0, totalBudget - fixedOverhead);

    return { totalBudget, fixedOverhead, availableForMessages };
  }

  /**
   * Cross-turn compaction: summarize old messages if history exceeds budget.
   * Called once before the agentic loop starts.
   */
  async compactCrossTurn(
    systemPrompt: string,
    tools: ToolDefinition[],
    historyMessages: ChatMessage[],
    existingSummary: string | null,
    llmClient: { chat: (messages: ChatMessage[], tools?: ToolDefinition[]) => Promise<{ content: string; toolCalls: unknown; finishReason: string }> }
  ): Promise<CrossTurnResult> {
    const { availableForMessages } = this.calculateBudget(systemPrompt, tools);

    // Subtract existing summary tokens from available budget
    const summaryTokens = existingSummary ? estimateTokens(existingSummary) + 50 : 0; // +50 for section header
    const effectiveAvailable = availableForMessages - summaryTokens;

    // Calculate total history tokens
    let totalHistoryTokens = 0;
    for (const msg of historyMessages) {
      totalHistoryTokens += messageTokens(msg);
    }

    // If history fits within budget, return unchanged
    if (totalHistoryTokens <= effectiveAvailable) {
      return {
        messages: historyMessages,
        summaryUpdated: false,
        newSummary: existingSummary,
        tokensBeforeCompaction: totalHistoryTokens,
        tokensAfterCompaction: totalHistoryTokens,
        messagesDropped: 0,
      };
    }

    // Walk backward from end, keeping messages until 75% of available is consumed
    const keepBudget = Math.floor(effectiveAvailable * 0.75);
    let keptTokens = 0;
    let splitIndex = historyMessages.length;

    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const msgToks = messageTokens(historyMessages[i]);
      if (keptTokens + msgToks > keepBudget) {
        splitIndex = i + 1;
        break;
      }
      keptTokens += msgToks;
      if (i === 0) splitIndex = 0;
    }

    // Ensure at least 4 messages (2 exchanges) are always retained
    const minKeep = 4;
    if (historyMessages.length - splitIndex < minKeep) {
      splitIndex = Math.max(0, historyMessages.length - minKeep);
    }

    // If nothing to summarize, return as-is
    if (splitIndex === 0) {
      return {
        messages: historyMessages,
        summaryUpdated: false,
        newSummary: existingSummary,
        tokensBeforeCompaction: totalHistoryTokens,
        tokensAfterCompaction: totalHistoryTokens,
        messagesDropped: 0,
      };
    }

    const olderMessages = historyMessages.slice(0, splitIndex);
    const keptMessages = historyMessages.slice(splitIndex);

    // Build summarization input
    const messagesText = olderMessages.map(m => {
      let line = `[${m.role}]: ${(m.content || '').slice(0, 500)}`;
      if (m.tool_calls) {
        line += ` [called: ${m.tool_calls.map(tc => tc.function.name).join(', ')}]`;
      }
      if (m.role === 'tool' && m.name) {
        line = `[tool:${m.name}]: ${(m.content || '').slice(0, 300)}`;
      }
      return line;
    }).join('\n');

    let newSummary: string;
    try {
      const prompt = SUMMARIZATION_PROMPT
        .replace('{EXISTING_SUMMARY}', existingSummary || '(none)')
        .replace('{MESSAGES}', messagesText);

      const result = await llmClient.chat([
        { role: 'system', content: 'You are a precise conversation summarizer. Output only the summary, no preamble.' },
        { role: 'user', content: prompt },
      ]);

      newSummary = result.content.trim();
    } catch (err) {
      console.warn('   ⚠️  Compaction summarization failed, using mechanical fallback:', err instanceof Error ? err.message : err);
      newSummary = this.mechanicalFallback(olderMessages, existingSummary);
    }

    // Calculate kept message tokens
    let afterTokens = 0;
    for (const msg of keptMessages) {
      afterTokens += messageTokens(msg);
    }
    afterTokens += estimateTokens(newSummary) + 50;

    return {
      messages: keptMessages,
      summaryUpdated: true,
      newSummary,
      tokensBeforeCompaction: totalHistoryTokens,
      tokensAfterCompaction: afterTokens,
      messagesDropped: olderMessages.length,
    };
  }

  /**
   * Within-turn compaction: truncate old tool results during the agentic loop.
   * Called after each iteration to keep the growing context in check.
   */
  compactWithinTurn(
    currentMessages: ChatMessage[],
    systemPrompt: string,
    tools: ToolDefinition[],
    preserveLastN: number = 2,
    criticalToolNames: Set<string> = new Set()
  ): WithinTurnResult {
    const { availableForMessages } = this.calculateBudget(systemPrompt, tools);

    // Calculate current total tokens (excluding system message at index 0)
    let totalTokens = 0;
    for (let i = 1; i < currentMessages.length; i++) {
      totalTokens += messageTokens(currentMessages[i]);
    }

    // If under budget, return unchanged
    if (totalTokens <= availableForMessages) {
      return { messages: currentMessages, truncatedCount: 0, tokensRecovered: 0 };
    }

    // Find the boundary: preserve the last N assistant+tool groups from the end
    // Walk backward counting assistant messages (each represents an iteration)
    let iterationsFound = 0;
    let preserveBoundary = currentMessages.length;
    for (let i = currentMessages.length - 1; i >= 1; i--) {
      if (currentMessages[i].role === 'assistant' && currentMessages[i].tool_calls) {
        iterationsFound++;
        if (iterationsFound >= preserveLastN) {
          preserveBoundary = i;
          break;
        }
      }
    }

    // Pass 1: Stub tool result messages BEFORE the boundary that are >200 tokens
    const compacted = [...currentMessages];
    let truncatedCount = 0;
    let tokensRecovered = 0;
    const minTokensToTruncate = 200;

    for (let i = 1; i < preserveBoundary; i++) {
      const msg = compacted[i];
      if (msg.role !== 'tool') continue;
      // Never stub critical tool results — the model needs these to complete the task
      if (msg.name && criticalToolNames.has(msg.name)) continue;

      const contentTokens = estimateTokens(msg.content || '');
      if (contentTokens <= minTokensToTruncate) continue;

      // Try to create a compact stub
      const stub = this.createToolStub(msg.content || '');
      const stubTokens = estimateTokens(stub);
      const recovered = contentTokens - stubTokens;

      if (recovered > 0) {
        compacted[i] = { ...msg, content: stub };
        truncatedCount++;
        tokensRecovered += recovered;
      }
    }

    // Pass 2: If still over budget after stubbing, aggressively drop old tool results
    // and their corresponding assistant tool_calls messages
    let currentTotal = totalTokens - tokensRecovered;
    if (currentTotal > availableForMessages) {
      for (let i = 1; i < preserveBoundary; i++) {
        if (currentTotal <= availableForMessages) break;
        const msg = compacted[i];
        // Never drop critical tool results
        if (msg.role === 'tool' && msg.name && criticalToolNames.has(msg.name)) continue;
        if (msg.role === 'tool') {
          const toks = estimateTokens(msg.content || '');
          compacted[i] = { ...msg, content: '[result dropped — context too large]' };
          const saved = toks - estimateTokens('[result dropped — context too large]');
          if (saved > 0) {
            tokensRecovered += saved;
            currentTotal -= saved;
            truncatedCount++;
          }
        }
      }
    }

    // Pass 3: If STILL over budget, drop older assistant+user message pairs
    // (keep system at 0, keep everything from preserveBoundary onward)
    if (currentTotal > availableForMessages) {
      // Find droppable pairs: user messages and their preceding/following context
      for (let i = 1; i < preserveBoundary; i++) {
        if (currentTotal <= availableForMessages) break;
        const msg = compacted[i];
        // Skip already-dropped tool messages, skip system
        if (msg.content === '[result dropped — context too large]') continue;
        const toks = messageTokens(msg);
        const stub = `[${msg.role} message dropped — context compaction]`;
        compacted[i] = { role: msg.role as 'user' | 'assistant', content: stub };
        const saved = toks - estimateTokens(stub);
        if (saved > 0) {
          tokensRecovered += saved;
          currentTotal -= saved;
          truncatedCount++;
        }
      }
    }

    return { messages: compacted, truncatedCount, tokensRecovered };
  }

  /**
   * Create a compact stub from tool result content.
   * Preserves structure (keys, success/error, small scalars) while replacing large values.
   */
  private createToolStub(content: string): string {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null) {
        return content.slice(0, 200) + '... [truncated]';
      }
      const stubbed = this.stubObject(parsed);
      return JSON.stringify(stubbed);
    } catch {
      // Not JSON — truncate as plain text
      return content.slice(0, 200) + '... [truncated]';
    }
  }

  /**
   * Recursively stub an object: keep small values, replace large ones.
   */
  private stubObject(obj: unknown, depth: number = 0): unknown {
    if (depth > 3) return '[nested]';

    if (Array.isArray(obj)) {
      if (obj.length <= 3) return obj.map(item => this.stubObject(item, depth + 1));
      return { _compacted: true, type: 'array', length: obj.length, sample: this.stubObject(obj[0], depth + 1) };
    }

    if (typeof obj === 'object' && obj !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && value.length > 200) {
          result[key] = value.slice(0, 100) + `... [${value.length} chars]`;
        } else if (typeof value === 'object' && value !== null) {
          result[key] = this.stubObject(value, depth + 1);
        } else {
          result[key] = value;
        }
      }
      return result;
    }

    return obj;
  }

  /**
   * Aggressive within-turn compaction: after iteration >= threshold, replace all
   * intermediate assistant+tool message pairs with a compact progress summary.
   * Reduces message count from O(iterations) to a fixed ~5 messages.
   *
   * Result: [system, user, progress_summary, last_assistant, ...last_tool_results]
   *
   * Does NOT call the LLM — uses mechanical extraction for speed.
   * Should be called BEFORE compactWithinTurn() which serves as a second safety net.
   */
  compactAggressiveWithinTurn(
    currentMessages: ChatMessage[],
    iteration: number,
    threshold: number = 3,
    contextBudget: number = 0,
  ): { messages: ChatMessage[]; progressSummary: string; tokensRecovered: number } {
    // Only activate after threshold iterations AND when context is large enough to need it.
    // Without the budget check, this fires every iteration and erases web search results,
    // delegation responses, and file reads before the model can use them — causing
    // a death spiral where the model searches memories to recover lost context.
    if (iteration < threshold || currentMessages.length < 6) {
      return { messages: currentMessages, progressSummary: '', tokensRecovered: 0 };
    }

    // Budget-aware gating: only compact when messages use >70% of available context.
    // If contextBudget is 0 (not provided), use a generous default based on message count.
    const currentTokens = currentMessages.reduce((sum, m) => sum + messageTokens(m), 0);
    const effectiveBudget = contextBudget > 0 ? contextBudget : 24000; // safe default
    if (currentTokens < effectiveBudget * 0.70) {
      return { messages: currentMessages, progressSummary: '', tokensRecovered: 0 };
    }

    // Identify key messages
    const systemMsg = currentMessages[0]; // Always system prompt
    const firstUserMsg = currentMessages.find((m, i) => i > 0 && m.role === 'user');

    // Find the last assistant message that has tool_calls (the most recent iteration)
    let lastAssistantIdx = -1;
    for (let i = currentMessages.length - 1; i >= 1; i--) {
      if (currentMessages[i].role === 'assistant' && currentMessages[i].tool_calls?.length) {
        lastAssistantIdx = i;
        break;
      }
    }

    // If no tool-calling assistant message found, return unchanged
    if (lastAssistantIdx === -1) {
      return { messages: currentMessages, progressSummary: '', tokensRecovered: 0 };
    }

    // Collect the last assistant message + all following tool results
    const lastAssistantMsg = currentMessages[lastAssistantIdx];
    const lastToolResults: ChatMessage[] = [];
    for (let i = lastAssistantIdx + 1; i < currentMessages.length; i++) {
      if (currentMessages[i].role === 'tool') {
        lastToolResults.push(currentMessages[i]);
      } else {
        break; // Stop at next non-tool message
      }
    }

    // Tools whose results are critical and should be preserved as full messages
    // rather than compressed into the progress summary.
    // - workspace_read_file/pdf: contains file content the model needs to reference
    // - delegate_to_choom: response is already truncated by the handler (~1500 chars),
    //   but still worth preserving since it contains the summary + file pointers
    const PRESERVE_FULL_TOOLS = new Set(['delegate_to_choom', 'workspace_read_file', 'workspace_read_pdf']);

    // Build progress summary from intermediate assistant+tool pairs (excluding the last).
    // Delegation and file-read results are kept as separate messages instead of summarized.
    const progressLines: string[] = [];
    const preservedMessages: ChatMessage[] = []; // Full tool result messages to keep
    let stepNum = 0;

    for (let i = 1; i < lastAssistantIdx; i++) {
      const msg = currentMessages[i];

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          stepNum++;
          const toolName = tc.function.name;
          const argsSnippet = this.extractKeyArgs(tc.function.arguments || '{}');

          // Find the matching tool result
          let resultSnippet = '';
          let toolResultMsg: ChatMessage | null = null;
          for (let j = i + 1; j < currentMessages.length; j++) {
            const toolMsg = currentMessages[j];
            if (toolMsg.role === 'tool' && toolMsg.tool_call_id === tc.id) {
              toolResultMsg = toolMsg;
              resultSnippet = this.extractResultSnippet(toolMsg.content || '', toolName);
              break;
            }
            if (toolMsg.role !== 'tool') break;
          }

          // Preserve critical tool results as full messages
          if (PRESERVE_FULL_TOOLS.has(toolName) && toolResultMsg) {
            // Truncate very large results but keep much more than a summary line
            const content = toolResultMsg.content || '';
            const maxChars = toolName === 'delegate_to_choom' ? 12000 : 6000;
            const truncatedContent = content.length > maxChars
              ? content.slice(0, maxChars) + '\n...[truncated for context]'
              : content;
            preservedMessages.push({ ...toolResultMsg, content: truncatedContent });
            // Still add a brief note to the progress summary
            const briefNote = toolName === 'delegate_to_choom'
              ? `(full response preserved below)`
              : `(file content preserved below)`;
            progressLines.push(`${stepNum}. ${toolName}(${argsSnippet}) → ${briefNote}`);
          } else {
            progressLines.push(`${stepNum}. ${toolName}(${argsSnippet}) → ${resultSnippet}`);
          }
        }
      }
    }

    if (progressLines.length === 0 && preservedMessages.length === 0) {
      return { messages: currentMessages, progressSummary: '', tokensRecovered: 0 };
    }

    // Build a "files created/updated" section so the model always knows where its work is,
    // even after compaction. Scan ALL messages (including the last iteration) for write operations.
    const filesWritten: string[] = [];
    for (const msg of currentMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function.name === 'workspace_write_file') {
            try {
              const args = JSON.parse(tc.function.arguments || '{}');
              const filePath = args.path || args.file_path || '';
              if (filePath) filesWritten.push(filePath);
            } catch { /* ignore parse errors */ }
          }
        }
      }
    }
    const filesSection = filesWritten.length > 0
      ? `\n\n## Files created/updated this session\n${filesWritten.map(f => `- ${f}`).join('\n')}\nYou can read these files with workspace_read_file if you need the full content.`
      : '';

    const progressSummary = `## Progress so far (${progressLines.length} tool calls completed)\n${progressLines.join('\n')}${filesSection}`;

    // Build compacted messages: system, user, progress summary, preserved results, last iteration
    const compacted: ChatMessage[] = [systemMsg];
    if (firstUserMsg) compacted.push(firstUserMsg);
    compacted.push({ role: 'assistant', content: progressSummary });
    // Insert preserved delegation/file-read results as assistant context so the model
    // can reference them. We inject them as an assistant message (not raw tool messages)
    // to avoid API validation issues (tool messages require matching assistant tool_calls).
    if (preservedMessages.length > 0) {
      const preservedContent = preservedMessages.map(m => {
        const label = m.name || 'tool';
        return `### Result from ${label}\n${m.content || ''}`;
      }).join('\n\n');
      compacted.push({ role: 'assistant', content: `## Preserved results from previous steps\n\n${preservedContent}` });
    }
    compacted.push(lastAssistantMsg);
    compacted.push(...lastToolResults);

    // Calculate token savings
    const beforeTokens = currentMessages.reduce((sum, m) => sum + messageTokens(m), 0);
    const afterTokens = compacted.reduce((sum, m) => sum + messageTokens(m), 0);
    const tokensRecovered = Math.max(0, beforeTokens - afterTokens);

    return { messages: compacted, progressSummary, tokensRecovered };
  }

  /**
   * Extract key argument values from a tool call's arguments JSON.
   * Returns a compact snippet like: location:'NYC', query:'weather'
   */
  private extractKeyArgs(argsJson: string): string {
    try {
      const args = JSON.parse(argsJson);
      if (typeof args !== 'object' || args === null) return '';
      const parts: string[] = [];
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string') {
          parts.push(`${key}:'${value.length > 40 ? value.slice(0, 37) + '...' : value}'`);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          parts.push(`${key}:${value}`);
        }
        if (parts.length >= 3) break; // Max 3 args in snippet
      }
      return parts.join(', ');
    } catch {
      return '';
    }
  }

  /**
   * Extract a compact result snippet from a tool result message.
   * Tool-type-aware: preserves actionable data (URLs, file paths, key findings)
   * while dropping verbose descriptions and metadata.
   */
  private extractResultSnippet(content: string, toolName: string): string {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null) {
        return typeof parsed === 'string' ? parsed.slice(0, 80) : String(parsed);
      }

      // Check for error
      if (parsed.error) return `error: ${String(parsed.error).slice(0, 60)}`;

      // ---- Web search: preserve URLs and titles (the actionable data) ----
      if (toolName === 'web_search' && parsed.results && Array.isArray(parsed.results)) {
        const urls = parsed.results.map((r: Record<string, unknown>) => {
          const title = r.title ? String(r.title).slice(0, 60) : '';
          const url = r.url ? String(r.url) : '';
          return title && url ? `  - ${title}: ${url}` : url || title;
        }).filter(Boolean);
        return `${urls.length} results:\n${urls.join('\n')}`;
      }

      // ---- Search YouTube: preserve video titles and URLs ----
      if (toolName === 'search_youtube' && parsed.results && Array.isArray(parsed.results)) {
        const videos = parsed.results.map((r: Record<string, unknown>) => {
          const title = r.title ? String(r.title).slice(0, 60) : '';
          const url = r.url || (r.videoId ? `https://youtube.com/watch?v=${r.videoId}` : '');
          return title && url ? `  - ${title}: ${url}` : title;
        }).filter(Boolean);
        return `${videos.length} videos:\n${videos.join('\n')}`;
      }

      // ---- Delegation: preserve summary + file pointers ----
      if (toolName === 'delegate_to_choom' && parsed.response) {
        const response = String(parsed.response);
        const status = parsed.incomplete ? ' (incomplete)' : '';
        const choom = parsed.choom_name ? `${parsed.choom_name}: ` : '';
        const folder = parsed.project_folder ? ` [files in: ${parsed.project_folder}]` : '';
        const snippet = response.length > 2000 ? response.slice(0, 2000) + '...[truncated]' : response;
        return `${choom}${snippet}${status}${folder}`;
      }

      // ---- File write: preserve the file path ----
      if (toolName === 'workspace_write_file') {
        const path = parsed.path || parsed.filePath || '';
        return `wrote: ${path}${parsed.size ? ` (${parsed.size})` : ''}`;
      }

      // ---- Memory search: preserve memory titles and key content ----
      if ((toolName === 'search_memories' || toolName === 'search_by_type' || toolName === 'search_by_tags')
          && parsed.results && Array.isArray(parsed.results)) {
        const memories = parsed.results.slice(0, 5).map((r: Record<string, unknown>) => {
          const title = r.title || r.key || '';
          const preview = r.content ? String(r.content).slice(0, 80) : '';
          return title ? `  - ${title}${preview ? ': ' + preview : ''}` : preview;
        }).filter(Boolean);
        return memories.length > 0 ? `${parsed.results.length} memories:\n${memories.join('\n')}` : 'no results';
      }

      // ---- Image generation: preserve imageId and prompt ----
      if (toolName === 'generate_image') {
        const parts: string[] = [];
        if (parsed.success) parts.push('success');
        if (parsed.imageId) parts.push(`imageId: ${parsed.imageId}`);
        if (parsed.message) parts.push(String(parsed.message).slice(0, 80));
        return parts.join(', ') || 'completed';
      }

      // ---- Default: extract key fields ----
      const status = parsed.success === true ? 'success' : parsed.success === false ? 'failed' : '';
      const keyFields: string[] = [];
      if (status) keyFields.push(status);
      for (const key of ['message', 'path', 'imageId', 'id', 'title', 'name', 'formatted', 'temperature', 'summary']) {
        if (parsed[key] !== undefined) {
          const val = String(parsed[key]);
          keyFields.push(`${key}: ${val.length > 80 ? val.slice(0, 77) + '...' : val}`);
          if (keyFields.length >= 4) break;
        }
      }
      return keyFields.length > 0 ? keyFields.join(', ') : `completed (${Object.keys(parsed).length} fields)`;
    } catch {
      // Not JSON — return truncated text
      return content.slice(0, 200) + (content.length > 200 ? '...' : '');
    }
  }

  /**
   * Mechanical fallback when LLM summarization fails.
   * Extracts key information from message prefixes.
   */
  private mechanicalFallback(messages: ChatMessage[], existingSummary: string | null): string {
    const parts: string[] = [];
    if (existingSummary) {
      parts.push(`Previous context: ${existingSummary.slice(0, 300)}`);
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        parts.push(`User asked: "${(msg.content || '').slice(0, 80)}"`);
      } else if (msg.role === 'assistant') {
        const prefix = (msg.content || '').slice(0, 80);
        if (msg.tool_calls) {
          const toolNames = msg.tool_calls.map(tc => tc.function.name).join(', ');
          parts.push(`Assistant used tools: ${toolNames}. Said: "${prefix}"`);
        } else if (prefix) {
          parts.push(`Assistant: "${prefix}"`);
        }
      }
    }

    return parts.join('. ').slice(0, 1500);
  }
}
