/**
 * Shared LLM stream reader for the agentic loop.
 *
 * Both the primary call and every fallback attempt read the model's stream
 * through this one function. Until 2026-09-12 the fallback path was a
 * stripped-down copy of the primary reader — it dropped reasoning_content,
 * had no Gemma tool-call filter and no repetition guard — so a fallback model
 * was served worse than the same model as primary. Nothing in the reader
 * branches on the model NAME: every filter runs on every model's output and
 * keeps what matches. The per-model inputs are `settings.enableThinking`
 * (reasoning-channel routing) and the endpoint tier (timeouts), and both are
 * passed in per call.
 *
 * The reader mutates a `StreamState` it is handed rather than returning a
 * result, so a caller that catches a timeout still sees the partial content
 * (it has to retract what was already streamed to the client) and the call
 * timing.
 */
import { accumulateToolCalls, type ChatCompletionChunk, type ChatMessage, type LLMClient } from '@/lib/llm-client';
import {
  createThinkFilter, createToolCallXmlFilter, createJsonToolCallFilter, createGemmaToolCallFilter,
} from '@/lib/tool-call-parsing';
import { computeStreamTimeouts, type EndpointTier } from '@/lib/stream-timeouts';
import type { ToolDefinition } from '@/lib/types';

export type ParsedToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export interface StreamState {
  /** Visible reply text after every filter (think blocks, leaked tool-call blocks) is applied. */
  content: string;
  /** Reasoning-channel prose kept aside when thinking is off — the reply itself for qwen3.6. */
  reasoningProse: string;
  /** Structured tool-call deltas, keyed by index, accumulated across chunks. */
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  finishReason: string;
  /** Raw <tool_call> XML blocks leaked as text and stripped from `content`. */
  capturedXml: string[];
  /** JSON tool-call arrays leaked as text and stripped from `content`. */
  capturedJson: ParsedToolCall[];
  /** Gemma 4 <|tool_call>…<tool_call|> blocks leaked as text and stripped from `content`. */
  capturedGemma: ParsedToolCall[];
  thinkTokensFiltered: boolean;
  abortedForRepetition: boolean;
  /** Timestamp the call started; 0 until `readLlmStream` runs. */
  callStart: number;
  /** Timestamp of the first chunk; 0 if none arrived. */
  firstChunkAt: number;
  usage: { promptTokens: number; completionTokens: number; maxPromptTokens: number };
}

export function newStreamState(): StreamState {
  return {
    content: '', reasoningProse: '', toolCalls: new Map(), finishReason: 'stop',
    capturedXml: [], capturedJson: [], capturedGemma: [],
    thinkTokensFiltered: false, abortedForRepetition: false,
    callStart: 0, firstChunkAt: 0,
    usage: { promptTokens: 0, completionTokens: 0, maxPromptTokens: 0 },
  };
}

/** True when the stream produced any tool call in any form (structured or leaked as text). */
export function streamHasToolCalls(st: StreamState): boolean {
  return st.toolCalls.size > 0 || st.capturedXml.length > 0 || st.capturedJson.length > 0 || st.capturedGemma.length > 0;
}

export interface ReadLlmStreamOptions {
  client: { streamChat: LLMClient['streamChat'] };
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolChoice: 'required' | undefined;
  /** The SELECTED model's flag — the fallback's own settings on a fallback attempt. */
  enableThinking: boolean | undefined;
  tier: EndpointTier;
  /** Wall-clock budget for the whole call; the three phase timeouts derive from it. */
  timeoutMs: number;
  /** Deliver a chunk to the client. Not called when `bufferForDedup` is set. */
  send: (data: Record<string, unknown>) => void;
  /** Hold text back for post-stream dedup instead of streaming it live. */
  bufferForDedup: boolean;
  /** Log prefix, e.g. "[Genesis]". */
  choomTag: string;
  /** Log label for this attempt: '' for the primary, 'Fallback ' for a fallback. */
  attemptLabel?: string;
}

/**
 * Stream one model reply into `st`. Resolves when the stream ends; rejects on
 * a connection / prefill / between-token / wall-clock timeout or a transport
 * error. On rejection the stream is aborted and every timer is cleared, and
 * `st` holds whatever arrived before the failure.
 */
export async function readLlmStream(st: StreamState, opts: ReadLlmStreamOptions): Promise<void> {
  const { send, bufferForDedup, choomTag } = opts;
  const label = opts.attemptLabel ?? '';
  const { connectionMs, prefillMs, betweenTokenMs } = computeStreamTimeouts(opts.tier, opts.timeoutMs);

  // Three-phase timeout — tuned per endpoint type:
  //   Phase 1 — CONNECTION: server alive? (fast fail on ECONNREFUSED/DNS/5xx)
  //   Phase 2 — PREFILL: processing prompt tokens before first output
  //   Phase 3 — BETWEEN-TOKEN: gap between streaming tokens (stall detection)
  // Policy lives in lib/stream-timeouts.ts (pure + unit-tested).
  st.callStart = Date.now();
  let connectionEstablished = false;
  let firstTokenReceived = false;
  let lastChunkTime = Date.now();
  let chunkCount = 0;
  let inactivityTimer: ReturnType<typeof setTimeout> = undefined!;
  let rejectInactivity: (err: Error) => void;
  const inactivityPromise = new Promise<never>((_, reject) => {
    rejectInactivity = reject;
    inactivityTimer = setTimeout(() => reject(new Error(
      `LLM connection timeout (no HTTP response in ${connectionMs / 1000}s)`
    )), connectionMs);
  });
  inactivityPromise.catch(() => {}); // suppress unhandled rejection after race
  const onConnected = () => {
    if (connectionEstablished) return;
    connectionEstablished = true;
    clearTimeout(inactivityTimer);
    console.log(`   🔗 ${choomTag} ${label}Connected — ${prefillMs / 1000}s prefill timeout`);
    inactivityTimer = setTimeout(() => rejectInactivity(new Error(
      `LLM response timeout (connected but no content for ${prefillMs / 1000}s)`
    )), prefillMs);
  };
  const resetInactivity = (hasContent: boolean) => {
    clearTimeout(inactivityTimer);
    if (!st.firstChunkAt) st.firstChunkAt = Date.now();
    lastChunkTime = Date.now();
    chunkCount++;
    if (!connectionEstablished) {
      connectionEstablished = true;
      console.log(`   🔗 ${choomTag} ${label}Connected — ${prefillMs / 1000}s prefill timeout`);
    }
    if (!firstTokenReceived && hasContent) {
      firstTokenReceived = true;
      console.log(`   ⚡ ${choomTag} ${label}First content token — switching to ${betweenTokenMs / 1000}s between-token timeout`);
    }
    const currentTimeout = firstTokenReceived ? betweenTokenMs : prefillMs;
    const timeoutMsg = firstTokenReceived
      ? `LLM response timeout (no data for ${currentTimeout / 1000}s, last chunk ${Math.round((Date.now() - lastChunkTime) / 1000)}s ago, ${chunkCount} chunks received)`
      : `LLM response timeout (connected but no content for ${prefillMs / 1000}s)`;
    inactivityTimer = setTimeout(() => rejectInactivity(new Error(timeoutMsg)), currentTimeout);
  };
  let wallClockTimer: ReturnType<typeof setTimeout> = undefined!;
  const wallClockPromise = new Promise<never>((_, reject) => {
    wallClockTimer = setTimeout(() => reject(new Error('LLM response timeout')), opts.timeoutMs);
  });
  wallClockPromise.catch(() => {});
  console.log(`   ⏱️  ${label}Timeout: ${opts.timeoutMs / 1000}s wall-clock, ${connectionMs / 1000}s connection, ${prefillMs / 1000}s prefill, ${betweenTokenMs / 1000}s between-token`);

  // Abort handle for THIS stream. Without it a timed-out stream keeps running
  // in the background after the next attempt takes over — appending to the
  // reply, send()ing stale chunks, pouring late tool-call deltas into the
  // accumulator, and double-counting usage. (Each attempt has its own state
  // object, so a late-finishing stream can at worst touch its own dead state.)
  const abort = new AbortController();

  // Think-block filter: strips <think>...</think> from reasoning models
  const thinkFilter = createThinkFilter();
  // Tool-call XML filter: strips <tool_call>...</tool_call> emitted as text
  // by local models and captures them for parsing into real tool calls
  const toolCallXmlFilter = createToolCallXmlFilter();
  // JSON tool-call filter: strips [{"name":"...","parameters":{...}}] arrays
  // emitted as plain text (common with Qwen/Mistral models)
  const jsonToolCallFilter = createJsonToolCallFilter();
  // Gemma 4 tool-call filter: strips <|tool_call>call:name{args}<tool_call|>
  // blocks emitted as text when Gemma's special tokens aren't tokenized
  const gemmaToolCallFilter = createGemmaToolCallFilter();

  const emit = (text: string) => {
    st.content += text;
    if (!bufferForDedup) send({ type: 'content', content: text });
  };

  const streamPromise = (async () => {
    let reasoningRouted = false;
    // Inline repetition detector — when the model regenerates the same
    // paragraph multiple times mid-stream, every chunk has already been sent
    // to the client and TTS by the time post-stream dedup runs. Abort the
    // stream as soon as we detect a 60+ char substring repeating 3 times so
    // TTS doesn't play duplicates aloud and Chatterbox doesn't get hammered.
    let lastRepetitionScanLen = 0;
    const detectRepetition = (text: string): boolean => {
      if (text.length < 200) return false;
      // Only scan every 200 chars of new content — substring search is O(n*m).
      if (text.length - lastRepetitionScanLen < 200) return false;
      lastRepetitionScanLen = text.length;
      // Take the trailing 180 chars as the probe. If it appears 2+ MORE times
      // earlier in the buffer (3+ total occurrences), we're in a
      // regenerate-the-same-paragraph loop.
      const probeLen = 180;
      const probe = text.slice(-probeLen);
      if (probe.length < 60) return false;
      let count = 0;
      let pos = 0;
      while (pos < text.length - probeLen) {
        const idx = text.indexOf(probe, pos);
        if (idx === -1 || idx >= text.length - probeLen) break;
        count++;
        pos = idx + probeLen;
        if (count >= 2) return true; // 2 prior + 1 trailing = 3 total
      }
      return false;
    };

    for await (const chunk of opts.client.streamChat(opts.messages, opts.tools, abort.signal, opts.toolChoice, onConnected)) {
      if (st.abortedForRepetition) break;
      // Capture token usage (OpenAI sends it in a trailing choice-less chunk;
      // the Anthropic adapter attaches it to the finish_reason chunk).
      if (chunk.usage) {
        st.usage.promptTokens += chunk.usage.prompt_tokens || 0;
        st.usage.completionTokens += chunk.usage.completion_tokens || 0;
        st.usage.maxPromptTokens = Math.max(st.usage.maxPromptTokens, chunk.usage.prompt_tokens || 0);
      }
      if (!chunk.choices || !chunk.choices[0]) continue;
      const choice = chunk.choices[0];

      // Some local models (Qwen 3.6 35B-A3B observed) route their entire
      // completion — including <tool_call> XML — through delta.reasoning_content
      // instead of delta.content, even when the request explicitly set
      // chat_template_kwargs.enable_thinking = false. When the user disabled
      // thinking, route reasoning tokens through the tool-call filters so the
      // <tool_call> blocks get captured — but the leftover prose is still the
      // model's chain-of-thought, so it must NOT reach the user / TTS / DB
      // directly. It is buffered in `reasoningProse` and only used as the
      // reply when the turn produced no normal content and no tool call.
      const deltaAny = choice.delta as { reasoning_content?: string } & ChatCompletionChunk['choices'][0]['delta'];
      let chunkIsReasoningOnly = false;
      if (
        opts.enableThinking === false &&
        typeof deltaAny.reasoning_content === 'string' &&
        deltaAny.reasoning_content.length > 0 &&
        !choice.delta.content
      ) {
        if (!reasoningRouted) {
          console.log(`   🔄 ${choomTag} ${label}Routing delta.reasoning_content through tool-call filters (enableThinking=false; reasoning prose will be hidden)`);
          reasoningRouted = true;
        }
        choice.delta.content = deltaAny.reasoning_content;
        chunkIsReasoningOnly = true;
      }

      const hasContent = !!(choice.delta.content || choice.delta.tool_calls ||
        (typeof deltaAny.reasoning_content === 'string' && deltaAny.reasoning_content.length > 0));
      resetInactivity(hasContent);

      if (choice.delta.content) {
        let visible = thinkFilter(choice.delta.content);
        if (visible) {
          visible = toolCallXmlFilter.filter(visible);
          if (visible) visible = jsonToolCallFilter.filter(visible);
          if (visible) visible = gemmaToolCallFilter.filter(visible);
          if (visible) {
            // Common model glitch: contraction directly fused to a number
            // without a separator ("That's16%", "be17%"). Insert the missing
            // space. Narrow regex — only English contractions immediately
            // followed by a digit, so "v1.0" or "$50" are untouched.
            visible = visible.replace(/([a-zA-Z]'(?:s|re|ll|ve|d|t))(\d)/g, '$1 $2');
            if (chunkIsReasoningOnly) {
              st.reasoningProse += visible;
            } else {
              // Repetition check on the WOULD-BE accumulator so we can
              // suppress the chunk that completes the 3rd repeat instead of
              // streaming it and aborting after the fact.
              const wouldBe = st.content + visible;
              if (detectRepetition(wouldBe)) {
                console.warn(`   🔁 ${choomTag} ${label}Repetition detected mid-stream (180-char probe seen 3+ times). Aborting stream early to prevent TTS spam.`);
                st.abortedForRepetition = true;
                // Keep content up to the end of the FIRST occurrence of the
                // repeating probe — drop the rest.
                const probe = wouldBe.slice(-180);
                const firstIdx = st.content.indexOf(probe);
                if (firstIdx !== -1 && firstIdx < st.content.length - 180) {
                  const beforeTrim = st.content.length;
                  st.content = st.content.slice(0, firstIdx + probe.length);
                  // Live-streamed iterations already sent the repeated copies
                  // to the client — retract them so the bubble matches the
                  // trimmed content NOW and the client can drop the junk from
                  // its TTS queue (C-44). Buffered iterations sent nothing.
                  if (!bufferForDedup) {
                    send({ type: 'retract_partial', length: beforeTrim - st.content.length });
                  }
                }
                abort.abort();
                break;
              }
              emit(visible);
            }
          }
        } else if (choice.delta.content.length > 0) {
          st.thinkTokensFiltered = true;
        }
      }

      if (choice.delta.tool_calls) {
        accumulateToolCalls(st.toolCalls, choice.delta);
      }
      if (choice.finish_reason) {
        st.finishReason = choice.finish_reason;
      }
    }

    // Flush any buffered partial tag that was never completed.
    for (const flushed of [toolCallXmlFilter.flush(), jsonToolCallFilter.flush(), gemmaToolCallFilter.flush()]) {
      if (flushed) emit(flushed);
    }
    if (st.thinkTokensFiltered) {
      console.log(`   🧠 ${choomTag} ${label}Think tokens filtered from response`);
    }
  })();

  try {
    await Promise.race([streamPromise, inactivityPromise, wallClockPromise]);
  } catch (err) {
    // Kill the stream before the caller moves on to the next attempt. On a
    // completed stream this is a no-op; on a timeout it stops the zombie
    // stream. Its pending for-await rejects into the already-settled race —
    // handled, not unhandled.
    abort.abort();
    streamPromise.catch(() => {});
    throw err;
  } finally {
    clearTimeout(inactivityTimer);
    clearTimeout(wallClockTimer);
    st.capturedXml = toolCallXmlFilter.getCaptured();
    st.capturedJson = jsonToolCallFilter.getCaptured();
    st.capturedGemma = gemmaToolCallFilter.getCaptured();
  }
}
