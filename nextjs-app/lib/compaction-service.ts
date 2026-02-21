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

  constructor(llmSettings: LLMSettings, budgetRatio: number = 0.5) {
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
    preserveLastN: number = 2
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

    // Truncate tool result messages BEFORE the boundary that are >200 tokens
    const compacted = [...currentMessages];
    let truncatedCount = 0;
    let tokensRecovered = 0;
    const minTokensToTruncate = 200;

    for (let i = 1; i < preserveBoundary; i++) {
      const msg = compacted[i];
      if (msg.role !== 'tool') continue;

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
