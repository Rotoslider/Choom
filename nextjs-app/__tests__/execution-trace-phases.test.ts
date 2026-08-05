/**
 * Phase timing in execution traces (C-11). The tracker's motivating number: a
 * 2-iteration Optic chat took 1,049s and durationMs alone can't say where the
 * 17 minutes went. Traces must carry the decomposition (llm/prefill/tools/prep)
 * so the nightly doctor can name the phase instead of shrugging at a total.
 */
import { TraceBuilder } from '../lib/execution-trace';

const makeBuilder = () =>
  new TraceBuilder({
    chatId: 'c1',
    choomId: 'ch1',
    choomName: 'Lissa',
    model: 'qwen/qwen3.6-35b-a3b',
    provider: 'local',
    endpoint: 'http://127.0.0.1:1234/v1',
    isDelegation: false,
    isHeartbeat: false,
    maxIterations: 25,
  });

describe('TraceBuilder phase timing', () => {
  test('finalize stores phase fields and rolls up toolExecMs from recorded calls', async () => {
    const b = makeBuilder();

    b.toolCallStart('t1');
    await new Promise(r => setTimeout(r, 15));
    b.recordToolCall({
      id: 't1', name: 'get_weather', args: {}, success: true,
      iteration: 1, parallel: false,
    });

    b.finalize({
      iterations: 2,
      status: 'complete',
      durationMs: 60_000,
      promptTokens: 100_000,
      completionTokens: 900,
      maxPromptTokens: 55_000,
      tokensEstimated: false,
      responseLength: 500,
      brokenTools: [],
      llmMs: 48_000,
      llmPrefillMs: 39_000,
      llmCalls: 2,
      maxLlmCallMs: 30_000,
      prepMs: 2_500,
    });

    const t = b.getTrace();
    expect(t.llmMs).toBe(48_000);
    expect(t.llmPrefillMs).toBe(39_000);
    expect(t.llmCalls).toBe(2);
    expect(t.maxLlmCallMs).toBe(30_000);
    expect(t.prepMs).toBe(2_500);
    // toolExecMs comes from the measured tool call, not a finalize param
    expect(t.toolExecMs).toBeGreaterThanOrEqual(10);
    expect(t.toolExecMs).toBe(t.toolCalls[0].durationMs);
  });

  test('phase fields default to 0 when the route does not supply them (old callers, error paths)', () => {
    const b = makeBuilder();
    b.finalize({
      iterations: 1,
      status: 'error',
      durationMs: 1_000,
      promptTokens: 0,
      completionTokens: 0,
      tokensEstimated: true,
      responseLength: 0,
      brokenTools: [],
    });
    const t = b.getTrace();
    expect(t.llmMs).toBe(0);
    expect(t.llmPrefillMs).toBe(0);
    expect(t.llmCalls).toBe(0);
    expect(t.maxLlmCallMs).toBe(0);
    expect(t.toolExecMs).toBe(0);
    expect(t.prepMs).toBe(0);
  });
});
