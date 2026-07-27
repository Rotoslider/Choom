/**
 * Three-tier streaming timeout policy.
 *
 * A single timeout cannot serve both a local GGUF model and a cloud endpoint.
 * A local 35B model may spend two minutes on prefill for a 20k-token prompt and
 * be perfectly healthy; a cloud endpoint silent for 30s is almost certainly
 * dead. So the stream is watched in three phases:
 *
 *   1. CONNECTION   — is the server alive at all? (fast-fail on ECONNREFUSED/DNS)
 *   2. PREFILL      — connected, chewing through prompt tokens, no output yet
 *   3. BETWEEN-TOKEN— streaming started; a long gap now means a stall
 *
 * Extracted from app/api/chat/route.ts so the policy is one pure function that
 * can be tested by asserting numbers, rather than by grepping the route file
 * for string literals like "Math.max(120000" — which is what the previous
 * tests did, and why they broke the moment the values were legitimately tuned.
 */

export type EndpointTier = 'local' | 'cloud-inference' | 'cloud-fast';

export interface StreamTimeouts {
  /** No HTTP response headers within this → treat as dead. */
  connectionMs: number;
  /** Connected but zero content within this → treat as dead. */
  prefillMs: number;
  /** Gap between content tokens exceeding this → treat as stalled. */
  betweenTokenMs: number;
}

/**
 * Local/LAN endpoints get generous timeouts. Unparseable URLs are treated as
 * local: being too patient with a local box is recoverable, cutting off a
 * healthy long prefill is not.
 */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      host.startsWith('192.168.') || host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
  } catch {
    return true;
  }
}

/**
 * Serverless GPU / batched-inference providers. These queue requests, so a
 * slow first token is normal, but once streaming starts they are fast — hence
 * a generous prefill paired with a tight between-token window.
 */
const CLOUD_INFERENCE_HOSTS = /nvidia|\.nvcf\.|together|fireworks|groq|replicate|deepinfra/;

export function classifyEndpoint(endpoint: string, usingCloudProvider: boolean): EndpointTier {
  if (!usingCloudProvider || isLocalEndpoint(endpoint)) return 'local';
  return CLOUD_INFERENCE_HOSTS.test((endpoint || '').toLowerCase())
    ? 'cloud-inference'
    : 'cloud-fast';
}

/**
 * @param tier      endpoint classification
 * @param timeoutMs the Choom's overall request budget; only shapes the local
 *                  tier, where prefill legitimately scales with prompt size.
 */
export function computeStreamTimeouts(tier: EndpointTier, timeoutMs: number): StreamTimeouts {
  switch (tier) {
    case 'local':
      return {
        connectionMs: 30_000,
        // Never below 2 minutes: a local model on a long prompt is not stuck.
        prefillMs: Math.max(120_000, timeoutMs - 15_000),
        betweenTokenMs: Math.max(120_000, Math.floor(timeoutMs * 0.75)),
      };
    case 'cloud-inference':
      // Queueing is expected (generous prefill); streaming is not (tight gap).
      return { connectionMs: 15_000, prefillMs: 60_000, betweenTokenMs: 15_000 };
    case 'cloud-fast':
    default:
      return { connectionMs: 15_000, prefillMs: 30_000, betweenTokenMs: 15_000 };
  }
}
