// Tower Spine: the kitchen side of the hologram tower (Donny, Nov 19 2026: "surprise and wow me").
// A 2560 x 720 touch bar stands upright on the tower's back panel, which faces the kitchen. Scenes, picked
// with the buttons along the bottom edge (it opens on Kitchen in the morning and on Core otherwise):
// - Core, a cutaway of the tower seen from the kitchen: air rising from the Noctua at the fan's own
//   speed and warming from blue to amber, the GPU glowing with its power draw, and at the top the top
//   plate's rings with the four names in Morse; her ring runs with light while she talks.
// - Kitchen: the time, his station's weather and the next twelve hours as a strip of sky, timers that chime
//   from the tower speaker, the kitchen speaker (Music Assistant) and four lights (kitchen.json).
// - The girls: each in what she has on now (the glass reports it), what she's doing, and a button that
//   brings her to the Glass; and what Glass Studio has planned. No motion here.
// - Night (11 pm to 6 am, or once he's in bed), on its own: a dim amber clock and a warm glow along the bottom.
// It lights when the radar sees him in the kitchen (held 3 s by day, 10 s at night, because moving in bed
// throws short ghost readings there), goes dark five minutes after he leaves or last touched it (20 s and a
// minute at night). Never because of the girls: the Glass's rule. While dark it draws nothing and reads only
// /status; lit, Core redraws at most 20 times a second ("Pushing the gpu already hard enough").
// GNOME blanks every screen together, so while the desk screens are dark this one is too.
'use strict';

const $ = (s) => document.querySelector(s);
const NIGHT_FROM = 23, NIGHT_TO = 6;
// Donny, Nov 19: it went dark a minute after a touch; "5 minutes whould have been good". Night stays short.
const HOLD_S = { day: 3, night: 10 }, LINGER_S = { day: 300, night: 20 }, TOUCH_S = { day: 300, night: 60 }, START_S = 120;
const FRAME_MS = 50;
const GIRLS = {
  Genesis: { color: '#b79bff', word: 'GENESIS' },
  Optic: { color: '#57dbe3', word: 'OPTIC' },
  Aloy: { color: '#f4b650', word: 'ALOY' },
  Eve: { color: '#e4eeff', word: 'EVE' },
};

let st = {}, ks = {};
let litUntil = Date.now() + START_S * 1000;  // lit for two minutes after it opens, so it can be seen starting
let kitchenSince = null, lit = null, scene = null;
const VIEWS = { core: 'Core', kitchen: 'Kitchen', girls: 'Girls' };
const defaultView = (d = new Date()) => (d.getHours() >= 5 && d.getHours() < 11 ? 'kitchen' : 'core');
let view = defaultView();

// ---------- when it lights ----------
const isNight = (d = new Date()) => d.getHours() >= NIGHT_FROM || d.getHours() < NIGHT_TO || st.presence?.bed === true;
function decide() {
  const now = Date.now(), part = isNight() ? 'night' : 'day';
  if (st.zones_now?.kitchen === true) {
    kitchenSince ??= now;
    if (now - kitchenSince >= HOLD_S[part] * 1000) litUntil = Math.max(litUntil, now + LINGER_S[part] * 1000);
  } else {
    kitchenSince = null;
  }
  const wasLit = lit;
  if (now < litUntil && wasLit === false) view = defaultView();  // a new visit opens on the scene for the hour
  setScene(part === 'night' ? 'night' : view);
  setLit(now < litUntil);
}
document.addEventListener('pointerdown', () => { litUntil = Math.max(litUntil, Date.now() + TOUCH_S[isNight() ? 'night' : 'day'] * 1000); decide(); });

function setLit(on) {
  if (on === lit) return;
  lit = on;
  $('#dark').classList.toggle('on', !on);
  if (on) { poll(); start(); } else setTimeout(() => { if (!lit) stop(); }, 1300);  // after the fade
}
function setScene(s) {
  if (s === scene) return;
  scene = s;
  for (const id of ['core', 'kitchen', 'girls', 'night']) $(`#${id}`).hidden = id !== s;
  document.querySelectorAll('.nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === s)));
  if (s === 'night') drawNight();
  if (s === 'core' && lit) start(); else stopLoop();
  if (lit) poll();
}
document.querySelectorAll('.nav').forEach((n) => Object.entries(VIEWS).forEach(([v, label]) => {
  const b = document.createElement('button'); b.type = 'button'; b.dataset.view = v; b.textContent = label;
  b.addEventListener('click', () => { view = v; decide(); });
  n.append(b);
}));

// ---------- what it reads ----------
let pollTimer;
async function poll() {
  clearTimeout(pollTimer);
  try { st = await (await fetch('/status', { cache: 'no-store' })).json(); } catch { /* the server restarting */ }
  if (lit !== false && scene && scene !== 'night') {
    try { ks = await (await fetch(`/kitchen-state?scene=${scene}`, { cache: 'no-store' })).json(); } catch { /* next time */ }
  }
  decide();
  if (lit) { fill(); if (scene === 'kitchen' && ks.scene === 'kitchen') fillKitchen(); if (scene === 'girls' && ks.scene === 'girls') fillGirls(); }
  pollTimer = setTimeout(poll, 2000);
}

const time12 = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
function tick() { const t = time12(new Date()); document.querySelectorAll('.clock').forEach((c) => { c.textContent = t; }); }
setInterval(tick, 5000); tick();

function fill() {
  if (ks.scene && ks.scene !== 'core') return;
  // Who's on the glass, as the Glass page reports it
  const g = st.status || {}, girl = GIRLS[g.choom];
  $('#talkName').textContent = g.choom || '';
  $('#talkName').style.color = girl?.color || 'var(--fg)';
  $('#talkState').textContent = g.glassOff ? 'the glass is off' : g.mood === 'speaking' ? 'talking at the glass'
    : g.mood === 'thinking' ? 'thinking' : g.listening ? 'listening' : g.choom ? 'on the glass' : '';
  // Weather from his station, sunset from Home Assistant
  const w = st.weather || {}, parts = [];
  if (w.temperature != null) parts.push(`${Math.round(w.temperature)}°F`);
  if (w.wind != null) parts.push(`wind ${Math.round(w.wind)} mph${w.gust ? `, gusts ${Math.round(w.gust)}` : ''}`);
  const set = ks.sun?.next_setting && new Date(ks.sun.next_setting), rise = ks.sun?.next_rising && new Date(ks.sun.next_rising);
  if (set && rise) parts.push(set < rise ? `sunset ${time12(set)}` : `sunrise ${time12(rise)}`);
  $('#wx').textContent = parts.join(' · ');
  // The air through the tower: the fan controller (tower-fan.yaml) through Home Assistant
  const f = ks.fan;
  const num = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '—');
  $('#dT').textContent = f && typeof f.delta === 'number' ? `ΔT ${f.delta.toFixed(1)}°` : '—';
  $('#exhaust').textContent = f ? `${num(f.exhaust)} °C` : '—';
  $('#intake').textContent = f ? `${num(f.intake)} °C` : '—';
  $('#airNote').textContent = f ? (f.fault === 'on' ? 'the fan reports a fault' : '') : 'waiting for the fan controller';
  $('#rpm').textContent = f && typeof f.rpm === 'number'
    ? `${Math.round(f.rpm)} rpm${typeof f.command === 'number' ? ` · ${Math.round(f.command)}%` : ''}` : 'waiting for its controller';
  // The GPU
  const gpu = ks.gpu;
  $('#watts').textContent = gpu ? `${gpu.watts} W` : '—';
  $('#limit').textContent = gpu ? `of ${gpu.limit} W` : '';
  $('#gpuTemp').textContent = gpu ? `${gpu.temp} °C` : '—';
  $('#mem').textContent = gpu ? `${Math.round(gpu.mem_used / 1024)} / ${Math.round(gpu.mem_total / 1024)} GB` : '—';
  $('#memBar').style.width = gpu ? `${(100 * gpu.mem_used / gpu.mem_total).toFixed(1)}%` : '0';
  $('#util').textContent = gpu ? `${gpu.util}%` : '—';
  $('#blower').textContent = gpu?.fan != null ? `${gpu.fan}%` : '—';
}

// ---------- Kitchen ----------
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then((r) => r.json()).catch(() => ({}));
const CONDITION = { 'clear-night': 'Clear', cloudy: 'Cloudy', exceptional: 'Unusual weather', fog: 'Fog', hail: 'Hail', lightning: 'Lightning',
  'lightning-rainy': 'Thunderstorms', partlycloudy: 'Partly cloudy', pouring: 'Pouring', rainy: 'Rain', snowy: 'Snow', 'snowy-rainy': 'Sleet',
  sunny: 'Sunny', windy: 'Windy', 'windy-variant': 'Windy' };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function skyColor(h, day) {  // the sky at that hour: night, dawn, day, dusk
  if (!day) return '#141a36';
  return h <= 7 ? '#8a6a8f' : h >= 17 ? '#b9785a' : h === 16 ? '#9a7f78' : '#4d7fbd';
}
function fillKitchen() {
  const d = new Date();
  $('#kDate').textContent = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const w = st.weather || {}, now = ks.weather_now || {};
  const temp = typeof w.temperature === 'number' ? w.temperature : now.temperature;
  $('#kDeg').textContent = typeof temp === 'number' ? `${Math.round(temp)}°` : '—';
  const lines = [];
  if (now.condition) lines.push(`<b>${CONDITION[now.condition] || now.condition}</b>`);
  if (w.wind != null) lines.push(`Wind ${Math.round(w.wind)} mph${w.gust ? `, gusts ${Math.round(w.gust)}` : ''}`);
  const set = ks.sun?.next_setting && new Date(ks.sun.next_setting), rise = ks.sun?.next_rising && new Date(ks.sun.next_rising);
  if (set && rise) lines.push(set < rise ? `Sunset ${time12(set)}` : `Sunrise ${time12(rise)}`);
  $('#kNow').innerHTML = lines.join('<br>');
  const hours = (ks.forecast || []).filter((h) => new Date(h.datetime) > d - 3600e3).slice(0, 12);
  const temps = hours.map((h) => h.temperature).filter((t) => typeof t === 'number');
  const lo = Math.min(...temps) - 2, hi = Math.max(...temps) + 2;
  $('#sky').innerHTML = hours.map((h, i) => {
    const at = new Date(h.datetime), label = i === 0 ? 'Now' : at.toLocaleTimeString([], { hour: 'numeric' });
    const wet = (h.precipitation_probability || 0) >= 20;
    const x = wet ? `${h.precipitation_probability}%` : `${Math.round(h.wind_speed || 0)}${h.wind_bearing != null ? ' ' + COMPASS[Math.round(h.wind_bearing / 45) % 8] : ''}`;
    return `<div class="hr"><span>${label}</span><i style="background:${skyColor(at.getHours(), h.is_daytime)}"></i>`
      + `<span class="bar"><span style="left:${((h.temperature - lo) / Math.max(1, hi - lo)) * 100}%"></span></span>`
      + `<span class="t">${Math.round(h.temperature)}°</span><span class="x${wet ? ' wet' : ''}">${x}</span></div>`;
  }).join('');
  // the speaker
  const m = ks.music;
  $('#speakerName').textContent = m?.name ? `The ${m.name}` : 'The speaker';
  $('#track').textContent = m?.title || 'Nothing playing';
  $('#artist').textContent = m?.artist || '';
  const art = $('#art');
  if (m?.art) { if (art.dataset.src !== m.art) { art.src = m.art; art.dataset.src = m.art; } art.hidden = false; $('#noart').hidden = true; } else { art.hidden = true; $('#noart').hidden = false; }
  const playing = m?.state === 'playing';
  $('#playIcon').innerHTML = playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M7 5v14l12-7z"/>';
  musicClock = m ? { playing, position: m.position || 0, duration: m.duration || 0, at: m.updated ? Date.parse(m.updated) : Date.now() } : null;
  if (m && typeof m.volume === 'number' && Date.now() - volTouched > 4000) $('#vol').value = Math.round(m.volume * 100);
  // the lights
  const box = $('#lights');
  box.innerHTML = '';
  (ks.lights || []).forEach((l) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = l.name; b.setAttribute('aria-pressed', String(!!l.on));
    b.addEventListener('click', async () => { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); await post('/kitchen-action', { do: 'light', entity: l.entity }); });
    box.append(b);
  });
}
let musicClock = null, volTouched = 0, volTimer;
setInterval(() => {
  if (!musicClock || scene !== 'kitchen' || !lit) return;
  const pos = musicClock.position + (musicClock.playing ? (Date.now() - musicClock.at) / 1000 : 0);
  $('#prog').style.width = musicClock.duration ? `${Math.min(100, (100 * pos) / musicClock.duration)}%` : '0';
}, 1000);
document.querySelectorAll('.ctl button').forEach((b) => b.addEventListener('click', () => post('/kitchen-action', { do: 'music', cmd: b.dataset.cmd }).then(() => setTimeout(poll, 700))));
$('#vol').addEventListener('input', (e) => {
  volTouched = Date.now(); clearTimeout(volTimer);
  volTimer = setTimeout(() => post('/kitchen-action', { do: 'music', cmd: 'volume', value: e.target.value / 100 }), 300);
});
// Timers run here and chime from the tower speaker, again every 10 s for a minute or until tapped.
const timers = [];
let audio;
function chime() {
  try {
    audio ||= new AudioContext();
    [0, 0.28, 0.56].forEach((at, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + at;
      o.frequency.value = [880, 1175, 1568][i]; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.55);
    });
  } catch { /* no sound: the screen still says Done */ }
}
function renderTimers() {
  const box = $('#timers'); box.innerHTML = '';
  const now = Date.now();
  timers.forEach((tm, i) => {
    const left = Math.max(0, tm.end - now), frac = 1 - left / tm.total;
    if (left === 0 && !tm.rang) { tm.rang = now; chime(); litUntil = Math.max(litUntil, now + 60e3); decide(); }
    if (tm.rang && now - tm.rang < 60e3 && Math.floor((now - tm.rang) / 10e3) > (tm.rings || 0)) { tm.rings = (tm.rings || 0) + 1; chime(); }
    const m = Math.floor(left / 60e3), s = Math.floor((left % 60e3) / 1000), C = 2 * Math.PI * 38;
    const el = document.createElement('div'); el.className = 'timer' + (left === 0 ? ' done' : ''); el.dataset.i = i;
    el.innerHTML = `<svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="38" fill="none" stroke="#1f2230" stroke-width="8"/>`
      + `<circle cx="45" cy="45" r="38" fill="none" stroke="${left === 0 ? '#ffad5c' : '#ebe8f3'}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * frac}" transform="rotate(-90 45 45)"/></svg>`
      + `<div><div class="left">${left === 0 ? 'Done' : `${m}:${String(s).padStart(2, '0')}`}</div><div class="nm">${tm.name}</div></div><span class="x">tap to clear</span>`;
    box.append(el);
  });
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  try { (audio ||= new AudioContext()).resume(); } catch { /* fine */ }
  const m = Number(b.dataset.m);
  timers.unshift({ name: `${m}-minute timer`, end: Date.now() + m * 60e3, total: m * 60e3 });
  timers.length = Math.min(timers.length, 3); renderTimers();
});
$('#timers').addEventListener('click', (e) => { const el = e.target.closest('.timer'); if (el) { timers.splice(Number(el.dataset.i), 1); renderTimers(); } });
setInterval(() => { if (timers.length) renderTimers(); }, 1000);  // runs while dark too, so a timer still rings

// ---------- The girls ----------
let toastTimer;
function fillGirls() {
  const box = $('#bands'), girls = ks.girls || [];
  if (box.children.length !== girls.length) box.innerHTML = '';
  girls.forEach((g, i) => {
    let band = box.children[i];
    if (!band) {
      band = document.createElement('div');
      band.innerHTML = `<img alt="" width="248" height="330"><div class="info"><div class="nm"></div><div class="st"></div><div class="wear"></div><div class="facts"></div><button type="button">Bring her to the Glass</button></div>`;
      band.querySelector('button').addEventListener('click', async () => {
        const who = band.dataset.id, name = band.dataset.name;
        await post('/control', { choom: who });
        const t = $('#toast'); t.hidden = false; t.style.borderColor = GIRLS[name]?.color || '';
        t.textContent = `${name} is coming to the Glass`;
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
      });
      box.append(band);
    }
    band.className = `abs band${g.onGlass ? ' on' : ''}`;
    band.style.top = `${190 + i * 470}px`;
    band.style.setProperty('--c', GIRLS[g.name]?.color || '#ebe8f3');
    band.dataset.id = g.id; band.dataset.name = g.name;
    const img = band.querySelector('img');
    if (img.dataset.src !== g.picture) { img.src = g.picture; img.dataset.src = g.picture; img.alt = `${g.name} in ${g.wearing}`; }
    band.querySelector('.nm').textContent = g.name;
    band.querySelector('.st').textContent = g.state;
    band.querySelector('.wear').textContent = g.wearing === 'her usual clothes' ? 'In her usual clothes' : `Wearing her ${g.wearing}`;
    band.querySelector('.facts').textContent = g.clips ? `${g.clips.toLocaleString()} clips on the glass` : '';
  });
  // What Glass Studio is doing: a render (whose clip, how far, the time left), a build, a picture being drawn;
  // then what's planned and not started.
  const mins = (sec) => (sec > 90 ? `about ${Math.round(sec / 60)} min left` : sec > 0 ? 'under 2 min left' : '');
  const clipName = (c) => c.clip.replace(/[_-]+/g, ' ');
  const lines = (ks.studio || []).map((j) => {
    const wait = j.status !== 'running', bits = [];
    if (j.kind === 'render') {
      const who = [...new Set((j.clips || []).map((c) => c.choom))];
      const what = j.clips?.length === 1 ? `${j.clips[0].choom}'s ${clipName(j.clips[0])}` : `${j.total || j.clips?.length || ''} clips for ${who.join(' and ') || 'the girls'}`;
      bits.push(`${wait ? 'Waiting to render' : 'Rendering'} ${what}`);
      if (!wait && j.total > 1) bits.push(`${j.done} of ${j.total} done`);
      else if (!wait && j.step) bits.push(j.step);
    } else if (j.kind === 'build') bits.push(`${wait ? 'Waiting to build' : 'Building'} ${j.choom} onto the glass`);
    else if (j.kind === 'review') bits.push(`Checking ${j.choom}'s new clips`);
    else if (j.kind === 'relaunch') bits.push(`Putting ${j.choom}'s new clips on the glass`);
    else if (j.kind === 'selfie') bits.push(wait ? `Waiting to draw ${j.label || 'a picture'}` : `Drawing ${j.label || 'a picture'}`);
    if (!wait && j.left) bits.push(mins(j.left));
    return bits.filter(Boolean).join(' · ');
  });
  const planned = girls.filter((g) => g.planned).map((g) => `${g.planned} for ${g.name}`);
  if (planned.length) lines.push(`Planned, not started: ${planned.join(', ')}`);
  $('#studioLine').replaceChildren(...(lines.length ? lines : ['Nothing rendering or planned']).map((l) => Object.assign(document.createElement('div'), { textContent: l })));
}

// ---------- Core: the cutaway ----------
const cv = $('#coreCanvas'), cx = cv.getContext('2d');
const MORSE = { A: '.-', C: '-.-.', E: '.', G: '--.', I: '..', L: '.-..', N: '-.', O: '---', P: '.--.', S: '...', T: '-', V: '...-', Y: '-.--' };
function morse(word) {  // marks in units: one unit between the parts of a letter, two between letters (as cut in the plate)
  let t = 0; const out = [];
  [...word].forEach((ch, li) => { if (li) t += 2; [...MORSE[ch]].forEach((sym, ei) => { if (ei) t += 1; const L = sym === '.' ? 1 : 3; out.push([t, t + L]); t += L; }); });
  return { out, total: t };
}
const RC = { x: 360, y: -640 }, U = 14, W = 12;
const RINGS = [{ r: 690 }, { r: 740, g: 'Genesis' }, { r: 790 }, { r: 840, g: 'Optic' }, { r: 890 }, { r: 940, g: 'Aloy' }, { r: 990 }, { r: 1040, g: 'Eve' }, { r: 1090 }];
RINGS.forEach((ring) => { if (ring.g) ring.m = morse(GIRLS[ring.g].word); });
const BLOCKS = [  // seen from the kitchen: the eGPU dock and the GPU on the left, the NUC low on the right
  { x: 96, y: 900, w: 150, h: 480, kind: 'gpu' },
  { x: 66, y: 1400, w: 236, h: 440, kind: 'dock' },
  { x: 454, y: 1660, w: 210, h: 180, kind: 'nuc' },
];
const FAN = { x: 360, y: 2130, r: 175 };

function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }
function markPath(c, ring, t0, t1) {
  const u = U / ring.r, start = Math.PI / 2 + (ring.m.total * u) / 2;
  if (t1 - t0 === 1) { const a = start - (t0 + 0.5) * u; c.beginPath(); c.arc(RC.x + ring.r * Math.cos(a), RC.y + ring.r * Math.sin(a), W / 2, 0, 7); c.fill(); return; }
  c.lineWidth = W; c.beginPath(); c.arc(RC.x, RC.y, ring.r, start - (t1 * U - W / 2) / ring.r, start - (t0 * U + W / 2) / ring.r); c.stroke();
}
// What doesn't move is drawn once.
const still = document.createElement('canvas'); still.width = 720; still.height = 2560;
(function drawStill() {
  const c = still.getContext('2d');
  c.lineCap = 'round';
  RINGS.forEach((ring) => {
    if (!ring.m) {
      c.strokeStyle = 'rgba(235,232,243,0.09)'; c.lineWidth = 14; c.setLineDash([64, 18]);
      c.beginPath(); c.arc(RC.x, RC.y, ring.r, Math.PI * 0.12, Math.PI * 0.88); c.stroke(); c.setLineDash([]);
    } else {
      c.strokeStyle = c.fillStyle = 'rgba(235,232,243,0.16)';
      ring.m.out.forEach(([t0, t1]) => markPath(c, ring, t0, t1));
    }
  });
  BLOCKS.filter((b) => b.kind !== 'gpu').forEach((b) => {
    const g = c.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h); g.addColorStop(0, '#171a24'); g.addColorStop(1, '#0d0f16');
    rr(c, b.x, b.y, b.w, b.h, 10); c.fillStyle = g; c.fill(); c.strokeStyle = 'rgba(160,170,210,0.22)'; c.lineWidth = 2; c.stroke();
  });
  c.fillStyle = 'rgba(127,217,154,0.9)'; c.beginPath(); c.arc(454 + 210 - 26, 1660 + 26, 6, 0, 7); c.fill();  // the NUC's light
  c.strokeStyle = 'rgba(160,170,210,0.25)'; c.lineWidth = 3;
  rr(c, FAN.x - FAN.r - 22, FAN.y - FAN.r - 22, (FAN.r + 22) * 2, (FAN.r + 22) * 2, 30); c.stroke();
  c.beginPath(); c.arc(FAN.x, FAN.y, FAN.r, 0, 7); c.stroke();
  c.strokeStyle = 'rgba(160,170,210,0.10)'; c.lineWidth = 2;  // the intake filter
  for (let x = 140; x <= 580; x += 14) { c.beginPath(); c.moveTo(x, 2346); c.lineTo(x + 10, 2366); c.stroke(); }
  const t = c.createLinearGradient(0, 2060, 0, 820); t.addColorStop(0, 'rgba(111,182,255,0.9)'); t.addColorStop(1, 'rgba(255,173,92,0.9)');
  c.fillStyle = t; c.fillRect(700, 820, 6, 1240);  // cool at the intake, warm at the exhaust
})();

const parts = [];
const lerp = (a, b, t) => a + (b - a) * t;
function spawn(plume) {
  if (plume) return { x: 128 + Math.random() * 86, y: 900, v: 3.4 + Math.random() * 1.6, s: 2 + Math.random() * 2.2, hot: 1, wob: Math.random() * 6 };
  const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (FAN.r - 30);
  return { x: FAN.x + Math.cos(a) * d, y: FAN.y - 40 - Math.random() * 30, v: 1.4 + Math.random() * 1.2, s: 1.6 + Math.random() * 2, hot: 0, wob: Math.random() * 6 };
}
for (let i = 0; i < 220; i++) { const p = spawn(i % 6 === 0); p.y = 900 + Math.random() * 1200; parts.push(p); }

let raf = 0, lastFrame = 0;
function frame(ts) {
  raf = requestAnimationFrame(frame);
  if (ts - lastFrame < FRAME_MS) return;
  const dt = Math.min(3, (ts - lastFrame) / 16.7); lastFrame = ts;
  const t = ts / 1000, rpm = typeof ks.fan?.rpm === 'number' ? ks.fan.rpm : null;
  const sp = (rpm != null ? Math.max(0.15, rpm / 560) : 0.55) * dt;
  const gpu = ks.gpu, heat = gpu ? Math.min(1, gpu.watts / gpu.limit) : 0.3;
  cx.clearRect(0, 0, 720, 2560);
  // the air
  parts.forEach((p, i) => {
    p.y -= p.v * sp * (p.hot ? 1.2 + heat : 1);
    p.x += Math.sin(t * 1.4 + p.wob + p.y / 120) * 0.35 * dt;
    BLOCKS.forEach((b) => { if (!p.hot && p.x > b.x - 8 && p.x < b.x + b.w + 8 && p.y > b.y && p.y < b.y + b.h) p.x += (p.x < b.x + b.w / 2 ? -2.2 : 2.2) * dt; });
    if (p.y < -20) parts[i] = spawn(Math.random() < 0.1 + 0.2 * heat);
    const h = Math.min(1, Math.max(0, (2060 - p.y) / 1700)), fade = Math.min(1, (p.y + 20) / 260);
    const [r, g, b] = p.hot ? [255, 150, 70] : [lerp(111, 255, h), lerp(182, 173, h), lerp(255, 92, h)].map(Math.round);
    cx.fillStyle = `rgba(${r},${g},${b},${(p.hot ? 0.75 : 0.55) * fade})`;
    cx.fillRect(p.x, p.y, p.s, p.s * 2.4);
  });
  cx.drawImage(still, 0, 0);
  // the GPU, glowing with its power draw
  const b = BLOCKS[0], pulse = 0.85 + 0.15 * Math.sin(t * 1.3);
  cx.save(); cx.shadowColor = '#ff8a3d'; cx.shadowBlur = 60 * heat * pulse;
  const g = cx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h); g.addColorStop(0, '#2a1d17'); g.addColorStop(1, '#130f12');
  rr(cx, b.x, b.y, b.w, b.h, 10); cx.fillStyle = g; cx.fill(); cx.restore();
  cx.strokeStyle = `rgba(255,154,61,${0.35 + 0.4 * heat * pulse})`; cx.lineWidth = 2; rr(cx, b.x, b.y, b.w, b.h, 10); cx.stroke();
  for (let i = 0; i < 9; i++) { cx.fillStyle = `rgba(255,160,80,${0.10 + 0.25 * heat})`; cx.fillRect(b.x + 18, b.y + 60 + i * 44, b.w - 36, 4); }
  // the fan, drawn slower than life so the blades read
  cx.save(); cx.translate(FAN.x, FAN.y); cx.rotate(t * ((rpm ?? 300) / 60) * 0.35);
  for (let i = 0; i < 7; i++) {
    cx.rotate((Math.PI * 2) / 7); cx.beginPath(); cx.moveTo(30, -8);
    cx.quadraticCurveTo(FAN.r * 0.55, -FAN.r * 0.42, FAN.r - 8, -18); cx.quadraticCurveTo(FAN.r * 0.6, 8, 30, 12); cx.closePath();
    cx.fillStyle = 'rgba(111,182,255,0.16)'; cx.fill();
  }
  cx.beginPath(); cx.arc(0, 0, 42, 0, 7); cx.fillStyle = '#10131c'; cx.fill(); cx.restore();
  // her name in the top plate: light runs along it while she talks, and shimmers while she thinks
  const s = st.status || {}, ring = s.choom ? RINGS.find((x) => x.g && x.g === s.choom) : null;  // none before the status arrives
  if (ring && !s.glassOff && (s.mood === 'speaking' || s.mood === 'thinking' || s.listening)) {
    const color = GIRLS[ring.g].color, talking = s.mood === 'speaking';
    cx.save(); cx.lineCap = 'round'; cx.strokeStyle = cx.fillStyle = color; cx.shadowColor = color;
    ring.m.out.forEach(([t0, t1], k) => {
      const wave = Math.cos(t * (talking ? 6 : 1.6) - k * 0.55);
      const a = talking ? 0.5 + 0.5 * Math.max(0, wave) : 0.32 + 0.18 * wave;
      cx.globalAlpha = a; cx.shadowBlur = 22 * a; markPath(cx, ring, t0, t1);
    });
    cx.restore();
  } else if (ring && !s.glassOff) {  // on the glass and quiet: her name faintly in her colour
    cx.save(); cx.lineCap = 'round'; cx.strokeStyle = cx.fillStyle = GIRLS[ring.g].color; cx.globalAlpha = 0.3;
    ring.m.out.forEach(([t0, t1]) => markPath(cx, ring, t0, t1)); cx.restore();
  }
}
function start() { if (scene === 'core' && !raf) { lastFrame = performance.now() - FRAME_MS; raf = requestAnimationFrame(frame); } if (scene !== 'core') stopLoop(); }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; }
function stop() { stopLoop(); }

// ---------- Night: drawn once ----------
function drawNight() {
  const c = $('#nightCanvas').getContext('2d');
  c.clearRect(0, 0, 720, 2560);
  for (let i = 0; i < 70; i++) {
    c.fillStyle = `rgba(255,190,140,${0.08 + Math.random() * 0.12})`;
    c.beginPath(); c.arc(Math.random() * 720, Math.random() * 1400, Math.random() * 1.8 + 0.4, 0, 7); c.fill();
  }
}

decide();
poll();
