import WebSocket from 'ws';
import fs from 'fs';
const cfg = JSON.parse(fs.readFileSync('services/signal-bridge/bridge-config.json','utf8')).homeAssistant;
const tok = Object.entries(cfg).find(([k,v]) => /oken/i.test(k) && typeof v === 'string' && v)[1];
const url = cfg.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/websocket';
const ws = new WebSocket(url);
let id = 1; const pending = new Map();
const send = (msg) => new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, ...msg })); });
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: tok })); else if (m.type === 'auth_ok') main(); else if (m.type === 'result') { pending.get(m.id)?.(m); pending.delete(m.id); } });
async function main() {
  const cmds = JSON.parse(process.argv[2]);
  const out = [];
  for (const c of cmds) { const r = await send(c); out.push(r.success ? r.result : { error: r.error }); }
  console.log(JSON.stringify(out));
  ws.close();
}
