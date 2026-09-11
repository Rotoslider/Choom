/**
 * HTTPS front door for the dev server, for other machines on the LAN.
 *
 *   node scripts/lan-https-proxy.js      (or: pnpm lan:https)
 *
 * Why this exists
 * ---------------
 * getUserMedia() — the microphone — only exists in a *secure context*. Browsers
 * grant that to https:// and to localhost, and to nothing else. Reaching the dev
 * server as http://192.168.1.44:3000 therefore leaves `navigator.mediaDevices`
 * undefined and the mic button dead on every machine that isn't this one. That
 * is not a new "local networks are untrusted" rule — it has been true since
 * Chrome 47 / Firefox 68 — and there is no server header that opts out of it.
 *
 * The obvious fix is `next dev --experimental-https`, but that moves port 3000
 * itself to TLS, which breaks three things that already work: the ngrok tunnel
 * (it forwards to http://localhost:3000), the launchd agent, and the handful of
 * server-side self-calls in tool-execution.ts / group-chat that fetch
 * http://localhost:3000 and would then need Node to trust the local CA too.
 *
 * So instead this terminates TLS on its own port and forwards to the untouched
 * http dev server. Nothing about the existing setup changes; LAN devices just
 * get a second, secure URL.
 *
 * Certificates come from scripts/setup-lan-https.sh (mkcert).
 */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const CERT_DIR = process.env.CHOOM_CERT_DIR || path.resolve(__dirname, '..', 'certificates');
const CERT_FILE = path.join(CERT_DIR, 'lan.pem');
const KEY_FILE = path.join(CERT_DIR, 'lan-key.pem');

const LISTEN_PORT = Number(process.env.CHOOM_LAN_HTTPS_PORT || 3443);
const TARGET_HOST = process.env.CHOOM_LAN_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.CHOOM_LAN_TARGET_PORT || 3000);

if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
  console.error(`No certificate at ${CERT_DIR}.`);
  console.error('Generate one first:  ./scripts/setup-lan-https.sh');
  process.exit(1);
}

const tlsOptions = {
  key: fs.readFileSync(KEY_FILE),
  cert: fs.readFileSync(CERT_FILE),
};

// Node's global agent carries `timeout: 5000`, a five-second socket idle
// timeout. A chat stream goes quiet for far longer than that whenever the agent
// loop stops to run a tool — a vision call against LM Studio is tens of seconds
// of silence — so the upstream leg gets its own agent with no idle timeout.
// (Measured: the proxy already survived 65s of silence and a 4.5MB burst with
// the default agent, so this is belt-and-braces rather than a known fix.)
const upstreamAgent = new http.Agent({ keepAlive: true, timeout: 0, maxSockets: Infinity });

function logStreamFailure(req, what, err) {
  const when = new Date().toISOString();
  console.error(`[${when}] ${what} ${req.method} ${req.url} from ${req.socket.remoteAddress}` +
                (err ? ` — ${err.message}` : ''));
}

/** Everything the dev server needs to know it is being fronted by TLS. */
function forwardedHeaders(req) {
  return {
    ...req.headers,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': req.headers.host,
    'x-forwarded-for': req.socket.remoteAddress,
  };
}

const server = https.createServer(tlsOptions, (req, res) => {
  const upstream = http.request(
    {
      host: TARGET_HOST, port: TARGET_PORT, path: req.url, method: req.method,
      headers: forwardedHeaders(req), agent: upstreamAgent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      // Straight pipe, no buffering — chat responses stream as SSE and would
      // otherwise arrive all at once when the request finished.
      upstreamRes.pipe(res);

      // A chat stream dying mid-flight leaves the browser with a vanished turn
      // (the app recovers via lib/stream-recovery.ts). Whatever breaks it, say
      // so here — silence on this path made one real failure impossible to
      // attribute.
      upstreamRes.on('error', (err) => logStreamFailure(req, 'upstream stream error on', err));
      res.on('close', () => {
        if (!res.writableEnded) logStreamFailure(req, 'client went away mid-response on');
      });
    }
  );

  upstream.on('error', (err) => {
    logStreamFailure(req, 'upstream request failed for', err);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Dev server unreachable at ${TARGET_HOST}:${TARGET_PORT} — ${err.message}\n`);
  });

  req.pipe(upstream);
});

// A chat turn can stream for minutes. Node would otherwise cut the request off
// at five minutes (requestTimeout), and close idle keep-alive connections after
// five seconds — which races a browser reusing one for the next POST, and a
// POST is not safe for the browser to auto-retry.
server.requestTimeout = 0;
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000; // must exceed keepAliveTimeout

// Turbopack's HMR channel is a WebSocket, and a plain request handler never
// sees it — without this the LAN page loads once and then stops hot-reloading.
server.on('upgrade', (req, socket, head) => {
  socket.setNoDelay(true);

  const upstream = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: forwardedHeaders(req),
    agent: upstreamAgent,
  });

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    upstreamSocket.setNoDelay(true);

    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`;
    const headerLines = Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`);
    socket.write([statusLine, ...headerLines, '', ''].join('\r\n'));

    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
    if (head && head.length) upstreamSocket.write(head);

    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);

    const drop = () => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.on('error', drop);
    socket.on('error', drop);
  });

  upstream.on('error', () => socket.destroy());
  upstream.end();
});

/** Every address a browser on the LAN could plausibly dial. */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  const hostname = os.hostname(); // already ends in .local on macOS
  console.log(`Choom LAN HTTPS  ->  http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log('');
  console.log('  Open on other machines:');
  console.log(`    https://${hostname}:${LISTEN_PORT}`);
  for (const ip of lanAddresses()) console.log(`    https://${ip}:${LISTEN_PORT}`);
  console.log('');
  console.log(`  Certificate: ${CERT_FILE}`);
});
