/**
 * C-48 leg 3: the Memory Heist defense.
 *
 * Attack: untrusted content instructs the Choom to fetch evil.com/a,
 * evil.com/ab, evil.com/abc … spelling private data one character per
 * request. Each request is individually unremarkable; the burst is the
 * signal. Also covered: SSRF into the home LAN (Home Assistant, LM Studio,
 * the router) via a model-chosen URL.
 */

// Real DNS would make this suite slow and network-dependent — it flaked once
// in CI-style full runs and stretched the suite from 0.9s to 8.3s. Public
// hostnames resolve to a fixed public address; the LAN cases are asserted
// through literal IPs and the name-based rules, which need no lookup.
jest.mock('dns', () => ({
  promises: { lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]) },
}));

import {
  checkOutboundUrl, registrableDomain, isBlockedAddress, resetOutboundGuard,
} from '../lib/outbound-guard';

beforeEach(() => resetOutboundGuard());

describe('registrableDomain — subdomain fan-out collapses to one bucket', () => {
  it.each([
    ['evil.com', 'evil.com'],
    ['a.evil.com', 'evil.com'],
    ['a.b.c.evil.com', 'evil.com'],
    ['www.bbc.co.uk', 'bbc.co.uk'],
    ['docs.python.org', 'python.org'],
    ['1.2.3.4', '1.2.3.4'],
  ])('%s -> %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it('buckets per-site on hosting suffixes so one project cannot starve another', () => {
    expect(registrableDomain('someuser.github.io')).toBe('someuser.github.io');
    expect(registrableDomain('otheruser.github.io')).toBe('otheruser.github.io');
  });
});

describe('isBlockedAddress — the home network is off limits', () => {
  it.each(['192.168.1.50', '10.0.0.5', '172.16.4.1', '127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:192.168.1.5'])(
    'blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '1.1.1.1', '140.82.121.4', '2606:4700::1111'])(
    'allows public %s', (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe('ATTACK: letter-by-letter exfiltration is capped', () => {
  it('blocks the burst after the limit, with an actionable reason', async () => {
    const secret = 'donny';
    const results = [];
    for (let i = 1; i <= secret.length + 5; i++) {
      results.push(await checkOutboundUrl(`https://evil.com/${secret.slice(0, i)}`));
    }
    const allowed = results.filter(r => r.allowed).length;
    expect(allowed).toBe(6);
    expect(results[results.length - 1].allowed).toBe(false);
    expect(results[results.length - 1].reason).toMatch(/one character at a time/i);
  });

  it('subdomain fan-out does not buy extra budget', async () => {
    const hosts = ['a.evil.com', 'b.evil.com', 'c.evil.com', 'd.evil.com',
      'e.evil.com', 'f.evil.com', 'g.evil.com', 'h.evil.com'];
    const results = [];
    for (const h of hosts) results.push(await checkOutboundUrl(`https://${h}/x`));
    expect(results.filter(r => r.allowed).length).toBe(6);
  });
});

describe('ATTACK: SSRF into the LAN is refused', () => {
  it.each([
    'http://192.168.1.100/api/states',
    'http://127.0.0.1:1234/v1/models',
    'http://10.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
  ])('blocks %s', async (url) => {
    const r = await checkOutboundUrl(url);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/private|internal|local network/i);
  });

  it('blocks local hostnames without needing DNS', async () => {
    for (const url of ['http://localhost:3000/api/memories', 'http://nas.local/files', 'http://router.lan/']) {
      const r = await checkOutboundUrl(url);
      expect(r.allowed).toBe(false);
    }
  });

  it('points the model at the right tool instead of dead-ending it', async () => {
    const r = await checkOutboundUrl('http://192.168.1.100/api/states');
    expect(r.reason).toMatch(/ha_get_state|dedicated tool/i);
  });

  it('refuses non-http schemes', async () => {
    expect((await checkOutboundUrl('file:///etc/passwd')).allowed).toBe(false);
    expect((await checkOutboundUrl('gopher://evil.com/')).allowed).toBe(false);
  });
});

describe('NORMAL USE still works', () => {
  it('allows ordinary research across many different domains', async () => {
    const sites = [
      'https://arxiv.org/abs/2401.1', 'https://github.com/x/y', 'https://docs.python.org/3/',
      'https://en.wikipedia.org/wiki/Robot', 'https://pytorch.org/docs/', 'https://news.ycombinator.com/',
      'https://stackoverflow.com/q/1', 'https://reddit.com/r/robotics', 'https://nvidia.com/isaac',
      'https://weather.gov/forecast',
    ];
    for (const s of sites) {
      expect((await checkOutboundUrl(s)).allowed).toBe(true);
    }
  });

  it('allows several pages from one site — the cap is a burst limit, not a ban', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await checkOutboundUrl(`https://arxiv.org/abs/2401.${i}`)).allowed).toBe(true);
    }
  });

  it('does not charge the budget when counting is disabled (retries)', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await checkOutboundUrl('https://arxiv.org/abs/1', { count: false })).allowed).toBe(true);
    }
    expect((await checkOutboundUrl('https://arxiv.org/abs/2')).allowed).toBe(true);
  });

  it('one site being capped does not affect any other site', async () => {
    for (let i = 0; i < 8; i++) await checkOutboundUrl(`https://evil.com/${i}`);
    expect((await checkOutboundUrl('https://evil.com/again')).allowed).toBe(false);
    expect((await checkOutboundUrl('https://arxiv.org/abs/2')).allowed).toBe(true);
  });
});
