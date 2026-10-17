// Tests never reach the live services on this machine or the home network. A route under test that
// calls the app over HTTP (fetch(`${baseUrl}/api/notifications`)) would otherwise hit the running
// dev server: on 2026-10-16 a group-room test did, and the Signal bridge sent Donny 18 "chatting in"
// notifications for rooms that only existed in the test's scratch database. A test that wants such a
// call stubs global.fetch itself (that replaces this guard for its file).
const realFetch = global.fetch;
const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/i;

global.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  let host = '';
  try { host = new URL(url).hostname; } catch { /* relative or odd: let it fail below */ }
  if (!host || LOCAL.test(host)) {
    throw new Error(`test tried to reach a live local service: ${url} (stub global.fetch in the test)`);
  }
  return realFetch(input, init);
};
