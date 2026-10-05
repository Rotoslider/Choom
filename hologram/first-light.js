// First-light test for the Looking Glass Portrait: a depth test scene, a view-order test,
// and live calibration tweaks. Status and key presses are posted to the local server.

import * as THREE from './vendor/three.module.js';
import { LookingGlassRenderer } from './lenticular.js';

const hud = document.getElementById('hud');

function post(kind, data = {}) {
  fetch('/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, time: new Date().toISOString(), ...data }),
  }).catch(() => {});
}
window.addEventListener('error', (e) => post('error', { message: e.message, source: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => post('error', { message: String(e.reason) }));

const calibration = await (await fetch('/calibration.json', { cache: 'no-store' })).json();
const lkg = new LookingGlassRenderer({ canvas: document.getElementById('c'), calibration });
const renderer = lkg.renderer;
renderer.setClearColor(0x000000, 1);

const gl = renderer.getContext();
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

// ---- Scene: everything sits around the focal plane (z = 0), which reads as the glass itself.
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xc8dcff, 0x1a1410, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(1.2, 2.0, 3.0);
scene.add(key);

const roomDepth = 1.6;
const roomZ = -0.4; // room runs from z = +0.4 (in front of the glass) to z = -1.2 (deep inside)
const room = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.46, 1.96, roomDepth)),
  new THREE.LineBasicMaterial({ color: 0x46507a }),
);
room.position.z = roomZ;
scene.add(room);

const grid = new THREE.GridHelper(1.46, 8, 0x6872a0, 0x2c3354);
grid.position.set(0, -0.97, roomZ);
grid.scale.z = roomDepth / 1.46;
scene.add(grid);

const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(0.2, 0.065, 220, 28),
  new THREE.MeshStandardMaterial({ color: 0xe6ebf5, metalness: 0.25, roughness: 0.32 }),
);
scene.add(knot);

const CHOOMS = [
  { name: 'Aloy', color: 0xf4b650, y: 0.55 },
  { name: 'Optic', color: 0x57dbe3, y: 0.2 },
  { name: 'Genesis', color: 0xb79bff, y: -0.2 },
  { name: 'Eve', color: 0xe4eeff, y: -0.55 },
];
const orbs = CHOOMS.map((c, i) => {
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 40, 20),
    new THREE.MeshStandardMaterial({ color: c.color, emissive: c.color, emissiveIntensity: 0.55, roughness: 0.35 }),
  );
  orb.add(new THREE.PointLight(c.color, 0.9, 1.4, 1.5));
  orb.userData = { phase: (i / CHOOMS.length) * Math.PI * 2, y: c.y };
  scene.add(orb);
  return orb;
});

const dustCount = 500;
const dust = new Float32Array(dustCount * 3);
for (let i = 0; i < dustCount; i++) {
  dust[i * 3] = (Math.random() - 0.5) * 1.4;
  dust[i * 3 + 1] = (Math.random() - 0.5) * 1.9;
  dust[i * 3 + 2] = roomZ + (Math.random() - 0.5) * roomDepth;
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dust, 3));
scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x9aa4cc, size: 2.5, sizeAttenuation: false })));

// ---- State, keys and HUD
const MODES = ['scene', 'view test', 'raw quilt'];
let mode = 0;
let paused = false;
let simTime = 0;
let hudVisibleUntil = performance.now() + 25000;
let hudPinned = false;
let lastKey = '';

function reset() {
  lkg.center = lkg.cal.center;
  lkg.invView = lkg.cal.invView;
  lkg.depthiness = 1.0;
}

function tuning() {
  return { center: +lkg.center.toFixed(4), invView: lkg.invView, depthiness: +lkg.depthiness.toFixed(2), mode: MODES[mode] };
}

window.addEventListener('keydown', (e) => {
  lastKey = `${e.key} (${e.code})`;
  post('key', { key: e.key, code: e.code, shift: e.shiftKey });
  const fine = e.shiftKey ? 0.001 : 0.005;
  switch (e.code) {
    case 'Digit1': mode = 0; break;
    case 'Digit2': mode = 1; break;
    case 'Digit3': mode = 2; break;
    case 'BracketLeft': lkg.center -= fine; break;
    case 'BracketRight': lkg.center += fine; break;
    case 'Minus': lkg.depthiness = Math.max(0.2, lkg.depthiness - 0.1); break;
    case 'Equal': lkg.depthiness = Math.min(2.5, lkg.depthiness + 0.1); break;
    case 'KeyI': lkg.invView = lkg.invView ? 0 : 1; break;
    case 'KeyH': hudPinned = !hudPinned; hudVisibleUntil = hudPinned ? Infinity : 0; break;
    case 'Space': paused = !paused; break;
    case 'KeyR': reset(); break;
    default: return;
  }
  if (!hudPinned) hudVisibleUntil = performance.now() + 6000;
  post('tuning', tuning());
  e.preventDefault();
});

function windowCheck() {
  const exact = innerWidth === lkg.cal.screenW && innerHeight === lkg.cal.screenH && devicePixelRatio === 1;
  return { exact, text: `${innerWidth}x${innerHeight} @${devicePixelRatio}x at ${screenX},${screenY}` };
}

let frames = 0;
let fps = 0;
let fpsT = performance.now();
let last = performance.now();

function drawHud(now) {
  const w = windowCheck();
  const t = tuning();
  hud.innerHTML =
    `FIRST LIGHT  ${lkg.cal.serial}\n` +
    `mode ${mode + 1}: ${t.mode}${paused ? '  (paused)' : ''}   ${fps} fps\n` +
    `center ${t.center}   invView ${t.invView}   depth ${t.depthiness}\n` +
    (w.exact ? `window ${w.text}\n` : `<span class="warn">window ${w.text}  NOT pixel-exact</span>\n`) +
    `gpu ${gpu.replace(/^ANGLE \(|\)$/g, '').slice(0, 60)}\n` +
    `last key ${lastKey || '-'}\n` +
    `1 scene  2 view test  3 raw quilt  [ ] center  - = depth  i invert  h hud`;
  hud.classList.toggle('hidden', now > hudVisibleUntil);
}

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!paused) simTime += dt;

  knot.rotation.set(simTime * 0.35, simTime * 0.5, 0);
  for (const orb of orbs) {
    const a = simTime * 0.45 + orb.userData.phase;
    orb.position.set(Math.sin(a) * 0.5, orb.userData.y, Math.cos(a) * 0.5);
  }

  lkg.mode = mode === 2 ? 1 : 0;
  if (mode === 1) lkg.renderViewTest();
  else lkg.renderQuilt(scene);
  lkg.present();

  frames++;
  if (now - fpsT >= 1000) {
    fps = Math.round((frames * 1000) / (now - fpsT));
    frames = 0;
    fpsT = now;
    drawHud(now);
  }
});

drawHud(performance.now());
post('start', { gpu, calibration: lkg.cal, window: windowCheck(), userAgent: navigator.userAgent });
setInterval(() => post('status', { fps, window: windowCheck(), ...tuning() }), 2000);
