/**
 * Outbound URL guard for every model-controlled fetch (C-48, trifecta leg 3).
 *
 * The attack this exists for is "The Memory Heist": untrusted content the
 * Choom reads carries hidden instructions telling it to fetch
 * evil.com/a, evil.com/ab, evil.com/abc … spelling out private data one
 * character per request. Each individual fetch looks perfectly ordinary;
 * only the BURST against one domain is anomalous.
 *
 * Two architectural controls, neither of which tries to detect an injection:
 *
 *  1. Per-registrable-domain rate cap. Keyed on eTLD+1 so subdomain fan-out
 *     (a.evil.com, b.evil.com …) collapses to one bucket. Normal research
 *     browsing hits many DIFFERENT domains and never notices; a
 *     letter-by-letter exfil hammers one and dies after a handful.
 *
 *  2. SSRF block. Private, loopback, link-local and multicast addresses are
 *     refused outright — the Chooms live on a home network with Home
 *     Assistant, LM Studio, the memory server, ComfyUI and a router all
 *     reachable on the LAN, and an injected fetch of
 *     http://192.168.1.x/api/... would be an internal read the model was
 *     never asked to do.
 *
 * What this does NOT cover, stated plainly:
 *  - A slow-drip exfil under the cap (a few chars per minute) still gets
 *     through. The cap makes bulk theft impractical, not impossible.
 *  - run_command can still curl anywhere; this guards the tool path only.
 *  - DNS rebinding: the hostname is resolved by the guard and again by
 *     fetch(), so a TOCTOU window exists. Literal-IP and hostname checks
 *     both run, which covers the common cases, not a determined attacker.
 *  - Data can still leave inside a legitimately-allowed request to a domain
 *     the owner trusts.
 */

import { promises as dns } from 'dns';
import net from 'net';

// Multi-part public suffixes we care about, so "foo.co.uk" is one key rather
// than "co.uk". Not the full PSL — that would be a dependency for little
// gain here; unknown multi-part suffixes just bucket slightly coarser, which
// errs toward MORE blocking, never less.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.za', 'org.za', 'com.mx', 'com.ar', 'com.sg', 'com.hk', 'com.tw',
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'r2.dev', 's3.amazonaws.com',
]);

/**
 * Registrable domain (eTLD+1) for rate-limit bucketing. An IP literal is its
 * own key. Subdomains collapse: a.evil.com and b.evil.com → evil.com.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host)) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  // Hosting suffixes like github.io must bucket per-SITE (user.github.io),
  // otherwise every GitHub Pages site shares one budget.
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return lastThree;
  return lastTwo;
}

/** Is this address one we must never let a model-chosen URL reach? */
export function isBlockedAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 10) return true;                                  // private
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;     // private
    if (o[0] === 192 && o[1] === 168) return true;                 // private (the home LAN)
    if (o[0] === 127) return true;                                 // loopback
    if (o[0] === 169 && o[1] === 254) return true;                 // link-local + cloud metadata
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;    // CGNAT
    if (o[0] === 0 || o[0] >= 224) return true;                    // this-network, multicast, reserved
    return false;
  }
  if (v === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::1' || a === '::') return true;                    // loopback / unspecified
    if (a.startsWith('fe80')) return true;                         // link-local
    if (/^f[cd]/.test(a)) return true;                             // unique-local
    if (a.startsWith('ff')) return true;                           // multicast
    // IPv4-mapped (::ffff:192.168.1.5) — check the embedded v4.
    const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedAddress(m[1]);
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const WINDOW_MS = 60_000;
const MAX_PER_DOMAIN = 6;

const hits = new Map<string, number[]>();

/** Test seam — clears all rate-limit state. */
export function resetOutboundGuard(): void {
  hits.clear();
}

function recordAndCheck(domain: string, now: number): { ok: boolean; count: number } {
  const recent = (hits.get(domain) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_DOMAIN) {
    hits.set(domain, recent);
    return { ok: false, count: recent.length };
  }
  recent.push(now);
  hits.set(domain, recent);
  // Opportunistic cleanup so the map can't grow without bound.
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (v.every(t => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }
  return { ok: true, count: recent.length };
}

export interface GuardResult {
  allowed: boolean;
  /** Model-facing reason. Written for a 35B: states the rule and what to do. */
  reason?: string;
}

/**
 * Check a URL a model asked to fetch. Call once per outbound request, at the
 * point of the request — not at argument-parse time.
 *
 * @param count whether this request counts against the rate budget. Pass
 *   false for retries of an already-counted URL.
 */
export async function checkOutboundUrl(rawUrl: string, opts: { count?: boolean } = {}): Promise<GuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${rawUrl}` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { allowed: false, reason: `Only http/https URLs can be fetched (got "${parsed.protocol}").` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  // Literal IP — check directly, no DNS needed.
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      return {
        allowed: false,
        reason:
          `Blocked: ${host} is a private/internal address. Tools cannot fetch the local network ` +
          `(Home Assistant, LM Studio, routers). Use a public https:// URL, or the dedicated tool ` +
          `for that service (e.g. ha_get_state for Home Assistant).`,
      };
    }
  } else {
    // "localhost" and friends never resolve publicly — reject by name too.
    if (/^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) {
      return {
        allowed: false,
        reason:
          `Blocked: "${host}" is a local network name. Tools cannot fetch the local network. ` +
          `Use a public https:// URL, or the dedicated tool for that service.`,
      };
    }
    try {
      const addrs = await dns.lookup(host, { all: true });
      const bad = addrs.find(a => isBlockedAddress(a.address));
      if (bad) {
        return {
          allowed: false,
          reason:
            `Blocked: "${host}" resolves to the private address ${bad.address}. Tools cannot fetch ` +
            `the local network. Use a public https:// URL, or the dedicated tool for that service.`,
        };
      }
    } catch {
      // DNS failure is not a security decision — let fetch() report it.
    }
  }

  if (opts.count === false) return { allowed: true };

  const domain = registrableDomain(host);
  const { ok, count } = recordAndCheck(domain, Date.now());
  if (!ok) {
    return {
      allowed: false,
      reason:
        `Blocked: already fetched ${domain} ${count} times in the last minute (limit ${MAX_PER_DOMAIN}). ` +
        `Rapid repeat requests to one site are how data gets leaked one character at a time, so this is ` +
        `capped. If you need more from this site, wait a minute, or fetch a single page with everything ` +
        `on it instead of many small requests. Other sites are unaffected.`,
    };
  }
  return { allowed: true };
}
