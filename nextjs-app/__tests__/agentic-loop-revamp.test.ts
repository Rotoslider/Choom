/**
 * Test: Agentic Loop Revamp — March 2026
 *
 * Comprehensive tests for the timeout, compaction, fallback, and loop logic
 * changes. Covers 20+ use cases including edge cases for delegation,
 * heartbeats, concurrent cron jobs, and multi-step task completion.
 */
import { readFileSync } from 'fs';
import { classifyEndpoint, computeStreamTimeouts, isLocalEndpoint } from '../lib/stream-timeouts';
import { classifyToolError } from '../lib/tool-error-classification';
import { createToolCallXmlFilter } from '../lib/tool-call-parsing';
import path from 'path';

// Import CompactionService for direct unit testing
import { CompactionService } from '../lib/compaction-service';
import type { ChatMessage } from '../lib/llm-client';
import type { LLMSettings, ToolDefinition } from '../lib/types';

// ─── Helpers ───────────────────────────────────────────────────────────

const routePath = path.join(__dirname, '..', 'app', 'api', 'chat', 'route.ts');
// Tool execution (executeToolCall + the image-gen lock) was carved out of
// route.ts into its own module (C-22).
const toolExecPath = path.join(__dirname, '..', 'lib', 'tool-execution.ts');
// The C-22 POST split moved the stream body (planner + finalize) to
// lib/chat-stream.ts and the agentic loop to lib/agentic-loop.ts. These
// source-grep assertions read the CONCATENATION (route → stream → loop);
// in-file ordering pairs all live within one segment, so indexOf ordering
// checks stay valid.
const chatStreamPath = path.join(__dirname, '..', 'lib', 'chat-stream.ts');
const agenticLoopPath = path.join(__dirname, '..', 'lib', 'agentic-loop.ts');
const delegationHandlerPath = path.join(__dirname, '..', 'skills', 'core', 'choom-delegation', 'handler.ts');
const pagePath = path.join(__dirname, '..', 'app', 'page.tsx');
const typesPath = path.join(__dirname, '..', 'lib', 'types.ts');
const logFilterPath = path.join(__dirname, '..', 'scripts', 'log-filter.js');

let routeContent: string;
let toolExecContent: string;
let delegationContent: string;
let pageContent: string;
let typesContent: string;
let logFilterContent: string;

beforeAll(() => {
  routeContent = readFileSync(routePath, 'utf-8')
    + readFileSync(chatStreamPath, 'utf-8')
    + readFileSync(agenticLoopPath, 'utf-8');
  toolExecContent = readFileSync(toolExecPath, 'utf-8');
  delegationContent = readFileSync(delegationHandlerPath, 'utf-8');
  pageContent = readFileSync(pagePath, 'utf-8');
  typesContent = readFileSync(typesPath, 'utf-8');
  logFilterContent = readFileSync(logFilterPath, 'utf-8');
});

/** Build a minimal LLMSettings for compaction tests */
function makeLLMSettings(overrides: Partial<LLMSettings> = {}): LLMSettings {
  return {
    model: 'test-model',
    endpoint: 'http://localhost:1234/v1',
    apiKey: '',
    contextLength: 131072,
    maxTokens: 4096,
    temperature: 0.7,
    topP: 0.9,
    ...overrides,
  } as LLMSettings;
}

/** Build a tool definition stub */
function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: { type: 'object', properties: {} },
  };
}

/** Build a chat message */
function makeMsg(role: ChatMessage['role'], content: string, extras?: Partial<ChatMessage>): ChatMessage {
  return { role, content, ...extras };
}

/** Build a tool result message */
function makeToolMsg(name: string, content: string, toolCallId = 'tc_1'): ChatMessage {
  return { role: 'tool', content, name, tool_call_id: toolCallId };
}

/** Build an assistant message with tool calls */
function makeAssistantWithTools(content: string, toolNames: string[]): ChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: toolNames.map((name, i) => ({
      id: `tc_${i}`,
      type: 'function' as const,
      function: { name, arguments: '{}' },
    })),
  };
}

// ─── 1. Compaction Budget Ratio ─────────────────────────────────────────

describe('1. Compaction Budget Ratio', () => {
  test('default budget ratio is 0.85, not 0.5', () => {
    const svc = new CompactionService(makeLLMSettings());
    const budget = svc.calculateBudget('System prompt', []);
    // 131072 * 0.85 = 111,411 total budget
    expect(budget.totalBudget).toBe(Math.floor(131072 * 0.85));
    expect(budget.totalBudget).toBeGreaterThan(100000);
  });

  test('131K model gets ~96K+ available for messages (not ~45K)', () => {
    const svc = new CompactionService(makeLLMSettings());
    const tools = Array.from({ length: 88 }, (_, i) => makeTool(`tool_${i}`));
    const budget = svc.calculateBudget('System prompt here with some content', tools);
    // With 85% ratio, even with 88 tools, we should have way more than 45K
    expect(budget.availableForMessages).toBeGreaterThan(60000);
  });

  test('route.ts no longer passes 0.5 to CompactionService', () => {
    // The old code: new CompactionService(llmSettings, 0.5)
    // The new code: new CompactionService(llmSettings)
    expect(routeContent).not.toMatch(/new CompactionService\(llmSettings,\s*0\.5\)/);
    expect(routeContent).toMatch(/new CompactionService\(llmSettings\)/);
  });
});

// ─── 2. Critical Tool Result Protection ─────────────────────────────────

describe('2. Critical Tool Results Protected from Compaction', () => {
  test('compactWithinTurn accepts criticalToolNames parameter', () => {
    const svc = new CompactionService(makeLLMSettings({ contextLength: 8192 }));
    const messages: ChatMessage[] = [
      makeMsg('system', 'System'),
      makeMsg('user', 'Read the file'),
      makeAssistantWithTools('Reading...', ['workspace_read_file']),
      makeToolMsg('workspace_read_file', 'x'.repeat(5000)), // Large result
      makeMsg('user', 'Now write'),
    ];
    // Without critical tools — should truncate
    const r1 = svc.compactWithinTurn(messages, 'System', [], 1);
    // With critical tools — should NOT truncate workspace_read_file
    const r2 = svc.compactWithinTurn(messages, 'System', [], 1, new Set(['workspace_read_file']));

    // The protected version should have more content preserved
    const r1FileContent = r1.messages.find(m => m.name === 'workspace_read_file')?.content || '';
    const r2FileContent = r2.messages.find(m => m.name === 'workspace_read_file')?.content || '';
    expect(r2FileContent.length).toBeGreaterThanOrEqual(r1FileContent.length);
  });

  test('workspace_read_file result survives compaction when protected', () => {
    // Use a context that forces compaction of non-critical tools but NOT critical ones
    const svc = new CompactionService(makeLLMSettings({ contextLength: 8192 }));
    const bigResult = JSON.stringify({ success: true, content: 'A'.repeat(2000) });
    const otherResult = JSON.stringify({ success: true, data: 'B'.repeat(2000) });
    const messages: ChatMessage[] = [
      makeMsg('system', 'System'),
      makeAssistantWithTools('Searching...', ['web_search']),
      makeToolMsg('web_search', otherResult, 'tc_search'),
      makeAssistantWithTools('Reading file...', ['workspace_read_file']),
      makeToolMsg('workspace_read_file', bigResult, 'tc_read'),
      makeAssistantWithTools('Generating...', ['generate_image']),
      makeToolMsg('generate_image', '{"success":true,"imageId":"img1"}', 'tc_img'),
    ];
    const withProtection = svc.compactWithinTurn(messages, 'System', [], 1, new Set(['workspace_read_file']));
    const withoutProtection = svc.compactWithinTurn(messages, 'System', [], 1, new Set());

    // Both should compact, but the protected version keeps workspace_read_file intact
    // Find the workspace_read_file message content in each result
    const protectedFileContent = withProtection.messages
      .filter(m => m.role === 'tool' && m.name === 'workspace_read_file')
      .map(m => m.content)[0] || '';
    const unprotectedFileContent = withoutProtection.messages
      .filter(m => m.role === 'tool' && m.name === 'workspace_read_file')
      .map(m => m.content)[0] || '';

    // Protected version should have the full content
    expect(protectedFileContent).toContain('A'.repeat(100));
    // Unprotected version should be truncated (if compaction triggered)
    if (withoutProtection.truncatedCount > 0) {
      expect(unprotectedFileContent.length).toBeLessThanOrEqual(protectedFileContent.length);
    }
  });

  test('non-critical tool results ARE still compacted', () => {
    const svc = new CompactionService(makeLLMSettings({ contextLength: 4096 }));
    const bigResult = JSON.stringify({ success: true, data: 'B'.repeat(3000) });
    const messages: ChatMessage[] = [
      makeMsg('system', 'System'),
      makeAssistantWithTools('', ['web_search']),
      makeToolMsg('web_search', bigResult),
      makeAssistantWithTools('', ['generate_image']),
      makeToolMsg('generate_image', '{"success":true}'),
    ];
    const result = svc.compactWithinTurn(messages, 'System', [], 1, new Set(['workspace_read_file']));
    const searchMsg = result.messages.find(m => m.name === 'web_search');
    // web_search is NOT critical — should be truncated or dropped
    if (result.truncatedCount > 0) {
      expect(searchMsg!.content.length).toBeLessThan(bigResult.length);
    }
  });

  test('route.ts passes CRITICAL_TOOLS set to compactWithinTurn', () => {
    expect(routeContent).toContain("const CRITICAL_TOOLS = new Set(['workspace_read_file', 'workspace_read_pdf', 'workspace_list_files'])");
    expect(routeContent).toContain('compactWithinTurn(currentMessages, systemPromptWithSummary, activeTools, 2, CRITICAL_TOOLS)');
  });
});

// ─── 3. Three-Tier Timeout System ───────────────────────────────────────
//
// These used to grep route.ts for literals like "Math.max(120000" and
// "BETWEEN_TOKEN_MS = 45000". Some of those values never existed and the rest
// were legitimately tuned, so the tests failed for months while the code was
// fine. The policy now lives in lib/stream-timeouts.ts and is asserted by
// calling it.

describe('3. Three-Tier Timeout System', () => {
  test('NVIDIA and other serverless-inference hosts classify as cloud-inference', () => {
    for (const url of [
      'https://integrate.api.nvidia.com/v1',
      'https://api.together.xyz/v1',
      'https://api.fireworks.ai/inference/v1',
      'https://api.groq.com/openai/v1',
    ]) {
      expect(classifyEndpoint(url, true)).toBe('cloud-inference');
    }
  });

  test('a generic cloud endpoint classifies as cloud-fast', () => {
    expect(classifyEndpoint('https://api.anthropic.com/v1', true)).toBe('cloud-fast');
  });

  test('cloud-inference gets a generous prefill but a tight between-token gap', () => {
    const t = computeStreamTimeouts('cloud-inference', 180_000);
    expect(t.prefillMs).toBe(60_000);      // queueing is expected
    expect(t.betweenTokenMs).toBe(15_000); // mid-stream stalls are not
    expect(t.connectionMs).toBe(15_000);
  });

  test('cloud-fast tolerates reasoning-model silences but still fails fast on connection', () => {
    const t = computeStreamTimeouts('cloud-fast', 180_000);
    expect(t.connectionMs).toBe(15_000);
    // 2026-08-25: hidden chain-of-thought on frontier models (OpenRouter
    // stealth) is byte-silent well past the old 30s prefill / 15s gap, which
    // false-dropped healthy primaries onto weaker fallbacks every turn.
    expect(t.prefillMs).toBe(90_000);
    expect(t.betweenTokenMs).toBe(30_000);
  });

  test('local endpoints get generous timeouts that scale with the budget', () => {
    const t = computeStreamTimeouts('local', 300_000);
    expect(t.connectionMs).toBe(30_000);
    expect(t.prefillMs).toBe(285_000);       // timeoutMs - 15s
    expect(t.betweenTokenMs).toBe(225_000);  // 75% of budget
  });

  test('local prefill never drops below 2 minutes even on a small budget', () => {
    const t = computeStreamTimeouts('local', 30_000);
    expect(t.prefillMs).toBe(120_000);
    expect(t.betweenTokenMs).toBe(120_000);
  });

  test('fallback path uses the same policy function as the primary', () => {
    // Regression guard: the fallback used to carry its own copy of the tier
    // ladder, which is how the two silently diverge.
    expect(routeContent).toContain('computeStreamTimeouts(fbTier, fbTimeoutMs)');
    expect(routeContent).not.toMatch(/fbIsCloudInference/);
  });

  test('isLocalEndpoint correctly identifies LAN addresses', () => {
    for (const url of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:1234/v1',
      'http://192.168.1.23:1234/v1',
      'http://10.0.0.5:1234/v1',
      'http://172.16.0.9:1234/v1',
      'http://nuc1.local:1234/v1',
    ]) {
      expect(isLocalEndpoint(url)).toBe(true);
    }
    for (const url of ['https://api.openai.com/v1', 'https://integrate.api.nvidia.com/v1']) {
      expect(isLocalEndpoint(url)).toBe(false);
    }
  });

  test('an unparseable endpoint is treated as local (fail generous, not fatal)', () => {
    expect(isLocalEndpoint('not a url')).toBe(true);
  });
});

// ─── 4. Dead Message Sanitization ───────────────────────────────────────

describe('4. Dead Message Sanitization from History', () => {
  test('empty assistant messages are filtered from history', () => {
    expect(routeContent).toContain("msg.role === 'assistant' && (!msg.content || msg.content.trim() === '')");
  });

  test('consecutive duplicate user messages are collapsed', () => {
    expect(routeContent).toContain("next.role === 'user' && next.content === msg.content");
  });

  test('filtering happens BEFORE compaction (not at LLM request level)', () => {
    // The filtering should happen in the history building section, before CompactionService
    const filterPos = routeContent.indexOf("msg.role === 'assistant' && (!msg.content || msg.content.trim() === '')");
    const compactionPos = routeContent.indexOf('new CompactionService(llmSettings)');
    expect(filterPos).toBeLessThan(compactionPos);
  });

  test('tool messages are still skipped (existing behavior preserved)', () => {
    expect(routeContent).toContain("if (msg.role === 'tool') continue");
  });
});

// ─── 5. Image Generation Batch Cap ──────────────────────────────────────

describe('5. Image Generation Batch-Aware Cap', () => {
  test('pendingImageGenInBatch counter exists', () => {
    expect(routeContent).toContain('let pendingImageGenInBatch = 0');
  });

  test('batch counter is checked before pre-flight', () => {
    expect(routeContent).toContain('imageGenCount + pendingImageGenInBatch >= 5');
  });

  test('batch counter is incremented when call passes pre-flight', () => {
    expect(routeContent).toContain("if (tc.name === 'generate_image') pendingImageGenInBatch++");
  });

  test('imageGenCount resets each iteration so cap is per-batch, not per-request', () => {
    // The reset must happen inside the while loop so later iterations can generate more images
    const loopStart = routeContent.indexOf('while (iteration < maxIterations)');
    const resetPos = routeContent.indexOf('imageGenCount = 0;', loopStart);
    expect(resetPos).toBeGreaterThan(loopStart);
  });

  test('batch cap check happens BEFORE generic pre-flight check', () => {
    const batchCapPos = routeContent.indexOf('imageGenCount + pendingImageGenInBatch >= 5');
    const genericPreFlightPos = routeContent.indexOf('const skipped = preFlightCheck(tc)');
    // The batch-aware cap should be checked first, then generic pre-flight
    expect(batchCapPos).toBeLessThan(genericPreFlightPos);
  });

  test('cap message is descriptive', () => {
    expect(routeContent).toContain('Image generation limit reached');
  });
});

// ─── 6. Task Continuation Nudge ─────────────────────────────────────────

describe('6. Task Continuation Nudge (Loop Break Fix)', () => {
  test('planningNext regex detects continuation intent', () => {
    expect(routeContent).toContain('planningNext');
    // Use the exact regex from route.ts
    const regex = /(?:now (?:let me|i'?ll|i need to|i should|i'?m going to)|next,? i'?ll|next step|then i'?ll|i(?:'ll| will) (?:also|now|then)|let me (?:also|now|update|write|save|send|notify)|updating|writing the|saving the|appending|i still need to)/i;
    expect(regex.test('Now let me update the file')).toBe(true);
    expect(regex.test("Next, I'll write the changes")).toBe(true);
    expect(regex.test('Let me now save the results')).toBe(true);
    expect(regex.test('Let me notify the user')).toBe(true);
    expect(regex.test('i still need to write the file')).toBe(true);
    expect(regex.test('updating the prompt history')).toBe(true);
    expect(regex.test('writing the new entries')).toBe(true);
    expect(regex.test("then I'll send a notification")).toBe(true);
  });

  test('planningNext does NOT match normal conversational text', () => {
    const regex = /(?:now (?:let me|i'?ll|i need to|i should|i'?m going to)|next,? i'?ll|next step|then i'?ll|i(?:'ll| will) (?:also|now|then)|let me (?:also|now|update|write|save|send|notify)|updating|writing the|saving the|appending|i still need to)/i;
    // These should NOT trigger continuation
    expect(regex.test('Here are your images! I hope you enjoy them.')).toBe(false);
    expect(regex.test('The weather is nice today')).toBe(false);
    expect(regex.test('I remember you like cats')).toBe(false);
  });

  test('continuation nudge is capped at 3', () => {
    expect(routeContent).toContain('nudgeCount < 3');
    expect(routeContent).toContain('Task continuation nudge');
  });

  test('continuation nudge uses tool_choice=required', () => {
    // C-15: this used to slice a fixed 800 chars after the log line, so it
    // broke the moment anything was inserted into the block (the C-46
    // fabrication handling did it). Anchor on the block's real end — the
    // `continue` that restarts the loop — instead of a magic byte count.
    const start = routeContent.indexOf('Task continuation nudge');
    expect(start).toBeGreaterThan(-1);
    const end = routeContent.indexOf('continue;', start);
    expect(end).toBeGreaterThan(start);
    expect(routeContent.slice(start, end)).toContain('forceToolCall = true');
  });

  test('continuation nudge message tells model to call tool directly', () => {
    expect(routeContent).toContain('Call the next tool NOW. Do not narrate');
  });
});

// ─── 7. Fallback State Cleanup ──────────────────────────────────────────

describe('7. Fallback State Cleanup', () => {
  test('nudge messages are stripped before fallback', () => {
    expect(routeContent).toContain("m.content?.startsWith('[System] You described what')");
    expect(routeContent).toContain("m.content?.startsWith('[System] You indicated you have more')");
    expect(routeContent).toContain("m.content?.startsWith('[Tool guidance]')");
  });

  test('retract_partial SSE event is sent on fallback', () => {
    expect(routeContent).toContain("send({ type: 'retract_partial', length: iterationContent.length })");
  });

  test('primary timer is cleaned up on timeout (before fallback)', () => {
    // Look for clearTimeout(inactivityTimer) in the catch block
    const catchPos = routeContent.indexOf('} catch (timeoutError) {');
    const clearPos = routeContent.indexOf('clearTimeout(inactivityTimer)', catchPos);
    expect(clearPos).toBeGreaterThan(catchPos);
    expect(clearPos - catchPos).toBeLessThan(800); // Nudge stripping code sits between catch and clearTimeout
  });

  test('primary timer is cleaned up on success', () => {
    // Look for clearTimeout after successful Promise.race
    const racePos = routeContent.indexOf('await Promise.race([streamPromise, inactivityPromise, wallClockPromise])');
    const clearAfterRace = routeContent.indexOf('clearTimeout(inactivityTimer)', racePos);
    expect(clearAfterRace).toBeGreaterThan(racePos);
    expect(clearAfterRace - racePos).toBeLessThan(200); // Right after the race
  });

  test('fallback timer is cleaned up on success', () => {
    expect(routeContent).toContain('clearTimeout(fbInactivityTimer); // clean up timer');
  });

  test('fallback timer is cleaned up on failure', () => {
    const catchFbPos = routeContent.indexOf('} catch (fbError) {');
    const clearFbPos = routeContent.indexOf('clearTimeout(fbInactivityTimer)', catchFbPos);
    expect(clearFbPos).toBeGreaterThan(catchFbPos);
  });

  test('fbInactivityTimer is hoisted before try block (scope fix)', () => {
    const hoistPos = routeContent.indexOf('let fbInactivityTimer');
    const tryPos = routeContent.indexOf("const { client: fbClient, settings: fbSettings } = await createClientForFallback(fb)");
    expect(hoistPos).toBeLessThan(tryPos);
  });
});

// ─── 8. retract_partial SSE Event ───────────────────────────────────────

describe('8. retract_partial SSE Event Handling', () => {
  test('StreamingChatChunk type includes retract_partial', () => {
    expect(typesContent).toContain("'retract_partial'");
  });

  test('StreamingChatChunk type includes length field', () => {
    expect(typesContent).toContain('length?: number');
  });

  test('StreamingChatChunk type includes status event', () => {
    expect(typesContent).toContain("'status'");
  });

  test('frontend handles retract_partial by trimming content', () => {
    expect(pageContent).toContain("case 'retract_partial':");
    expect(pageContent).toContain('fullContent.slice(0, fullContent.length - data.length)');
  });

  test('delegation handler handles retract_partial', () => {
    expect(delegationContent).toContain("case 'retract_partial':");
    expect(delegationContent).toContain('content.slice(0, content.length - data.length)');
  });

  test('delegation handler handles status events (no crash on unknown)', () => {
    expect(delegationContent).toContain("case 'status':");
  });
});

// ─── 9. Within-Turn Compaction Timing ───────────────────────────────────

describe('9. Within-Turn Compaction Runs Before LLM Call', () => {
  test('compaction happens at top of iteration 2+ (pre-LLM)', () => {
    // The compaction should be inside the "if (iteration > 1)" block, before "Stream LLM response"
    const iterGt1Pos = routeContent.indexOf("console.log(`   🔄 ${choomTag} Agent iteration");
    const preLlmCompaction = routeContent.indexOf('Pre-LLM compaction');
    const streamLlmPos = routeContent.indexOf("// Stream LLM response\n            let iterationContent = ''");
    expect(preLlmCompaction).toBeGreaterThan(iterGt1Pos);
    expect(preLlmCompaction).toBeLessThan(streamLlmPos);
  });

  test('old bottom-of-loop compaction is removed', () => {
    // The old code had "Within-turn compaction:" at the bottom
    expect(routeContent).not.toContain('Within-turn compaction: truncated');
    // But the new code has "Pre-LLM compaction:"
    expect(routeContent).toContain('Pre-LLM compaction:');
  });
});

// ─── 10. Log Filter ─────────────────────────────────────────────────────

describe('10. Log Filter Suppression', () => {
  // The actual regex from the log filter, replicated here for testing
  const SUPPRESS = /^\s*(GET|POST|DELETE) \/api\/(notifications|health|chats|images|logs|chooms|token-usage|settings\/defaults)\b|^\s*GET \/(usage)\b|INFO:\s+\d+\.\d+\.\d+\.\d+:\d+ - "GET \/memory\/stats/;

  test('log-filter.js contains the expected suppress pattern', () => {
    expect(logFilterContent).toContain('token-usage');
    expect(logFilterContent).toContain('settings\\/defaults');
    expect(logFilterContent).toContain('usage');
    expect(logFilterContent).toContain('memory\\/stats');
  });

  test('suppresses token-usage polling', () => {
    expect(SUPPRESS.test(' GET /api/token-usage?action=stats&period=month 200 in 74ms')).toBe(true);
  });

  test('suppresses settings/defaults polling', () => {
    expect(SUPPRESS.test(' GET /api/settings/defaults 200 in 147ms')).toBe(true);
  });

  test('suppresses /usage page load', () => {
    expect(SUPPRESS.test(' GET /usage 200 in 1012ms')).toBe(true);
  });

  test('suppresses memory/stats from uvicorn', () => {
    expect(SUPPRESS.test('INFO:     127.0.0.1:35458 - "GET /memory/stats HTTP/1.1" 200 OK')).toBe(true);
  });

  test('suppresses existing routes (notifications, health, chats)', () => {
    expect(SUPPRESS.test(' GET /api/notifications 200 in 5ms')).toBe(true);
    expect(SUPPRESS.test(' GET /api/health 200 in 3ms')).toBe(true);
    expect(SUPPRESS.test(' GET /api/chats 200 in 10ms')).toBe(true);
  });

  test('does NOT suppress real log lines', () => {
    expect(SUPPRESS.test('   🔄 [Anya] Agent iteration 2/100')).toBe(false);
    expect(SUPPRESS.test('   ⚡ [Anya] First content token')).toBe(false);
    expect(SUPPRESS.test('   🖼️  Image generated')).toBe(false);
    expect(SUPPRESS.test(' POST /api/chat 200 in 7.8min')).toBe(false);
    expect(SUPPRESS.test('Error: something broke')).toBe(false);
  });

  test('does NOT suppress POST to chat API', () => {
    expect(SUPPRESS.test(' POST /api/chat 200 in 30s')).toBe(false);
  });
});

// ─── 11. Delegation Compatibility ───────────────────────────────────────

describe('11. Delegation Not Broken by Changes', () => {
  test('isDelegation still strips delegation tools', () => {
    expect(routeContent).toContain("'delegate_to_choom', 'list_team', 'get_delegation_result'");
    expect(routeContent).toContain("'create_plan', 'execute_plan', 'adjust_plan'");
  });

  test('delegation gets its own wall-clock timeout (300s)', () => {
    // C-15/C-18: the literal 'isDelegation ? 300000 : 180000' stopped
    // matching when group rooms added '|| isGroupTurn' to the same
    // condition (bb18861) — the behaviour was always correct, the test was
    // asserting one exact spelling of it, and had been failing ever since.
    // Assert the invariant: the default turn timeout is chosen by
    // isDelegation, giving 300000 to delegation and 180000 otherwise.
    const m = routeContent.match(/DEFAULT_TIMEOUT_MS\s*=\s*\(?[^;]*isDelegation[^;]*\?\s*300000\s*:\s*180000/);
    expect(m).not.toBeNull();
  });

  test('delegation iteration limit is preserved', () => {
    // The old literal matched a console.log ('Delegation mode: maxIterations')
    // that the resolveMaxIterations refactor removed. Assert the invariant
    // instead: a delegated worker's cap is LOCKED for the turn — the worker's
    // own directive (or the default) is the whole budget, and mid-loop project
    // re-detection may not move it.
    expect(routeContent).toContain('let iterationCapLocked = iterationCap.locked || isDelegation');
  });

  test('delegation timeout in handler is 600s default, 900s max', () => {
    expect(delegationContent).toContain('Math.min(900, Math.max(120');
    expect(delegationContent).toContain('600');
  });
});

// ─── 12. Heartbeat / Cron Concurrent Safety ─────────────────────────────

describe('12. Heartbeat and Cron Job Safety', () => {
  test('image generation uses a GPU lock (serialized)', () => {
    expect(toolExecContent).toContain('withImageGenLock');
  });

  test('suppressNotifications flag exists for heartbeats', () => {
    expect(routeContent).toContain('suppressNotifications');
  });

  test('isHeartbeat flag is handled', () => {
    expect(routeContent).toContain('isHeartbeat');
  });

  test('stream close check at top of loop prevents zombie iterations', () => {
    // C-22 POST split: `streamClosed` became the shared `sse.closed` holder
    // so the loop module can see closes flagged by chat-stream's send().
    expect(routeContent).toContain('if (sse.closed)');
    expect(routeContent).toContain('stopping agentic loop');
  });

  test('SSE close protection exists', () => {
    // Verify sse.closed is set on client disconnect
    expect(routeContent).toContain('sse.closed = true');
  });
});

// ─── 13. Fallback Chain Continuity ──────────────────────────────────────

describe('13. Fallback Chain Preserves Conversation State', () => {
  test('fallback receives same currentMessages (not a copy or reset)', () => {
    // After fallback succeeds, the code continues the same while loop
    // with the same currentMessages array — verify no reset
    expect(routeContent).toContain('llmClient = fbClient');
    expect(routeContent).toContain('llmSettings.model = fbSettings.model');
    expect(routeContent).toContain('llmSettings.endpoint = fbSettings.endpoint');
    // Should NOT contain any currentMessages reset in fallback path
    const fallbackBlock = routeContent.slice(
      routeContent.indexOf('Fallback succeeded — switch llmClient'),
      routeContent.indexOf('Fallback succeeded — switch llmClient') + 1000
    );
    expect(fallbackBlock).not.toContain('currentMessages = []');
    expect(fallbackBlock).not.toContain('currentMessages.length = 0');
  });

  test('fallbackAttempt tracks cascade position for multi-hop', () => {
    expect(routeContent).toContain('fallbackAttempt = fbIdx + 1');
  });

  test('fallback iterates through fallbackConfigs array', () => {
    expect(routeContent).toContain('for (let fbIdx = fallbackAttempt; fbIdx < fallbackConfigs.length; fbIdx++)');
  });

  test('nudgeCount resets for fallback model', () => {
    expect(routeContent).toContain('nudgeCount = 0');
    // This should be in the fallback success path
    // nudgeCount = 0 is near the fallback success block but may be past the
    // Chinese model enforcement code. Search broadly.
    // Window is generous on purpose: this asserts "nudgeCount is reset inside
    // the fallback-success block", and a fixed narrow slice turns any added
    // comment in that block into a spurious failure.
    const fbSuccessPos = routeContent.indexOf('Fallback succeeded — switch llmClient');
    const afterFallback = routeContent.slice(fbSuccessPos, fbSuccessPos + 3000);
    expect(afterFallback).toContain('nudgeCount = 0');
  });

  test('Chinese model language enforcement after fallback', () => {
    expect(routeContent).toContain('You MUST respond in English only');
    expect(routeContent).toContain('deepseek|glm|baichuan|qwen|chatglm');
  });
});

// ─── 14. Multi-Step Task Scenarios ──────────────────────────────────────

describe('14. Multi-Step Task Completion', () => {
  test('tool results are appended to currentMessages for next iteration', () => {
    expect(routeContent).toContain("role: 'tool' as const");
    expect(routeContent).toContain('JSON.stringify(resultForLLM)');
  });

  test('allToolCalls tracks across iterations', () => {
    expect(routeContent).toContain('allToolCalls = [...allToolCalls, ...toolCalls]');
  });

  test('imageUrl is stripped from LLM context (prevents token bloat)', () => {
    expect(routeContent).toContain("const { imageUrl, ...rest } = tr.result");
  });

  test('dedup cache allows re-reading a file with different args', () => {
    // The dedup key includes arguments, so same tool + different path is NOT deduped
    expect(routeContent).toContain('const dedupKey = `${tc.name}:${normalizedArgs}`');
  });
});

// ─── 15. Error Classification Resilience ────────────────────────────────

describe('15. Error Classification (Don\'t Block Recoverable Errors)', () => {
  test('path-not-found errors are NOT counted as failures', () => {
    expect(routeContent).toContain('isPathError');
    // Built from a template literal, so match the stable tail only.
    expect(routeContent).toContain('(recoverable, not counted as failure)');
    expect(routeContent).toContain("'path not found'");
    // The patterns themselves now live in lib/tool-error-classification.ts —
    // assert the behaviour rather than the presence of a literal in route.ts.
    expect(classifyToolError('workspace_read_file',
      "ENOENT: no such file or directory, open '/tmp/x.png'").recoverable).toBe(true);
    expect(classifyToolError('workspace_read_file',
      'File not found: "choom_commons/trips/planning.md"').recoverable).toBe(true);
  });

  test('GPU busy is NOT counted as failure', () => {
    expect(routeContent).toContain('isGpuBusy');
    expect(routeContent).toContain('GPU busy (temporary, not counted as failure)');
  });

  test('param errors are NOT counted as failures', () => {
    expect(routeContent).toContain('isParamError');
    expect(routeContent).toContain('param error (recoverable, not counted as failure)');
  });

  test('no-data results are NOT counted as failures', () => {
    expect(routeContent).toContain('isNoData');
    expect(routeContent).toContain('no data found (informational, not counted as failure)');
  });

  test('config errors block the tool immediately', () => {
    expect(routeContent).toContain('brokenTools.add(tc.name)');
    expect(routeContent).toContain('blocked for rest of request (config error)');
  });
});

// ─── 16. Parallel Tool Execution ────────────────────────────────────────

describe('16. Parallel Tool Execution for Read-Only Tools', () => {
  test('PARALLEL_SAFE set includes read-only tools', () => {
    expect(routeContent).toContain("'workspace_read_file'");
    expect(routeContent).toContain("'workspace_list_files'");
    expect(routeContent).toContain("'get_weather'");
    expect(routeContent).toContain("'web_search'");
    expect(routeContent).toContain("'search_memories'");
    expect(routeContent).toContain("'ha_get_state'");
  });

  test('parallel calls use Promise.all', () => {
    expect(routeContent).toContain('Promise.all(parallelCalls.map');
  });

  test('sequential calls run individually', () => {
    expect(routeContent).toContain('sequentialCalls');
  });
});

// ─── 17. Tool Call XML Filter Edge Cases ────────────────────────────────

describe('17. Tool Call XML Filter (Streaming Edge Cases)', () => {
  // Behaviour for these lives in __tests__/tool-call-parsing.test.ts now that
  // the filter is a real module. These used to grep route.ts for 'pendingBuffer'
  // and 'OPEN_TAG.startsWith(tail)', which asserted nothing and broke on a move.
  test('filter handles partial <tool_call> split across chunks', () => {
    const f = createToolCallXmlFilter();
    const out = ['Hello <tool', '_call>{"name":"x"}</tool_call> bye']
      .map(c => f.filter(c)).join('') + f.flush();
    expect(out).toBe('Hello  bye');
    expect(f.getCaptured()).toEqual(['{"name":"x"}']);
  });

  test('flush() releases buffered partial tags on stream end', () => {
    const f = createToolCallXmlFilter();
    const out = ['trailing <too'].map(c => f.filter(c)).join('') + f.flush();
    expect(out).toBe('trailing <too');
  });

  test('flush is called after primary stream completes', () => {
    expect(routeContent).toContain('toolCallXmlFilter.flush()');
  });

  test('flush is guarded against fallback corruption', () => {
    expect(routeContent).toContain('if (!fallbackActivated)');
  });

  test('flush is called after fallback stream completes', () => {
    expect(routeContent).toContain('fbToolCallXmlFilter.flush()');
  });
});

// ─── 18. Context Window Edge Cases ──────────────────────────────────────

describe('18. Context Window Edge Cases', () => {
  test('compaction preserves minimum 4 messages in cross-turn', () => {
    const svc = new CompactionService(makeLLMSettings({ contextLength: 2048 }));
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(makeMsg(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}: ${'x'.repeat(200)}`));
    }
    // Mock LLM client for summarization
    const mockClient = {
      chat: async () => ({ content: 'Summary of conversation', toolCalls: null, finishReason: 'stop' }),
    };
    // This should compact but keep at least 4 messages
    return svc.compactCrossTurn('System', [], messages, null, mockClient).then(result => {
      expect(result.messages.length).toBeGreaterThanOrEqual(4);
    });
  });

  test('empty history does not trigger compaction', () => {
    const svc = new CompactionService(makeLLMSettings());
    const mockClient = {
      chat: async () => ({ content: 'Summary', toolCalls: null, finishReason: 'stop' }),
    };
    return svc.compactCrossTurn('System', [], [], null, mockClient).then(result => {
      expect(result.summaryUpdated).toBe(false);
      expect(result.messages.length).toBe(0);
    });
  });

  test('within-turn compaction returns unchanged when under budget', () => {
    const svc = new CompactionService(makeLLMSettings({ contextLength: 131072 }));
    const messages: ChatMessage[] = [
      makeMsg('system', 'System prompt'),
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi there'),
    ];
    const result = svc.compactWithinTurn(messages, 'System prompt', []);
    expect(result.truncatedCount).toBe(0);
    expect(result.tokensRecovered).toBe(0);
  });
});

// ─── 19. Consecutive Failure + Broken Tool Integration ──────────────────

describe('19. Consecutive Failures Don\'t Break the Loop Permanently', () => {
  test('MAX_CONSECUTIVE_FAILURES is 6', () => {
    expect(routeContent).toContain('const MAX_CONSECUTIVE_FAILURES = 6');
  });

  test('tools are stripped on max consecutive failures', () => {
    expect(routeContent).toContain('activeTools = []');
    expect(routeContent).toContain('stripped tools, 1 final iteration to summarize');
  });

  test('success resets consecutive failure counter', () => {
    expect(routeContent).toContain('consecutiveFailures = 0');
  });

  test('broken tools are tracked per-request (not globally)', () => {
    // brokenTools should be a Set declared inside the request handler
    expect(routeContent).toContain('const brokenTools = new Set<string>()');
  });
});

// ─── 20. Compaction Service Unit Tests ──────────────────────────────────

describe('20. Compaction Service Direct Unit Tests', () => {
  test('estimateTokens matches chars/4 heuristic', () => {
    // Test via budget calculation — a 100-char system prompt should be ~25 tokens
    const svc = new CompactionService(makeLLMSettings());
    const budget1 = svc.calculateBudget('x'.repeat(100), []);
    const budget2 = svc.calculateBudget('x'.repeat(200), []);
    // Difference should be ~25 tokens
    const diff = budget1.availableForMessages - budget2.availableForMessages;
    expect(diff).toBe(25);
  });

  test('tool schema tokens are accounted for in budget', () => {
    const svc = new CompactionService(makeLLMSettings());
    const noTools = svc.calculateBudget('System', []);
    const withTools = svc.calculateBudget('System', [
      makeTool('tool_a'),
      makeTool('tool_b'),
    ]);
    expect(noTools.availableForMessages).toBeGreaterThan(withTools.availableForMessages);
  });

  test('response reserve is subtracted from budget', () => {
    const svc4k = new CompactionService(makeLLMSettings({ maxTokens: 4096 }));
    const svc8k = new CompactionService(makeLLMSettings({ maxTokens: 8192 }));
    const budget4k = svc4k.calculateBudget('System', []);
    const budget8k = svc8k.calculateBudget('System', []);
    expect(budget4k.availableForMessages - budget8k.availableForMessages).toBe(4096);
  });

  test('pass 3 drops message pairs when severely over budget', () => {
    const svc = new CompactionService(makeLLMSettings({ contextLength: 2048 }));
    const messages: ChatMessage[] = [
      makeMsg('system', 'System'),
    ];
    // Add many large messages to exceed budget
    for (let i = 0; i < 10; i++) {
      messages.push(makeMsg('user', 'Q'.repeat(500)));
      messages.push(makeAssistantWithTools('A'.repeat(200), ['web_search']));
      messages.push(makeToolMsg('web_search', 'R'.repeat(500), `tc_${i}`));
    }
    const result = svc.compactWithinTurn(messages, 'System', [], 1);
    // Should have compacted something
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(result.tokensRecovered).toBeGreaterThan(0);
  });

  test('mechanical fallback works when LLM summarization fails', () => {
    const svc = new CompactionService(makeLLMSettings({ contextLength: 2048 }));
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(makeMsg(i % 2 === 0 ? 'user' : 'assistant', `Msg ${i}: ${'y'.repeat(200)}`));
    }
    // Mock client that throws
    const failingClient = {
      chat: async () => { throw new Error('LLM down'); },
    };
    return svc.compactCrossTurn('System', [], messages, null, failingClient).then(result => {
      // Should still succeed via mechanical fallback
      expect(result.summaryUpdated).toBe(true);
      expect(result.newSummary).toBeTruthy();
      expect(result.newSummary!.length).toBeGreaterThan(0);
    });
  });
});

// ─── EDGE CASE: Two heartbeats + user chat simultaneously ───────────────

describe('Edge Case: Concurrent Heartbeat + User Chat', () => {
  test('per-choom user activity tracking prevents heartbeat interference', () => {
    expect(routeContent).toContain('isHeartbeat');
  });

  test('image gen lock serializes GPU access across requests', () => {
    expect(toolExecContent).toContain('withImageGenLock');
  });

  test('each request gets its own agentic loop state', () => {
    // These should be inside the request handler (let, not global)
    expect(routeContent).toContain('let iteration = 0');
    expect(routeContent).toContain('let imageGenCount = 0');
    expect(routeContent).toContain('let consecutiveFailures = 0');
    expect(routeContent).toContain('let nudgeCount = 0');
  });
});

// ─── EDGE CASE: Fallback to local when NVIDIA is down ───────────────────

describe('Edge Case: NVIDIA → Local Fallback Timeout Classification', () => {
  test('after fallback switch, next iteration recalculates timeout tier', () => {
    // The tier must be recomputed INSIDE the while loop, so that after a
    // fallback swaps llmSettings.endpoint (e.g. NVIDIA -> local LM Studio) the
    // next iteration stops applying cloud-tight timeouts to a local model.
    const whileLoopBody = routeContent.slice(
      routeContent.indexOf('while (iteration < maxIterations)'),
      routeContent.indexOf('// Assemble fullContent from all iterations')
    );
    expect(whileLoopBody).toContain('classifyEndpoint(llmSettings.endpoint, usingCloudProvider)');
    expect(whileLoopBody).toContain('computeStreamTimeouts(endpointTier, timeoutMs)');

    // And the behaviour that guards: same budget, different endpoint -> different policy.
    const cloud = computeStreamTimeouts(classifyEndpoint('https://integrate.api.nvidia.com/v1', true), 180_000);
    const local = computeStreamTimeouts(classifyEndpoint('http://192.168.1.23:1234/v1', true), 180_000);
    expect(cloud.betweenTokenMs).toBe(15_000);
    expect(local.betweenTokenMs).toBeGreaterThan(cloud.betweenTokenMs);
  });
});

// ─── EDGE CASE: Empty tool result from compaction + dedup ───────────────

describe('Edge Case: Compacted Tool Result + Dedup Cache Interaction', () => {
  test('dedup cache returns note about using previous result', () => {
    expect(routeContent).toContain('This tool was already called with the same arguments. Use the previous result.');
  });

  test('critical tools bypass compaction so dedup cache is unnecessary for them', () => {
    // The fix: critical tools are never stubbed, so the model always sees the
    // real result. If it calls the tool again with same args, dedup fires but
    // the original result is still visible in context.
    const compactionSrc = readFileSync(path.join(__dirname, '..', 'lib', 'compaction-service.ts'), 'utf-8');
    expect(compactionSrc).toContain('criticalToolNames.has(msg.name)');
  });
});

// ─── EDGE CASE: 120K token conversation ─────────────────────────────────

describe('Edge Case: Very Large Context (120K tokens)', () => {
  test('85% budget on 131K allows up to ~111K total budget', () => {
    const svc = new CompactionService(makeLLMSettings({ contextLength: 131072 }));
    const budget = svc.calculateBudget('System', []);
    expect(budget.totalBudget).toBe(111411);
  });

  test('with 88 tools and system prompt, available budget is still generous', () => {
    const svc = new CompactionService(makeLLMSettings({ contextLength: 131072 }));
    // 88 tools with realistic descriptions
    const tools = Array.from({ length: 88 }, (_, i) =>
      makeTool(`tool_${i}_with_a_realistic_name`)
    );
    const systemPrompt = 'S'.repeat(4000); // ~1000 tokens
    const budget = svc.calculateBudget(systemPrompt, tools);
    // Should still have 80K+ available
    expect(budget.availableForMessages).toBeGreaterThan(80000);
  });
});
