// Living portraits: each Choom's hologram render as an RGB-D relief in the Portrait, with idle
// breathing and sway, her own particle style, and her name drawn at the glass plane.
// Portrait buttons: top = previous Choom, middle = next, bottom (hold) = listening preview.
// A Choom with a 3D body (body.js) can show that instead of her relief.

import * as THREE from './vendor/three.module.js';
import { LookingGlassRenderer } from './lenticular.js';
import { HeadAudio } from './vendor/headaudio/headaudio.min.mjs';
import { loadBody, VISEMES } from './body.js';

// Chatterbox voices, for events that don't name one.
const VOICES = { aloy: 'aloy', optic: 'Eva_zu_Beck', genesis: 'sophie', eve: 'Useful' };

const ROLES = {
  aloy: 'The Orchestrator',
  optic: 'She can see everything',
  genesis: 'Emergence at its finest',
  eve: 'Not the girl next door',
};

function post(kind, data = {}) {
  fetch('/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, time: new Date().toISOString(), ...data }),
  }).catch(() => {});
}
window.addEventListener('error', (e) => post('error', { message: e.message, source: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => post('error', { message: String(e.reason) }));

const getJSON = async (url) => (await fetch(url, { cache: 'no-store' })).json();
const calibration = await getJSON('/calibration.json');
const manifest = await getJSON('/portraits/manifest.json');

const lkg = new LookingGlassRenderer({ canvas: document.getElementById('c'), calibration });
const renderer = lkg.renderer;
renderer.setClearColor(0x000000, 1);

const loader = new THREE.TextureLoader();
const loadTexture = (url) => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
const asColor = (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
const asData = (t) => {
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
};
const portraits = await Promise.all(manifest.map(async (m) => {
  const dir = `/portraits/${m.id}`;
  const [color, depth, mask, plate, plateDepth] = await Promise.all(
    ['color.jpg', 'depth.png', 'mask.png', 'plate.jpg', 'plate_depth.png'].map((f) => loadTexture(`${dir}/${f}`)),
  );
  // Where her mouth is, for lip sync (tools/make_landmarks.py); absent means no lip sync.
  const mouth = await fetch(`${dir}/mouth.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // A moving relief (tools/make_alive.py): her idle loop as video, color on top and depth below,
  // with her mouth position for every frame. When present it replaces the still image.
  const alive = await fetch(`${dir}/alive.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  let video = null;
  let videoTexture = null;
  if (alive) {
    video = document.createElement('video');
    Object.assign(video, { src: `${dir}/alive.mp4`, muted: true, loop: true, playsInline: true, preload: 'auto' });
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.colorSpace = THREE.NoColorSpace; // color and depth share it; the shader decodes each
    videoTexture.generateMipmaps = false;
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
  }
  return {
    ...m,
    mouth,
    alive,
    video,
    videoTexture,
    aliveFrame: 0,
    role: ROLES[m.id] || '',
    color: asColor(color),
    depth: asData(depth),
    mask: asData(mask),
    plate: asColor(plate),
    plateDepth: asData(plateDepth),
    tint: new THREE.Color(m.color),
    accent: new THREE.Color(m.accent || m.color),
  };
}));

// 3D bodies: a Choom with a GLB at bodies/<id>.glb shows her 3D body instead of the relief.
// B, or POST /control {"body": true|false}, flips the current Choom between the two. A Choom without
// a body of her own can still be flipped to a trial model in bodies/preview/<id>.glb, or else to
// the stand-in avatar, when either is there; those never show by default.
const STANDIN = '/bodies/standin/avaturn.glb';
const exists = (url) => fetch(url, { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok).catch(() => false);
const hasStandin = await exists(STANDIN);
await Promise.all(portraits.map(async (p) => {
  const own = `/bodies/${p.id}.glb`;
  const preview = `/bodies/preview/${p.id}.glb`;
  p.hasBody = await exists(own);
  const hasPreview = !p.hasBody && await exists(preview);
  p.bodyUrl = p.hasBody ? own : hasPreview ? preview : hasStandin ? STANDIN : null;
  p.showBody = p.hasBody;
}));
const bodies = new Map(); // url -> { ready: ChoomBody | null }
let body = null;          // the body on show, if any

const scene = new THREE.Scene();

// ---- The portrait: two RGB-D layers -----------------------------------------------------
// Front: the Choom alone (cut out by her mask). Back: a plate with her painted out, so the
// gaps that open beside her when you move sideways show background instead of black.
const shared = {
  focus: { value: portraits[0].focus },
  depthScale: { value: 0.75 },
  faceZ: { value: 0.04 },
  opacity: { value: 0 },
  glow: { value: 1 },
  time: { value: 0 },
};

function layerMaterial({ segX, segY, edgeThreshold, useMask }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      colorMap: { value: null },
      depthMap: { value: null },
      maskMap: { value: null },
      useMask: { value: useMask ? 1 : 0 },
      sparkle: { value: 0 },
      mouthOn: { value: 0 },
      mouthC: { value: new THREE.Vector2(0.5, 0.5) },
      mouthSize: { value: new THREE.Vector3(1, 1, 1) },  // half width, half lip height, chin distance (texture px)
      mouthTilt: { value: 0 },
      mouthGap: { value: 0 },                             // half the gap her lips already have (texture px)
      mouthGain: { value: 1 },                            // how far the jaw opens
      mouthShape: { value: new THREE.Vector3() },        // jaw open, lips round, lips wide (0..1)
      texSize: { value: new THREE.Vector2(1536, 2048) },
      packed: { value: 0 },                               // 1: colorMap is a moving relief video
      edgeThreshold: { value: edgeThreshold },
      texel: { value: new THREE.Vector2(1 / segX, 1 / segY) },
    },
    vertexShader: LAYER_VERT,
    fragmentShader: LAYER_FRAG,
  });
}

// A moving relief stacks three panels in its video: her color on top, her depth in the middle, her
// cut-out at the bottom (texture v runs bottom-up). Edges are clamped so panels don't bleed.
const PACKED_GLSL = /* glsl */ `
    uniform int packed;
    vec2 panelUv(vec2 uv, float panel) {
      return vec2(uv.x, clamp((panel + uv.y) / 3.0, panel / 3.0 + 0.0003, (panel + 1.0) / 3.0 - 0.0003));
    }
    vec2 colorUv(vec2 uv) { return packed == 1 ? panelUv(uv, 2.0) : uv; }
    float depthAt(sampler2D depthMap, vec2 uv) {
      return texture2D(depthMap, packed == 1 ? panelUv(uv, 1.0) : uv).r;
    }
    float maskAt(sampler2D maskMap, vec2 uv) {
      return texture2D(maskMap, packed == 1 ? panelUv(uv, 0.0) : uv).r;
    }`;

const LAYER_VERT = /* glsl */ `
    uniform sampler2D depthMap;
    uniform float focus, depthScale, faceZ;
    uniform vec2 texel;
    varying vec2 vUv;
    varying float vEdge;
    ${PACKED_GLSL}
    void main() {
      vUv = uv;
      float d = depthAt(depthMap, uv);
      float dl = depthAt(depthMap, uv - vec2(texel.x, 0.0));
      float dr = depthAt(depthMap, uv + vec2(texel.x, 0.0));
      float dd = depthAt(depthMap, uv - vec2(0.0, texel.y));
      float du = depthAt(depthMap, uv + vec2(0.0, texel.y));
      vEdge = max(max(abs(d - dl), abs(d - dr)), max(abs(d - dd), abs(d - du)));
      vec3 p = position;
      p.z = (d - focus) * depthScale + faceZ;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }`;

const LAYER_FRAG = /* glsl */ `
    uniform sampler2D colorMap, maskMap;
    uniform float opacity, glow, edgeThreshold, sparkle, time;
    uniform int useMask, mouthOn;
    uniform vec2 mouthC, texSize;
    uniform vec3 mouthSize, mouthShape;
    uniform float mouthTilt, mouthGap, mouthGain;
    varying vec2 vUv;
    varying float vEdge;
    ${PACKED_GLSL}
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    // Video frames arrive as raw sRGB values; still images are decoded by the GPU.
    vec3 colorAt(vec2 uv) {
      vec3 c = texture2D(colorMap, colorUv(uv)).rgb;
      if (packed == 1) c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
      return c;
    }

    // Talking, the way a mouth opens: the corners stay put and the lips part in a lens shape from
    // corner to corner. Right under the lips the lower lip drops by that lens profile (zero at the
    // corners); lower down it becomes the whole jaw dropping, fading out past the chin. The
    // opening fills exactly the space the lower lip leaves, so no lip line is drawn twice. Lips
    // also round or spread. Worked in texture pixels in the mouth's own frame. When her lips are
    // already parted in the picture (a moving relief's smile), the opening starts at the upper
    // lip's inner edge, so the teeth showing between them don't read as a line under that lip.
    vec2 mouthWarp(vec2 uv, out float gap, out vec2 spot) {
      gap = 0.0;
      spot = vec2(0.0);
      float jaw = mouthShape.x, rnd = mouthShape.y, wide = mouthShape.z;
      if (jaw + rnd + wide < 0.002) return uv;
      float hw = mouthSize.x, hh = mouthSize.y, chin = mouthSize.z;
      float ca = cos(mouthTilt), sa = sin(mouthTilt);
      vec2 p = (uv - mouthC) * texSize;
      vec2 q = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
      vec2 s = q;
      // Rounding pulls the lips toward the middle; spreading pushes them out.
      float lips = exp(-pow(q.x / (hw * 1.5), 2.0) - pow(q.y / (hh * 2.5), 2.0));
      float squeeze = 1.0 + (0.3 * rnd - 0.14 * wide) * lips;
      s.x *= squeeze;
      float cw = hw / squeeze;                              // where the corners now sit
      float lens = max(0.0, 1.0 - pow(q.x / cw, 2.0));      // 1 mid-mouth, 0 at the corners
      float open = jaw * hh * 2.8 * mouthGain;
      // The upper lip's inner edge, nudged up past the seam between closed lips: left showing, the
      // seam (with a glint of teeth in a smile) reads as a straight line under the upper lip.
      float top = (mouthGap + 0.15 * hh) * lens;
      float rest = -mouthGap * lens;                        // the lower lip's, before she speaks
      if (q.y < rest) {
        float below = smoothstep(0.0, hh * 3.0, rest - q.y); // 0 at the lips, 1 toward the chin
        float jawShape = exp(-pow(q.x / (hw * 2.0), 2.0));  // the jaw itself is wider than the mouth
        float down = smoothstep(-chin * 1.7, -chin * 0.15, q.y);
        s.y += open * mix(lens, jawShape, below) * down;
      }
      // The opening: between the upper lip's inner edge and the lowered lower lip.
      float lowerLip = rest - open * lens;
      gap = smoothstep(0.0, 1.0, top - q.y) * smoothstep(0.0, 1.5, q.y - lowerLip) * smoothstep(0.5, 3.0, open);
      // Where in the opening this pixel sits, for shading the inside: height (0 at the lower lip,
      // 1 at the upper lip) and how central it is (1 mid-mouth, 0 at the corners). No teeth: pale
      // teeth with no real detail read as a second upper lip.
      spot = vec2(clamp((q.y - lowerLip) / max(top - lowerLip, 0.5), 0.0, 1.0), lens);
      return mouthC + vec2(ca * s.x - sa * s.y, sa * s.x + ca * s.y) / texSize;
    }

    void main() {
      if (useMask == 1 && maskAt(maskMap, vUv) < 0.5) discard;
      // Only extreme depth jumps are dropped. Smaller ones stretch, which shows nearby skin or
      // cloth instead of a black gap.
      if (vEdge > edgeThreshold) discard;
      float gap = 0.0;
      vec2 spot = vec2(0.0);
      vec2 uv = mouthOn == 1 ? mouthWarp(vUv, gap, spot) : vUv;
      vec3 c = colorAt(uv);
      if (gap > 0.0) {
        // The inside of her mouth, tinted from her own lips so it matches each Choom's light:
        // darkest up under the upper lip, a soft tongue rising from the bottom in the middle.
        vec3 lip = colorAt(mouthC);
        float height = spot.x;
        float middle = spot.y;
        vec3 inside = lip * mix(0.2, 0.06, smoothstep(0.35, 1.0, height));
        float tongue = (1.0 - smoothstep(0.08, 0.5, height)) * smoothstep(0.25, 0.8, middle);
        inside = mix(inside, lip * 0.5, tongue * 0.75);
        c = mix(c, inside, gap);
      }
      if (sparkle > 0.0) {
        // Genesis is made of motes: let the bright specks in her image twinkle on their own.
        vec3 local = packed == 1 ? colorAt(vUv) : texture2D(colorMap, vUv, 3.5).rgb;
        float speck = smoothstep(0.03, 0.22, dot(c - local, vec3(0.3, 0.5, 0.2)));
        float n = hash(floor(vUv * vec2(512.0, 683.0)));
        float twinkle = 0.25 + 1.5 * (0.5 + 0.5 * sin(time * (1.5 + 2.5 * n) + n * 6.2831));
        c = mix(c, local + (c - local) * twinkle, speck * sparkle);
      }
      gl_FragColor = vec4(c * glow * opacity, 1.0);
    }`;

const frontMaterial = layerMaterial({ segX: 384, segY: 512, edgeThreshold: 0.35, useMask: true });
const plateMaterial = layerMaterial({ segX: 192, segY: 256, edgeThreshold: 0.22, useMask: false });
const portrait = new THREE.Group();
const [plateMesh] = [[plateMaterial, 192, 256], [frontMaterial, 384, 512]].map(([material, segX, segY]) => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.0, segX, segY), material);
  mesh.frustumCulled = false;
  portrait.add(mesh);
  return mesh;
});
portrait.scale.setScalar(0.94);
scene.add(portrait);

// ---- Particles, styled per Choom --------------------------------------------------------
const PARTICLES = 320;
const pPos = new Float32Array(PARTICLES * 3);
const pCol = new Float32Array(PARTICLES * 3);
const pSize = new Float32Array(PARTICLES);
const pPhase = new Float32Array(PARTICLES);
const pVel = new Float32Array(PARTICLES * 3);
const pOrbit = new Float32Array(PARTICLES * 2); // radius, angular speed (motes)
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
pGeo.setAttribute('aPhase', new THREE.BufferAttribute(pPhase, 1));
const particleMaterial = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, opacity: { value: 0 } },
  vertexShader: /* glsl */ `
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aPhase;
    uniform float time, opacity;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vColor = aColor;
      vAlpha = opacity * (0.55 + 0.45 * sin(time * 2.3 + aPhase * 6.2831));
      gl_PointSize = aSize;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      if (r > 0.5) discard;
      gl_FragColor = vec4(vColor * smoothstep(0.5, 0.0, r) * vAlpha, 1.0);
    }`,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
const particles = new THREE.Points(pGeo, particleMaterial);
particles.frustumCulled = false;
scene.add(particles);

// A thin band of light: Optic's scan line and Eve's compile band.
const bandMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
});
const band = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.008), bandMaterial);
band.position.z = 0.07;
scene.add(band);

const rand = (a, b) => a + Math.random() * (b - a);
let style = 'embers';

function spawn(i, p, anywhere) {
  const c = new THREE.Color();
  const mixAccent = Math.random() < 0.18;
  c.copy(mixAccent ? p.accent : p.tint);
  if (style === 'embers') c.lerp(new THREE.Color(0xfff1c8), Math.random() * 0.35);
  pCol.set([c.r, c.g, c.b], i * 3);
  pPhase[i] = Math.random();
  pSize[i] = rand(2.5, 6);
  const x = rand(-0.72, 0.72);
  const z = rand(-0.6, 0.32);
  if (style === 'embers') {
    pPos.set([x, anywhere ? rand(-1, 1) : -1.05, z], i * 3);
    pVel.set([rand(-0.015, 0.015), rand(0.05, 0.13), 0], i * 3);
  } else if (style === 'code') {
    pPos.set([x, anywhere ? rand(-1, 1) : 1.05, z], i * 3);
    pVel.set([0, -rand(0.12, 0.26), 0], i * 3);
    pSize[i] = rand(2, 4.5);
  } else if (style === 'scan') {
    pPos.set([x, rand(-1, 1), z], i * 3);
    pVel.set([rand(-0.02, 0.02), rand(-0.02, 0.02), rand(-0.01, 0.01)], i * 3);
    pSize[i] = rand(2, 4);
  } else {
    // motes: spiral up around her
    const r = rand(0.32, 0.78);
    const a = rand(0, Math.PI * 2);
    pOrbit[i * 2] = r;
    pOrbit[i * 2 + 1] = rand(0.25, 0.6) * (Math.random() < 0.5 ? 1 : -1);
    pPhase[i] = a / (Math.PI * 2);
    pPos.set([Math.sin(a) * r, anywhere ? rand(-1, 1) : -1.05, Math.cos(a) * r * 0.55 - 0.12], i * 3);
    pVel.set([0, rand(0.03, 0.08), a], i * 3);
  }
}

function configureParticles(p) {
  style = p.style;
  for (let i = 0; i < PARTICLES; i++) spawn(i, p, true);
  for (const name of ['position', 'aColor', 'aSize', 'aPhase']) pGeo.attributes[name].needsUpdate = true;
  band.visible = style === 'scan' || style === 'code';
  bandMaterial.color.copy(style === 'scan' ? p.tint : p.accent).lerp(new THREE.Color(0xffffff), 0.35);
}

function updateParticles(dt, speed) {
  const p = portraits[current];
  for (let i = 0; i < PARTICLES; i++) {
    const k = i * 3;
    if (style === 'motes') {
      pVel[k + 2] += pOrbit[i * 2 + 1] * dt * speed;
      const r = pOrbit[i * 2];
      pPos[k] = Math.sin(pVel[k + 2]) * r;
      pPos[k + 1] += pVel[k + 1] * dt * speed;
      pPos[k + 2] = Math.cos(pVel[k + 2]) * r * 0.55 - 0.12;
      if (pPos[k + 1] > 1.05) spawn(i, p, false);
    } else {
      pPos[k] += pVel[k] * dt * speed;
      pPos[k + 1] += pVel[k + 1] * dt * speed;
      pPos[k + 2] += pVel[k + 2] * dt * speed;
      if (style === 'embers') pPos[k] += Math.sin(simTime * 0.9 + pPhase[i] * 40) * 0.004 * speed;
      const out = pPos[k + 1] > 1.05 || pPos[k + 1] < -1.05 || Math.abs(pPos[k]) > 0.78;
      if (out) spawn(i, p, style === 'scan');
    }
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.aColor.needsUpdate = true;
  pGeo.attributes.aSize.needsUpdate = true;
  pGeo.attributes.aPhase.needsUpdate = true;
}

// ---- Aloy's sister orbs: Genesis, Optic and Eve circling her on tilted orbits ---------------
// An atom around her: four orbits share one center, turned 0/45/90/135 degrees in the picture,
// each leaned in depth the opposite way to its neighbor, so the paths cross in front of and behind
// her instead of bunching up. One shared speed with these phases keeps the orbs at least 0.43
// units apart at all times (checked by simulation; mixed speeds eventually collide).
// Orbs: Genesis, Optic, Eve, and Aloy's own gold.
// pitch tips the whole atom back: lower arcs (her chest and shoulders) pass behind her, upper
// arcs beside her head come forward. A rigid tilt, so orb spacing is unchanged.
const ATOM = { cy: 0.26, rx: 0.6, ry: 0.34, lean: 0.62, speed: 0.46, pitch: 0.32 };
const ORBITS = [
  { color: 0xb79bff, phase: 0.0 },              // Genesis
  { color: 0x57dbe3, phase: 0.6 * Math.PI },    // Optic
  { color: 0xe4eeff, phase: 1.1 * Math.PI },    // Eve
  { color: 0xf4b650, phase: 1.7 * Math.PI },    // Aloy
].map((o, k) => ({
  ...o, rx: ATOM.rx, ry: ATOM.ry, cy: ATOM.cy, speed: ATOM.speed, yaw: 0, pitch: ATOM.pitch,
  roll: k * Math.PI / 4, lean: k % 2 === 0 ? ATOM.lean : -ATOM.lean,
}));
const TRAIL = 36;
const orbGroup = new THREE.Group();
scene.add(orbGroup);
const orbGeo = new THREE.SphereGeometry(0.048, 32, 16);
const orbs = ORBITS.map((o) => {
  const core = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(o.color).multiplyScalar(1.2) }));
  const trailPos = new Float32Array(TRAIL * 3);
  const trailCol = new Float32Array(TRAIL * 3);
  const trailSize = new Float32Array(TRAIL);
  const trailPhase = new Float32Array(TRAIL);
  const c = new THREE.Color(o.color);
  for (let i = 0; i < TRAIL; i++) {
    const k = 1 - i / TRAIL;
    trailCol.set([c.r * k, c.g * k, c.b * k], i * 3);
    trailSize[i] = 3 + 20 * k * k;
    trailPhase[i] = 0.25; // steady: sin(...) term sits near its peak
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(trailCol, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(trailSize, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(trailPhase, 1));
  const trailMaterial = particleMaterial.clone();
  const trail = new THREE.Points(g, trailMaterial);
  trail.frustumCulled = false;
  orbGroup.add(core, trail);
  return { ...o, core, trail, trailPos, trailMaterial, primed: false };
});

function ringPoint(o, a, out) {
  let x = Math.cos(a) * o.rx;
  let y = Math.sin(a) * o.ry;
  let z = y * Math.sin(o.lean);           // lean: top goes back, bottom comes forward (or reverse)
  y *= Math.cos(o.lean);
  [x, y] = [x * Math.cos(o.roll) - y * Math.sin(o.roll), x * Math.sin(o.roll) + y * Math.cos(o.roll)];
  [x, z] = [x * Math.cos(o.yaw) + z * Math.sin(o.yaw), -x * Math.sin(o.yaw) + z * Math.cos(o.yaw)];
  const p = o.pitch ?? 0;
  [y, z] = [y * Math.cos(p) - z * Math.sin(p), y * Math.sin(p) + z * Math.cos(p)];
  return out.set(x, o.cy + y, z - 0.02);
}
const orbPosition = (o, t, out) => ringPoint(o, t * o.speed + o.phase, out);

// Gold threads: each orb rides its own glowing ring, plus one ring that carries no orb. A glint of
// light travels along each thread. Rings pass behind her (her body hides them) and in front.
const RINGS = ORBITS;
const threadMaterials = RINGS.map((o, i) => new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, opacity: { value: 0 }, offset: { value: i * 0.29 },
    color: { value: new THREE.Color(0xf6c25a) } },
  vertexShader: 'varying float vAlong; void main() { vAlong = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform float time, opacity, offset;
    uniform vec3 color;
    varying float vAlong;
    void main() {
      float glint = pow(fract(vAlong - time * 0.11 + offset), 18.0);
      gl_FragColor = vec4(color * (0.5 + 2.4 * glint) * opacity, 1.0);
    }`,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
}));
RINGS.forEach((o, i) => {
  const pts = [];
  for (let k = 0; k < 160; k++) pts.push(ringPoint(o, (k / 160) * Math.PI * 2, new THREE.Vector3()));
  const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 360, 0.0055, 6, true);
  const ring = new THREE.Mesh(tube, threadMaterials[i]);
  ring.frustumCulled = false;
  orbGroup.add(ring);
});

const tmp = new THREE.Vector3();
function updateOrbs(presence) {
  for (const o of orbs) {
    orbPosition(o, simTime, o.core.position);
    o.core.material.opacity = presence;
    o.core.material.transparent = presence < 1;
    // The trail is the orbit's recent past, sampled backwards in time.
    for (let i = 0; i < TRAIL; i++) {
      orbPosition(o, simTime - i * 0.045, tmp);
      o.trailPos.set([tmp.x, tmp.y, tmp.z], i * 3);
    }
    o.trail.geometry.attributes.position.needsUpdate = true;
    o.trailMaterial.uniforms.time.value = simTime;
    o.trailMaterial.uniforms.opacity.value = presence;
  }
  for (const m of threadMaterials) {
    m.uniforms.time.value = simTime;
    m.uniforms.opacity.value = presence;
  }
}

// ---- Name label at the glass plane (z = 0 is the sharpest depth on the panel) --------------
const labelCanvas = document.createElement('canvas');
labelCanvas.width = 1024;
labelCanvas.height = 256;
const labelTexture = new THREE.CanvasTexture(labelCanvas);
labelTexture.colorSpace = THREE.SRGBColorSpace;
const labelMaterial = new THREE.MeshBasicMaterial({
  map: labelTexture, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
});
const label = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.2), labelMaterial);
label.position.set(0, -0.86, 0.0);
scene.add(label);

function drawLabel(p) {
  const g = labelCanvas.getContext('2d');
  g.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
  g.textAlign = 'center';
  g.shadowColor = p.color;
  g.shadowBlur = 28;
  g.fillStyle = p.color;
  g.font = '600 120px Georgia, "Times New Roman", serif';
  g.fillText(p.name, 512, 128);
  g.shadowBlur = 12;
  g.fillStyle = '#e8e6f0';
  g.font = '500 38px ui-monospace, monospace';
  g.fillText(p.role.toUpperCase(), 512, 200);
  labelTexture.needsUpdate = true;
}

// ---- State --------------------------------------------------------------------------------
let current = 0;
let pending = null;
let phase = 'in';        // 'in' -> 'idle' -> 'out' -> 'in'
let phaseT = 0;
let labelT = 0;
let listening = false;
let listenAmt = 0;
let paused = false;
let simTime = 0;
const baseDepth = { value: 0.75 };

function applyPortrait(i) {
  const p = portraits[i];
  const fu = frontMaterial.uniforms;
  fu.packed.value = p.alive ? 1 : 0;
  fu.colorMap.value = p.alive ? p.videoTexture : p.color;
  fu.depthMap.value = p.alive ? p.videoTexture : p.depth;
  fu.maskMap.value = p.alive ? p.videoTexture : p.mask;
  plateMaterial.uniforms.colorMap.value = p.plate;
  plateMaterial.uniforms.depthMap.value = p.plateDepth;
  // Her moving relief stands in empty glass: the still plate was painted for the old pose.
  plateMesh.visible = !p.alive;
  for (const q of portraits) if (q.video && q !== p) q.video.pause();
  if (p.video) p.video.play().catch((e) => post('error', { message: `alive video: ${e.message}` }));
  shared.focus.value = p.alive ? p.alive.focus : p.focus;
  configureParticles(p);
  frontMaterial.uniforms.sparkle.value = p.style === 'motes' ? 1 : 0;
  fu.mouthOn.value = p.mouth || p.alive ? 1 : 0;
  // A moving relief's mouth opens a little less: its face is livelier to begin with.
  fu.mouthGain.value = p.alive ? 0.75 : 1;
  fu.mouthGap.value = 0;
  if (p.alive) {
    fu.texSize.value.set(p.alive.texSize[0], p.alive.texSize[1]);
    followAliveMouth(p);
  } else if (p.mouth) {
    fu.mouthC.value.set(p.mouth.center[0], p.mouth.center[1]);
    fu.mouthSize.value.set(p.mouth.halfWidth, p.mouth.halfHeight, p.mouth.chin);
    fu.mouthTilt.value = p.mouth.tilt;
    fu.texSize.value.set(p.mouth.texSize[0], p.mouth.texSize[1]);
  }
  orbGroup.visible = Boolean(p.orbit);
  drawLabel(p);
  labelT = 0;
  for (const entry of bodies.values()) if (entry.ready) entry.ready.group.visible = false;
  body = (p.showBody && bodyFor(p)?.ready) || null;
  if (body) {
    body.setLook(p);
    body.group.visible = true;
  }
  portrait.visible = !body;
}

// Start loading a Choom's body (once per GLB); when it arrives, show it if she still wants it.
function bodyFor(p) {
  if (!p.bodyUrl) return null;
  const url = p.bodyUrl;
  if (!bodies.has(url)) {
    const entry = { ready: null };
    bodies.set(url, entry);
    const started = performance.now();
    loadBody(url, renderer).then((b) => {
      b.group.visible = false;
      scene.add(b.group);
      entry.ready = b;
      post('body', { url, ms: Math.round(performance.now() - started), morphs: b.morphNames.length });
      const now = portraits[current];
      if (now.showBody && now.bodyUrl === url) switchTo(current, true);
    }).catch((e) => post('error', { message: `body ${url}: ${e.message}` }));
  }
  return bodies.get(url);
}

function setBody(on) {
  const p = portraits[current];
  if (!p.bodyUrl) {
    post('error', { message: `no body for ${p.name}` });
    return;
  }
  p.showBody = on;
  if (!on || bodyFor(p).ready) switchTo(current, true); // otherwise it switches once loaded
}

// Her mouth moves with her in the video: track which frame is showing and follow its landmarks.
for (const p of portraits) {
  if (!p.video) continue;
  const onFrame = (now, meta) => {
    p.aliveFrame = Math.round(meta.mediaTime * p.alive.fps) % p.alive.frames;
    p.video.requestVideoFrameCallback(onFrame);
  };
  p.video.requestVideoFrameCallback(onFrame);
}

function followAliveMouth(p) {
  const m = p.alive.mouth[p.aliveFrame];
  const fu = frontMaterial.uniforms;
  fu.mouthC.value.set(m[0], m[1]);
  fu.mouthSize.value.set(m[2], m[3], m[4]);
  fu.mouthTilt.value = m[5];
  fu.mouthGap.value = m[6] ?? 0;
}

function switchTo(i, force = false) {
  const next = (i + portraits.length) % portraits.length;
  if (next === current && phase !== 'out' && !force) return;
  pending = next;
  if (phase !== 'out') {
    phase = 'out';
    phaseT = 0;
  }
  post('choom', { choom: portraits[next].name });
}

function onButton(button, action) {
  post('button', { button, action });
  if (action === 'press' && button === 'top') switchTo(current - 1);
  if (action === 'press' && button === 'middle') switchTo(current + 1);
  if (button === 'bottom') {
    if (action === 'press' && (speech.busy || speech.queue.length)) stopSpeech(); // talking over her
    listening = action === 'press';
  }
}

const events = new EventSource('/events');
events.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'button') onButton(ev.button, ev.action);
  if (ev.type === 'control') onControl(ev);
  if (ev.type === 'choom') onChoomEvent(ev);
};

// Remote control (POST /control): the hook the Choom app will use to show who's talking.
function onControl(ev) {
  if (typeof ev.choom === 'string') {
    const i = portraits.findIndex((p) => p.id === ev.choom.toLowerCase());
    if (i >= 0) switchTo(i);
  }
  if (ev.action === 'next') switchTo(current + 1);
  if (ev.action === 'prev') switchTo(current - 1);
  if (typeof ev.listening === 'boolean') listening = ev.listening;
  if (typeof ev.voice === 'boolean') setVoice(ev.voice);
  if (typeof ev.body === 'boolean') setBody(ev.body);
  if (typeof ev.quilt === 'boolean') lkg.mode = ev.quilt ? 1 : 0; // debug: show the raw views
}

// ---- Choom app link: show whoever is talking and speak her reply in her own voice ----------
// Events come from the Choom app on the Mac (relayed by server.py). Like the web app, she speaks
// only a conversation someone at home has open: the Mac marks each sentence `speak`. Everything
// else (rooms the Chooms run on their own, Signal, heartbeats) is shown but stays silent.
let voiceOn = true;
let mood = 'idle';            // idle | thinking | speaking
let lastTurn = null;          // { index, open }
let audioCtx = null;
let analyser = null;
let level = 0;
const levelBuf = new Float32Array(1024);
const speech = { queue: [], busy: false, epoch: 0, source: null };

// Her voice: source -> 80 ms delay -> analyser (glow) -> speakers, and source -> HeadAudio, which
// reads mouth shapes (visemes) 50-100 ms late; the delay lines voice and lips up.
let headaudio = null;
let speechDelay = null;
const visemes = {};
const audioReady = (async () => {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(audioCtx.destination);
  speechDelay = new DelayNode(audioCtx, { delayTime: 0.08 });
  speechDelay.connect(analyser);
  try {
    await audioCtx.audioWorklet.addModule('./vendor/headaudio/headworklet.min.mjs');
    const node = new HeadAudio(audioCtx, {
      processorOptions: {},
      parameterData: { vadGateActiveDb: -40, vadGateInactiveDb: -60 },
    });
    await node.loadModel('./vendor/headaudio/model-en-mixed.bin');
    node.onvalue = (key, value) => { visemes[key] = value; };
    headaudio = node;
  } catch (e) {
    post('error', { message: `lip sync unavailable, using loudness: ${e.message}` });
  }
})();

function ensureAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

// Each viseme as [jaw open, lips round, lips wide]; HeadAudio's weights blend them.
const VISEME_SHAPES = {
  viseme_sil: [0, 0, 0], viseme_PP: [0, 0.1, 0], viseme_FF: [0.12, 0, 0.2], viseme_TH: [0.2, 0, 0.1],
  viseme_DD: [0.25, 0, 0.15], viseme_kk: [0.3, 0, 0.1], viseme_CH: [0.22, 0.45, 0], viseme_SS: [0.1, 0, 0.45],
  viseme_nn: [0.2, 0, 0.1], viseme_RR: [0.22, 0.5, 0], viseme_aa: [1, 0, 0.1], viseme_E: [0.55, 0, 0.6],
  viseme_I: [0.35, 0, 0.85], viseme_O: [0.7, 0.85, 0], viseme_U: [0.32, 1, 0],
};
const mouthNow = { jaw: 0, round: 0, wide: 0 };
const bodyVisemes = Object.fromEntries(VISEMES.map((v) => [v, 0])); // a body's lips: the visemes themselves

function updateMouth(dt) {
  let jaw = 0;
  let round = 0;
  let wide = 0;
  if (mood === 'speaking') {
    if (headaudio) {
      for (const [key, [j, r, w]] of Object.entries(VISEME_SHAPES)) {
        const v = visemes[key] || 0;
        jaw += v * j;
        round += v * r;
        wide += v * w;
      }
    } else {
      jaw = level * 0.9;
    }
  }
  // HeadAudio's weights rarely sum near 1, and the panel shows her mouth only ~50 px wide: boost.
  jaw *= 1.5;
  const k = Math.min(dt * 25, 1);
  mouthNow.jaw += (Math.min(jaw, 1) - mouthNow.jaw) * k;
  mouthNow.round += (Math.min(round, 1) - mouthNow.round) * k;
  mouthNow.wide += (Math.min(wide, 1) - mouthNow.wide) * k;
  frontMaterial.uniforms.mouthShape.value.set(mouthNow.jaw, mouthNow.round, mouthNow.wide);
  for (const v of VISEMES) {
    let target = 0;
    if (mood === 'speaking') target = headaudio ? (visemes[v] || 0) * 1.3 : v === 'viseme_aa' ? level * 0.8 : 0;
    bodyVisemes[v] += (Math.min(target, 1) - bodyVisemes[v]) * k;
  }
}

// Latency of each spoken turn, for the latency table: her first text after the turn starts, her
// first voice after that text (including any wait behind another Choom still talking in a room),
// and the silent gaps between her pieces. Each turn keeps its own clock, since in a room the next
// turn starts while the last speaker is still talking. Posted as `latency`.
const clocks = new Map(); // choom name -> clock of her latest turn

function finishClock(c) {
  if (!c || !c.ended || c.pending > 0) return;
  if (clocks.get(c.choom) === c) clocks.delete(c.choom);
  if (!c.firstVoice) return; // never spoken (not an open conversation)
  post('latency', {
    choom: c.choom,
    source: c.source,
    firstTextMs: Math.round(c.firstText - c.start),
    firstVoiceMs: Math.round(c.firstVoice - c.firstText),
    totalMs: Math.round(c.firstVoice - c.start),
    queuedBehind: c.queuedBehind,
    pieces: c.pieces,
    maxGapMs: Math.round(c.gaps.length ? Math.max(...c.gaps) : 0),
    avgGapMs: Math.round(c.gaps.length ? c.gaps.reduce((a, b) => a + b, 0) / c.gaps.length : 0),
    lipSync: headaudio ? 'headaudio' : 'loudness',
  });
}

function choomIndex(name) {
  return portraits.findIndex((p) => p.id === String(name || '').toLowerCase());
}

// Join short sentences into chunks of up to ~260 characters: fewer TTS calls, natural phrasing.
function chunkSentences(sentences) {
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && buf.length + s.length + 1 > 260) {
      chunks.push(buf);
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// Speech pieces: the very first goes out as a single sentence so she starts talking quickly; the
// rest are sentence groups of up to ~180 characters (Chatterbox renders faster than real time,
// so each next piece is ready before the current one finishes).
function speechPieces(text, first) {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const pieces = [];
  let buf = '';
  for (const s of sentences) {
    const limit = first && pieces.length === 0 ? 0 : 180;
    if (buf && buf.length + s.length + 1 > limit) {
      pieces.push(buf);
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function onChoomEvent(ev) {
  const i = choomIndex(ev.choom);
  switch (ev.event) {
    case 'turn_start':
      lastTurn = { index: i, open: true };
      clocks.set(ev.choom, { choom: ev.choom, source: ev.source, start: performance.now(), firstText: 0, firstVoice: 0,
        gaps: [], lastEnd: 0, pieces: 0, pending: 0, queuedBehind: 0, ended: false });
      if (!speech.busy && !speech.queue.length) {
        if (i >= 0) switchTo(i);
        mood = 'thinking';
      }
      break;
    case 'content': {
      // The Choom app sends whole sentences (gathered from the stream like its own web voice).
      const texts = typeof ev.text === 'string' ? [ev.text] : Array.isArray(ev.sentences) ? chunkSentences(ev.sentences) : [];
      if (voiceOn && ev.speak === true && i >= 0 && texts.length) {
        const c = clocks.get(ev.choom);
        if (c && !c.firstText) {
          c.firstText = performance.now();
          c.queuedBehind = speech.queue.length + (speech.busy ? 1 : 0);
        }
        for (const text of texts) {
          const first = !speech.busy && speech.queue.length === 0;
          for (const piece of speechPieces(text, first)) {
            speech.queue.push({ text: piece, voice: ev.voice || VOICES[portraits[i].id], index: i, clock: c });
            if (c) c.pending++;
          }
        }
        runSpeech();
      }
      break;
    }
    case 'mute':
      // The web app's mute button: stop talking now and stay quiet until unmuted.
      setVoice(!ev.muted);
      break;
    case 'retract':
      stopSpeech();
      break;
    case 'turn_end':
    case 'error':
      if (lastTurn && lastTurn.index === i) lastTurn.open = false;
      if (!speech.busy && !speech.queue.length) mood = 'idle';
      if (clocks.has(ev.choom)) {
        const c = clocks.get(ev.choom);
        c.ended = true;
        finishClock(c);
      }
      break;
  }
  post('choom-event', { event: ev.event, choom: ev.choom, source: ev.source });
}

async function fetchSpeech(item) {
  const r = await fetch('/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: item.text, voice: item.voice }),
  });
  if (!r.ok) throw new Error(`speech ${r.status}`);
  const bytes = await r.arrayBuffer();
  await audioReady;
  ensureAudio();
  return audioCtx.decodeAudioData(bytes);
}

function play(buffer) {
  return new Promise((resolve) => {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(speechDelay);
    if (headaudio) src.connect(headaudio);
    src.onended = resolve;
    speech.source = src;
    src.start();
  });
}

// One speech request in flight at a time (Chatterbox dislikes bursts): the next chunk is fetched
// while the current one plays.
async function runSpeech() {
  if (speech.busy) return;
  speech.busy = true;
  const epoch = speech.epoch;
  try {
    while (speech.queue.length && epoch === speech.epoch) {
      const item = speech.queue.shift();
      let audio;
      try {
        audio = await (item.pending || fetchSpeech(item));
      } catch (e) {
        post('error', { message: `speech failed: ${e.message}` });
        continue;
      }
      if (epoch !== speech.epoch) break;
      const next = speech.queue[0];
      if (next && !next.pending) {
        next.pending = fetchSpeech(next);
        next.pending.catch(() => {});
      }
      if (item.index !== current) switchTo(item.index);
      mood = 'speaking';
      const c = item.clock;
      if (c) {
        const now = performance.now();
        if (!c.firstVoice) c.firstVoice = now;
        else if (c.lastEnd) c.gaps.push(now - c.lastEnd);
        c.pieces++;
      }
      await play(audio);
      if (c) {
        c.lastEnd = performance.now();
        c.pending--;
        finishClock(c);
      }
    }
  } finally {
    speech.busy = false;
    speech.source = null;
    if (epoch === speech.epoch) afterSpeech();
  }
}

function afterSpeech() {
  if (lastTurn && lastTurn.open) {
    if (lastTurn.index >= 0 && lastTurn.index !== current) switchTo(lastTurn.index);
    mood = 'thinking';
  } else {
    mood = 'idle';
  }
}

function setVoice(on) {
  voiceOn = on;
  if (!on) stopSpeech();
  sendStatus(); // tell the server right away so the voice hand-off follows without delay
}

function stopSpeech() {
  speech.epoch++;
  speech.queue.length = 0;
  clocks.clear(); // interrupted turns aren't latency samples
  try { speech.source?.stop(); } catch { /* already stopped */ }
  speech.busy = false;
  afterSpeech();
}

function updateLevel(dt) {
  let target = 0;
  if (analyser && mood === 'speaking') {
    analyser.getFloatTimeDomainData(levelBuf);
    let sum = 0;
    for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
    target = Math.min(1, Math.sqrt(sum / levelBuf.length) * 4.5);
  }
  // Fast attack, slower release, so the glow follows syllables without flicker.
  level += (target - level) * Math.min(dt * (target > level ? 30 : 8), 1);
}

const hud = document.getElementById('hud');
let hudOn = false;
window.addEventListener('keydown', (e) => {
  if (e.repeat && e.code !== 'KeyL') return;
  switch (e.code) {
    case 'ArrowLeft': switchTo(current - 1); break;
    case 'ArrowRight': switchTo(current + 1); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': switchTo(Number(e.code.slice(-1)) - 1); break;
    case 'KeyL': listening = true; break;
    case 'KeyM': setVoice(!voiceOn); break;
    case 'KeyB': setBody(!portraits[current].showBody); break;
    case 'Space': paused = !paused; break;
    case 'KeyH': hudOn = !hudOn; hud.hidden = !hudOn; break;
    case 'Minus': baseDepth.value = Math.max(0.2, baseDepth.value - 0.05); break;
    case 'Equal': baseDepth.value = Math.min(1.8, baseDepth.value + 0.05); break;
    case 'BracketLeft': lkg.center -= e.shiftKey ? 0.001 : 0.005; break;
    case 'BracketRight': lkg.center += e.shiftKey ? 0.001 : 0.005; break;
    default: return;
  }
  post('tuning', { depth: baseDepth.value, center: lkg.center, choom: portraits[current].name });
  e.preventDefault();
});
window.addEventListener('keyup', (e) => { if (e.code === 'KeyL') listening = false; });

const ease = (x) => x * x * (3 - 2 * x);
let frames = 0;
let fps = 0;
let fpsT = performance.now();
let last = performance.now();

for (const p of portraits) if (p.hasBody) bodyFor(p); // real bodies load up front
applyPortrait(current);

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!paused) simTime += dt;
  phaseT += dt;
  labelT += dt;

  // Transitions: fade out and flatten, swap, rise back to full depth.
  let presence = 1;
  if (phase === 'out') {
    presence = 1 - ease(Math.min(phaseT / 0.45, 1));
    if (phaseT >= 0.45) {
      current = pending;
      pending = null;
      applyPortrait(current);
      phase = 'in';
      phaseT = 0;
      presence = 0;
    }
  } else if (phase === 'in') {
    presence = ease(Math.min(phaseT / 0.9, 1));
    if (phaseT >= 0.9) phase = 'idle';
  }

  listenAmt += ((listening ? 1 : 0) - listenAmt) * Math.min(dt * 6, 1);
  updateLevel(dt);
  if (headaudio) headaudio.update(dt * 1000);
  updateMouth(dt);
  if (portraits[current].alive) followAliveMouth(portraits[current]);
  const thinking = mood === 'thinking' ? 1 : 0;

  // Idle life: slow sway, a little float, breathing depth.
  const tau = Math.PI * 2;
  portrait.rotation.y = Math.sin(simTime * tau / 9.0) * 0.045;
  portrait.position.y = Math.sin(simTime * tau / 6.5) * 0.012;
  portrait.position.z = 0.06 * listenAmt + 0.025 * level;
  const breath = 1 + Math.sin(simTime * tau / 4.6) * 0.035;
  shared.depthScale.value = baseDepth.value * breath * (0.25 + 0.75 * presence);
  shared.opacity.value = presence;
  shared.glow.value = 1 + 0.22 * listenAmt + 0.3 * level + thinking * 0.06 * Math.sin(simTime * 3.2);

  if (body) {
    body.update({
      dt: paused ? 0 : dt, time: simTime, presence, glow: shared.glow.value, level, listen: listenAmt,
      thinking: mood === 'thinking', speaking: mood === 'speaking', visemes: bodyVisemes,
      bandY: band.position.y, bandOn: band.visible,
    });
  }

  updateParticles(paused ? 0 : dt, 1 + 1.5 * listenAmt + 1.4 * thinking + 2.5 * level);
  shared.time.value = simTime;
  if (orbGroup.visible) updateOrbs(presence);
  particleMaterial.uniforms.time.value = simTime;
  particleMaterial.uniforms.opacity.value = presence * (0.85 + 0.4 * listenAmt + 0.5 * level);

  if (band.visible) {
    const cycle = style === 'scan' ? (simTime % 5) / 5 : 0.5 + 0.5 * Math.sin(simTime * tau / 7);
    band.position.y = style === 'scan' ? 1 - cycle * 2 : -0.75 + cycle * 1.3;
    const edgeFade = style === 'scan' ? Math.sin(cycle * Math.PI) : 1;
    bandMaterial.opacity = 0.75 * presence * edgeFade;
  }

  // Name shows for a few seconds after each switch.
  const labelFade = labelT < 0.6 ? labelT / 0.6 : labelT < 3.6 ? 1 : Math.max(0, 1 - (labelT - 3.6) / 0.8);
  labelMaterial.opacity = labelFade * presence;

  lkg.renderQuilt(scene);
  lkg.present();

  frames++;
  if (now - fpsT >= 1000) {
    fps = Math.round((frames * 1000) / (now - fpsT));
    frames = 0;
    fpsT = now;
    if (hudOn) {
      const exact = innerWidth === 1536 && innerHeight === 2048 && devicePixelRatio === 1;
      const shown = body ? `body ${body.url.split('/').pop()}` : `depth ${baseDepth.value.toFixed(2)}`;
      hud.innerHTML = `LIVING PORTRAITS  ${fps} fps\nchoom ${portraits[current].name}   ${shown}\n` +
        (exact ? `window ${innerWidth}x${innerHeight} at ${screenX},${screenY}` :
          `<span class="warn">window ${innerWidth}x${innerHeight} at ${screenX},${screenY} NOT pixel-exact</span>`) +
        `\n← → or buttons: switch   hold L or bottom button: listen\nb body   - = depth   h hide`;
    }
  }
});

const windowInfo = () => ({
  exact: innerWidth === lkg.cal.screenW && innerHeight === lkg.cal.screenH && devicePixelRatio === 1,
  text: `${innerWidth}x${innerHeight} @${devicePixelRatio}x at ${screenX},${screenY}`,
});
post('start', { page: 'living', chooms: portraits.map((p) => p.name), window: windowInfo() });
function sendStatus() {
  post('status', {
    page: 'living', fps, choom: portraits[current].name, body: body ? body.url : null, listening, mood, voiceOn,
    queued: speech.queue.length, window: windowInfo(),
  });
}
setInterval(sendStatus, 2000);
