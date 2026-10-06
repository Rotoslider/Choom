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

// One of the two video players a moving relief takes turns with.
function makePlayer() {
  const video = document.createElement('video');
  Object.assign(video, { muted: true, playsInline: true, preload: 'auto' });
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.NoColorSpace; // color and depth share it; the shader decodes each
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { video, texture, clip: -1 };
}

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
  // A moving relief (tools/make_alive.py): her idle clips as video (color, depth and cut-out panels)
  // with her mouth position for every frame. When present it replaces the still image.
  const alive = await fetch(`${dir}/alive.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (alive && !alive.clips) alive.clips = [{ file: 'alive.mp4', frames: alive.frames, mouth: alive.mouth }]; // one-clip format
  return {
    ...m,
    dir,
    mouth,
    alive,
    players: alive ? [makePlayer(), makePlayer()] : null,
    active: 0,
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

// `own`: a sister on the group stage keeps her own focus, depth, fade and glow.
function layerMaterial({ segX, segY, edgeThreshold, useMask, own = false }) {
  const base = own ? { ...shared, focus: { value: 0.5 }, depthScale: { value: 0.75 }, opacity: { value: 0 }, glow: { value: 1 } } : shared;
  return new THREE.ShaderMaterial({
    uniforms: {
      ...base,
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
      mouthLift: { value: 0 },                            // how far her mouth corners curve up (texture px)
      mouthGain: { value: 1 },                            // how far the jaw opens
      mouthShape: { value: new THREE.Vector3() },        // jaw open, lips round, lips wide (0..1)
      bottomFade: { value: 0 },                           // on the group stage: fade out her lowest part
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
    uniform float opacity, glow, edgeThreshold, sparkle, time, bottomFade;
    uniform int useMask, mouthOn;
    uniform vec2 mouthC, texSize;
    uniform vec3 mouthSize, mouthShape;
    uniform float mouthTilt, mouthGap, mouthGain, mouthLift;
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
    // Her neighborhood's average around uv: the mip chain for a still, a few nearby taps for a video.
    vec3 localAt(vec2 uv, vec3 here) {
      if (packed == 1) {
        vec2 o = 3.0 / texSize;
        return 0.2 * (here + colorAt(uv + vec2(o.x, 0.0)) + colorAt(uv - vec2(o.x, 0.0))
                           + colorAt(uv + vec2(0.0, o.y)) + colorAt(uv - vec2(0.0, o.y)));
      }
      return texture2D(colorMap, uv, 3.5).rgb;
    }
    float vnoise(vec2 q) {
      vec2 i = floor(q), f = fract(q);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }

    // Talking, the way a mouth opens: the corners stay put and the lips part in a lens shape from
    // corner to corner. Right under the lips the lower lip drops by that lens profile (zero at the
    // corners); lower down it becomes the whole jaw dropping, fading out past the chin. The
    // opening fills exactly the space the lower lip leaves, so no lip line is drawn twice. Lips
    // also round or spread. Worked in texture pixels in the mouth's own frame. When her lips are
    // already parted in the picture (a moving relief's smile), the opening starts at the upper
    // lip's inner edge, so the teeth showing between them don't read as a line under that lip.
    // The lip line follows her smile: it curves up toward the corners by mouthLift, so the opening
    // stays between her lips instead of running out past the corners as dark slivers.
    vec2 mouthWarp(vec2 uv, out float gap, out vec2 spot) {
      gap = 0.0;
      spot = vec2(0.0);
      float jaw = mouthShape.x, rnd = mouthShape.y, wide = mouthShape.z;
      if (jaw + rnd + wide < 0.002) return uv;
      float hw = mouthSize.x, hh = mouthSize.y, chin = mouthSize.z;
      float ca = cos(mouthTilt), sa = sin(mouthTilt);
      vec2 p = (uv - mouthC) * texSize;
      vec2 q = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
      float seam = mouthLift * min(pow(q.x / hw, 2.0), 1.0);  // the lip line's height here
      q.y -= seam;
      vec2 s = q;
      // Rounding pulls the lips toward the middle; spreading pushes them out.
      float lips = exp(-pow(q.x / (hw * 1.5), 2.0) - pow(q.y / (hh * 2.5), 2.0));
      float squeeze = 1.0 + (0.3 * rnd - 0.14 * wide) * lips * mouthGain;
      s.x *= squeeze;
      float cw = hw / squeeze;                              // where the corners now sit
      float lens = max(0.0, 1.0 - pow(q.x / cw, 2.0));      // 1 mid-mouth, 0 at the corners
      // A mouth already open in the picture (a laugh) only needs a little more jaw.
      float parted = smoothstep(0.15 * hh, 0.6 * hh, mouthGap);
      // Scaled by lip height, but no more than a narrow mouth's width allows (Eve's full lips on a
      // narrow mouth looked swollen when they opened by height alone).
      float open = jaw * min(hh, 0.3 * hw) * 2.8 * mouthGain * mix(1.0, 0.35, parted);
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
      // Edges soft by about one panel pixel, so they don't stair-step at the panel's resolution.
      float aa = clamp(fwidth(q.y), 0.5, 4.0);
      // Closed lips: the opening starts at the upper lip. Parted lips: her teeth stay, and only what
      // the lowered lower lip uncovers goes dark.
      float gapTop = mix(top, rest, parted);
      gap = smoothstep(-0.5 * aa, aa, gapTop - q.y) * smoothstep(-0.5 * aa, 1.5 * aa, q.y - lowerLip)
          * smoothstep(0.5, 3.0, open);
      // Where in the opening this pixel sits, for shading the inside: height (0 at the lower lip,
      // 1 at the upper lip) and how central it is (1 mid-mouth, 0 at the corners). No teeth: pale
      // teeth with no real detail read as a second upper lip.
      spot = vec2(clamp((q.y - lowerLip) / max(gapTop - lowerLip, 0.5), 0.0, 1.0), lens);
      s.y += seam;
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
        // The inside of her mouth, tinted from her own lips so it matches each Choom's light. Not a
        // black void: a warm dark red, darkest up under the upper lip, with a soft tongue rising
        // from the bottom in the middle.
        // Her lip color, from the upper lip itself (the middle of a smile can be teeth).
        vec2 up = vec2(-sin(mouthTilt), cos(mouthTilt)) * (mouthGap + 0.6 * mouthSize.y) / texSize;
        vec3 lip = colorAt(mouthC + up);
        float height = spot.x;
        float middle = spot.y;
        vec3 mouthRed = mix(lip, vec3(0.42, 0.10, 0.09), 0.45);
        vec3 inside = mouthRed * mix(0.32, 0.1, smoothstep(0.3, 1.0, height));
        float tongue = (1.0 - smoothstep(0.08, 0.55, height)) * smoothstep(0.2, 0.75, middle);
        inside = mix(inside, mouthRed * 0.62, tongue * 0.85);
        c = mix(c, inside, gap);
      }
      if (sparkle > 0.0) {
        // Genesis is made of motes, and they move: the glitter in her image drifts in slow little
        // circles across her (each patch on its own), every mote twinkles as it goes, and a soft
        // wave of light rises through her. Only the bright specks move; her features stay put.
        const vec3 W = vec3(0.3, 0.5, 0.2);
        vec3 local = localAt(vUv, c);
        float speckHere = smoothstep(0.03, 0.22, dot(c - local, W));
        float turn = vnoise(vUv * 7.0) * 12.566 + time * (0.5 + 0.4 * vnoise(vUv * 3.0 + 7.0));
        vec2 at = vUv + 5.0 * vec2(cos(turn), sin(turn)) / texSize;  // where this pixel's mote comes from
        vec3 there = colorAt(at);
        vec3 detail = there - localAt(at, there);
        float speckThere = smoothstep(0.03, 0.22, dot(detail, W));
        float n = hash(floor(at * texSize / 1.5));                  // each mote keeps its own twinkle
        float twinkle = 0.3 + 1.4 * (0.5 + 0.5 * sin(time * (1.5 + 2.5 * n) + n * 6.2831));
        float wave = 0.7 + 0.6 * smoothstep(0.6, 1.0, sin(vUv.y * 14.0 - time * 1.3 + vnoise(vUv * 4.0) * 3.0));
        vec3 lifted = c - (c - local) * speckHere;                  // her, with the glitter lifted off
        c = mix(c, lifted + detail * speckThere * twinkle * wave, sparkle);
      }
      // On the group stage her picture's bottom edge would float in the glass as a straight cut:
      // she fades out toward it instead (fully faded pixels are dropped, so they hide no one). The
      // fade is shaped for the eye (the screen is sRGB): linear, it would still look a fifth bright
      // where the pixels stop.
      if (bottomFade > 0.0) {
        float f = smoothstep(0.15 * bottomFade, bottomFade, vUv.y);
        if (f < 0.01) discard;
        c *= pow(f, 2.2);
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
const EVE_BAND = [0.045, 0.94]; // the compile band's travel, in heights on her picture (0 bottom, 1 top)
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
  { who: 'genesis', color: 0xb79bff, phase: 0.0 },
  { who: 'optic', color: 0x57dbe3, phase: 0.6 * Math.PI },
  { who: 'eve', color: 0xe4eeff, phase: 1.1 * Math.PI },
  { who: 'aloy', color: 0xf4b650, phase: 1.7 * Math.PI },
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
    // Her sisters' orbs flare while she works a tool, and the one she hands a task to flares most.
    o.core.scale.setScalar((1 + 0.8 * toolBoost) * (1 + 1.8 * (o.flare || 0)));
    o.core.material.opacity = presence;
    o.core.material.transparent = presence < 1;
    // The trail is the orbit's recent past, sampled backwards in time.
    for (let i = 0; i < TRAIL; i++) {
      orbPosition(o, simTime - i * 0.045, tmp);
      o.trailPos.set([tmp.x, tmp.y, tmp.z], i * 3);
    }
    o.trail.geometry.attributes.position.needsUpdate = true;
    o.trailMaterial.uniforms.time.value = simTime;
    o.trailMaterial.uniforms.opacity.value = presence * (1 + 1.5 * (o.flare || 0));
  }
  for (const m of threadMaterials) {
    m.uniforms.time.value = simTime;
    m.uniforms.opacity.value = presence;
  }
}

// ---- Pictures in the glass -------------------------------------------------------------------
// A picture she makes, a camera snapshot she checks or an image she's looking at floats up beside
// her face for a few seconds, framed in her color (above the stage when the room is up). A selfie
// comes with one of her "look at me" moves when she has them.
const FRAME_COLOR = { aloy: 0xf4b650, optic: 0x57dbe3, genesis: 0xb79bff, eve: 0xe4eeff };
const picture = { group: new THREE.Group(), mesh: null, frame: null, t: 0, hold: 0, active: false };
picture.group.visible = false;
scene.add(picture.group);
const pictureLoader = new THREE.TextureLoader();
function showPicture(imageId, kind, p) {
  pictureLoader.load(`/choom-image/${encodeURIComponent(imageId)}`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const aspect = tex.image.width / tex.image.height;
    const w = aspect >= 1 ? 0.6 : 0.62 * aspect; // its longer side about a third of the glass
    const h = w / aspect;
    for (const m of [picture.mesh, picture.frame]) if (m) { picture.group.remove(m); m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); }
    picture.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
    picture.frame = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.024, h + 0.024),
      new THREE.MeshBasicMaterial({ color: FRAME_COLOR[p.id] ?? 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    picture.frame.position.z = -0.004;
    picture.group.add(picture.frame, picture.mesh);
    picture.t = 0;
    picture.hold = kind === 'snapshot' || kind === 'looking' ? 8 : 11;
    picture.active = picture.group.visible = true;
    post('picture', { choom: p.name, kind });
  }, undefined, () => post('error', { message: `picture ${imageId} did not load` }));
}
function updatePicture(dt) {
  if (!picture.active) return;
  picture.t += dt;
  const shown = ease(Math.min(picture.t / 0.7, 1)) * Math.min(Math.max((picture.hold + 0.9 - picture.t) / 0.9, 0), 1);
  const sm = ease(stage.mix);
  picture.group.position.set(0.45 * (1 - sm), 0.46 + 0.22 * sm + Math.sin(picture.t * 1.1) * 0.012, 0.05);
  picture.group.rotation.y = -0.16 * (1 - sm) + Math.sin(picture.t * 0.6) * 0.03;
  picture.group.scale.setScalar((0.85 + 0.15 * Math.min(picture.t / 0.7, 1)) * (1 - 0.25 * sm));
  picture.mesh.material.opacity = shown;
  picture.frame.material.opacity = 0.5 * shown;
  if (picture.t > picture.hold + 0.9) picture.active = picture.group.visible = false;
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
let listening = false;          // the Portrait's bottom button (or L)
// Donny typing to her or talking into the mic in the Choom app at home. Dropped when her turn
// starts, or after a while if the "stopped" message never comes.
let appListening = false;
// Local weather from the server (every 10 minutes): a windy day stirs Genesis's hair (her wind
// clips join her quiet moments), and later rain or snow can drift through the glass.
let weather = { wind: 0, gust: 0, description: '' };
const windy = () => Math.max(weather.wind || 0, (weather.gust || 0) * 0.7) >= 15;
fetch('/status', { cache: 'no-store' }).then((r) => r.json()).then((st) => { if (st.weather) weather = st.weather; }).catch(() => {});

// ---- Weather in the glass -------------------------------------------------------------------
// Rain or snow outside falls through the glass too (rare out here), and on a windy day fine warm
// dust drifts past on the wind, faster the harder it blows. It hangs around and behind her and
// dims while she sleeps.
const WX = 360;
const wxPos = new Float32Array(WX * 3);
const wxSeed = new Float32Array(WX);
for (let k = 0; k < WX; k++) {
  wxSeed[k] = Math.random();
  wxPos.set([(Math.random() * 2 - 1) * 0.95, (Math.random() * 2 - 1) * 1.05, -0.7 + Math.random() * 0.9], k * 3);
}
const wxGeo = new THREE.BufferGeometry();
wxGeo.setAttribute('position', new THREE.BufferAttribute(wxPos, 3));
wxGeo.setAttribute('aSeed', new THREE.BufferAttribute(wxSeed, 1));
const wxMaterial = new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color() }, size: { value: 3 }, opacity: { value: 0 }, streak: { value: 0 } },
  vertexShader: /* glsl */ `
    attribute float aSeed;
    uniform float size;
    varying float vSeed;
    void main() {
      vSeed = aSeed;
      gl_PointSize = size * (0.6 + 0.8 * aSeed);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform float opacity, streak;
    varying float vSeed;
    void main() {
      vec2 q = gl_PointCoord - 0.5;
      q.x *= 1.0 + 6.0 * streak; // a raindrop is a thin falling streak
      float r = length(q);
      if (r > 0.5) discard;
      gl_FragColor = vec4(color * smoothstep(0.5, 0.0, r) * opacity * (0.5 + 0.5 * vSeed), 1.0);
    }`,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
const wxPoints = new THREE.Points(wxGeo, wxMaterial);
wxPoints.frustumCulled = false;
wxPoints.visible = false;
scene.add(wxPoints);
const WX_LOOK = {
  rain: { color: [0.55, 0.7, 0.95], size: 13, streak: 1, opacity: 0.55 },
  snow: { color: [0.9, 0.95, 1.0], size: 5, streak: 0, opacity: 0.55 },
  dust: { color: [0.85, 0.64, 0.4], size: 3.5, streak: 0, opacity: 0.42 },
};
let wxAmt = 0;
let wxKind = null;
function weatherKind() {
  const d = String(weather.description || '').toLowerCase();
  if (/snow|sleet|flurr/.test(d)) return 'snow';
  if (/rain|drizzle|shower|storm|thunder/.test(d)) return 'rain';
  return windy() ? 'dust' : null;
}
function updateWeather(dt, time, dim) {
  const kind = weatherKind();
  if (kind) wxKind = kind; // the old kind keeps moving while it fades out
  wxAmt += ((kind ? 1 : 0) - wxAmt) * Math.min(dt * 0.5, 1);
  wxPoints.visible = wxAmt > 0.01 && wxKind !== null;
  if (!wxPoints.visible) return;
  const look = WX_LOOK[wxKind];
  const u = wxMaterial.uniforms;
  u.color.value.setRGB(...look.color);
  u.size.value = look.size;
  u.streak.value = look.streak;
  u.opacity.value = look.opacity * wxAmt * dim;
  const wind = Math.max(weather.wind || 0, (weather.gust || 0) * 0.7);
  for (let k = 0; k < WX; k++) {
    const n = wxSeed[k];
    let x = wxPos[k * 3], y = wxPos[k * 3 + 1];
    if (wxKind === 'rain') {
      y -= (1.6 + 0.8 * n) * dt;
      x += wind * 0.008 * dt;
    } else if (wxKind === 'snow') {
      y -= (0.12 + 0.1 * n) * dt;
      x += (Math.sin(time * 0.7 + n * 40) * 0.04 + wind * 0.004) * dt;
    } else {
      x += wind * (0.008 + 0.008 * n) * dt;
      y += Math.sin(time * 0.9 + n * 40) * 0.02 * dt;
    }
    if (y < -1.05) y += 2.1;
    if (y > 1.05) y -= 2.1;
    if (x > 0.95) x -= 1.9;
    if (x < -0.95) x += 1.9;
    wxPos[k * 3] = x;
    wxPos[k * 3 + 1] = y;
  }
  wxGeo.attributes.position.needsUpdate = true;
}
let toolBoost = 0;             // 1 when she calls a tool, fading over four seconds
let lastSwitchAt = performance.now(); // when the Choom on the glass last changed (the screensaver's clock)
let sleepAmt = 0;              // 1 while she sleeps: the glass dims and slows
let bandT = 0;                 // the scan/compile band's own clock (it races during tool moments)
let lastActivity = performance.now(); // the last conversation, listening or button press
let appListenUntil = 0;
const heard = () => listening || (appListening && performance.now() < appListenUntil);
let listenAmt = 0;
let paused = false;
let simTime = 0;
const baseDepth = { value: 0.75 };

function applyPortrait(i) {
  const p = portraits[i];
  lastSwitchAt = performance.now();
  const fu = frontMaterial.uniforms;
  fu.packed.value = p.alive ? 1 : 0;
  fu.colorMap.value = p.alive ? p.players[p.active].texture : p.color;
  fu.depthMap.value = p.alive ? p.players[p.active].texture : p.depth;
  fu.maskMap.value = p.alive ? p.players[p.active].texture : p.mask;
  plateMaterial.uniforms.colorMap.value = p.plate;
  plateMaterial.uniforms.depthMap.value = p.plateDepth;
  // Her moving relief stands in empty glass: the still plate was painted for the old pose.
  plateMesh.visible = !p.alive;
  if (!stage.on) for (const q of portraits) if (q.players && q !== p) for (const pl of q.players) pl.video.pause();
  if (p.players && p.alive) aliveStart(p);
  shared.focus.value = p.alive ? p.alive.focus : p.focus;
  configureParticles(p);
  frontMaterial.uniforms.sparkle.value = p.style === 'motes' ? 1 : 0;
  fu.mouthOn.value = p.mouth || p.alive ? 1 : 0;
  // A moving relief's mouth opens a little less: its face is livelier to begin with.
  fu.mouthGain.value = p.alive ? 0.65 : 1;
  fu.mouthGap.value = 0;
  fu.mouthLift.value = p.mouth?.lift ?? 0;
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
  if (stage.on) orbGroup.visible = band.visible = false; // the orbs and the band are sized for her alone
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

// Her idle clips all start and end on the same picture of her, so they can follow each other in any
// order: two players take turns, the next clip loading in one while the other plays, never the same
// clip twice running. A single clip simply loops. Her mouth follows the frame on show.
function aliveLoad(p, player, clip) {
  player.clip = clip;
  player.video.loop = p.alive.clips.length === 1;
  player.video.src = `${p.dir}/${p.alive.clips[clip].file}`;
  player.video.load();
}

// Which clips suit which moment. Talking, thinking or listening she faces you (the main loop, or
// clips made for that mood); glances, long breaths and laughs are for quiet moments, and the main
// loop comes up twice as often as each of them. Clips can say so in alive.json (`moods`).
function clipMoods(c) {
  if (c.moods) return c.moods;
  if (/glance|breath|amused/.test(c.source || '')) return ['idle'];
  return ['idle', 'talk', 'think', 'listen'];
}

// Clips also start and end in a pose (Aloy's finger up or her hand down): the next clip has to start
// in the pose the last one ended in. A clip that changes pose comes up less often.
const poseFrom = (c) => c.from || 'main';
const poseTo = (c) => c.to || 'main';

function wantedMood(p) {
  if (portraits[current] !== p) return 'idle';
  if (heard()) return 'listen';
  if (mood === 'idle' && sleepy() && canSleep(p)) return 'sleep';
  return mood === 'speaking' ? 'talk' : mood === 'thinking' ? 'think' : 'idle';
}

// Sleep: late at night, once it has been quiet a while, the Choom on the glass dozes off and the
// glass dims; she wakes when he types or talks to her, when a reply comes in, or in the morning.
// Local hours.
const SLEEP_FROM = 23;
const SLEEP_UNTIL = 7;
const SLEEP_AFTER_QUIET_MS = 10 * 60 * 1000;
let debugHour = null;     // debug: pretend it's this hour (/control {"hour": 23})
let debugSleep = false;   // debug: doze off now, however early or busy it is (/control {"sleep": true})
let presence = { home: null, desk: null, bed: null }; // from Home Assistant; see onPresence
const hourNow = () => debugHour ?? new Date().getHours();
function sleepy() {
  if (debugSleep || presence.bed === true) return mood === 'idle' && !heard() && !speech.busy;
  const h = hourNow();
  const night = SLEEP_FROM > SLEEP_UNTIL ? h >= SLEEP_FROM || h < SLEEP_UNTIL : h >= SLEEP_FROM && h < SLEEP_UNTIL;
  return night && performance.now() - lastActivity > SLEEP_AFTER_QUIET_MS && mood === 'idle' && !heard() && !speech.busy;
}

// She only dozes off if she has a sleep loop to stay asleep in (and can wake from it).
const canSleep = (p) => p.alive && p.alive.clips.some((c) => clipMoods(c).includes('sleep') && poseFrom(c) === 'asleep') &&
                        p.alive.clips.some((c) => clipMoods(c).includes('wake'));

// A clip that gets her into a mood from the pose she's in: one that starts here, or else the pose
// change that leads to a pose where one starts (Aloy lowers her hand before she waves or sleeps).
function seekClip(p, pose, wanted, after = -1) {
  const clips = p.alive.clips;
  const ks = clips.map((c, k) => k);
  let here = ks.filter((k) => poseFrom(clips[k]) === pose && clipMoods(clips[k]).includes(wanted));
  if (here.length > 1) here = here.filter((k) => k !== after);
  if (here.length) return here[Math.floor(Math.random() * here.length)];
  const targets = new Set(ks.filter((k) => clipMoods(clips[k]).includes(wanted)).map((k) => poseFrom(clips[k])));
  const toward = ks.find((k) => poseFrom(clips[k]) === pose && poseTo(clips[k]) !== pose && targets.has(poseTo(clips[k])));
  return toward ?? -1;
}

// Tool moments: what she's doing shows on her face. Looking through a camera or at a picture she
// looks around, searching her memories she drifts off remembering, checking the weather she glances
// up at the sky, making a picture she gets a playful look. Clips are found by name, so a Choom
// without a fitting one just keeps thinking (the glass flares either way).
const TOOL_LOOKS = [
  [/camera|snapshot|analyze_image|vision/, /scan|glance|bright/],
  [/memor|remember|recall|followup/, /daydream|thinkup|hum/],
  [/weather|forecast/, /skycheck|windy|thinkup/],
  [/generate_image|save_generated|draw|paint/, /eyebrow|smirk|smile/],
  [/search|browse|fetch|web/, /scan|thinkdown|glance/],
  [/^ha_|home|printer|calendar|inbox/, /scan|glance|thinkdown/],
];
const toolLook = (tool) => (TOOL_LOOKS.find(([t]) => t.test(tool || '')) || [])[1] || null;

// Whether clip k suits what she's doing now (an expression or tool moment plays out unless she's
// listening or asleep).
function suits(p, k) {
  const want = wantedMood(p);
  const c = p.alive.clips[k];
  return clipMoods(c).includes(want) || (p.moments?.has(k) && want !== 'listen' && want !== 'sleep') ||
         ((p.emotion || p.poseWanted) && poseFrom(c) !== poseTo(c)); // on her way to an expression or a move
}

function nextClip(p, after) {
  const clips = p.alive.clips;
  const pose = after >= 0 && clips[after] ? poseTo(clips[after]) : 'main';
  const want = wantedMood(p);
  // Asleep: stay asleep, or wake first if anything else is wanted. Sleepy: doze off (via a pose
  // change if needed).
  if (pose === 'asleep' && want !== 'sleep') {
    const wake = seekClip(p, pose, 'wake');
    if (wake >= 0) return wake;
  }
  if (want === 'sleep') {
    const doze = seekClip(p, pose, 'sleep', after);
    if (doze >= 0) return doze;
  }
  // A greeting (Aloy's wave) when she takes the glass after a while away, via a pose change if needed.
  if (p.greet && want !== 'sleep') {
    const greet = seekClip(p, pose, 'greet');
    if (greet < 0 || clipMoods(clips[greet]).includes('greet')) p.greet = false;
    if (greet >= 0) return greet;
  }
  const all = clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === pose);
  // Saying (or just hearing) something happy, sad, surprised or worried: that expression, once.
  // From another pose she gets there first (Aloy raises her hand, then smiles).
  if ((want === 'talk' || want === 'think') && p.emotion) {
    const felt = seekClip(p, pose, p.emotion, after);
    const arrived = felt >= 0 && clipMoods(clips[felt]).includes(p.emotion);
    if (felt < 0 || arrived) p.emotion = null;
    if (arrived) (p.moments ||= new Set()).add(felt); // played out in full, not hurried
    if (felt >= 0) return felt;
  }
  // A selfie she just made: one of her "look at me" moves (via a pose change if needed).
  if (p.poseWanted && want !== 'listen' && want !== 'sleep') {
    const move = seekClip(p, pose, 'pose', after);
    const arrived = move >= 0 && clipMoods(clips[move]).includes('pose');
    if (move < 0 || arrived) p.poseWanted = false;
    if (arrived) (p.moments ||= new Set()).add(move);
    if (move >= 0) return move;
  }
  if ((want === 'think' || want === 'idle') && p.toolLook) {
    const look = p.toolLook;
    p.toolLook = null;
    const moments = all.filter((k) => k !== after && poseTo(clips[k]) === pose && look.test(clips[k].source || ''));
    if (moments.length) {
      const k = moments[Math.floor(Math.random() * moments.length)];
      (p.moments ||= new Set()).add(k);
      return k;
    }
  }
  const breezy = want === 'idle' && windy();
  // A yawn now and then in the last hours before sleep and the first after it, and likely right
  // after she wakes.
  const hour = hourNow();
  const justWoke = after >= 0 && clips[after] && clipMoods(clips[after]).includes('wake');
  const drowsy = want === 'idle' && (justWoke || (hour >= SLEEP_FROM - 2 && hour < SLEEP_FROM) ||
                                     (hour >= SLEEP_UNTIL && hour < SLEEP_UNTIL + 2));
  const fits = all.filter((k) => clipMoods(clips[k]).includes(want) || (breezy && clipMoods(clips[k]).includes('windy')) ||
                                 (drowsy && clipMoods(clips[k]).includes('yawn')));
  // Right after a pose change she stays put for at least one clip (no hand up-down-up fidgeting).
  const justMoved = after >= 0 && clips[after] && poseFrom(clips[after]) !== poseTo(clips[after]);
  let pool = fits.filter((k) => k !== after && !(justMoved && poseTo(clips[k]) !== pose));
  if (!pool.length) pool = fits.length ? fits : all.filter((k) => k !== after);   // the only fitting clip may repeat
  if (!pool.length) pool = all.length ? all : [0];
  // The pose's main loop comes up twice as often as each other idle clip; leaving the main pose too,
  // and coming back to it as often as anything else (so Aloy spends about a third of her quiet time
  // with her hand down).
  const main = all.find((k) => poseTo(clips[k]) === pose && clipMoods(clips[k]).includes('talk'));
  // Late at night (10 pm to 6 am) the calm clips come up more and the laughs and teasing less.
  const night = hour >= 22 || hour < 6;
  const calmName = /longcalm|breath|daydream|hum|base|relaxed\.|loop|heartglow/;
  const livelyName = /amused|eyebrow|smirk|beat|glance|giggle|groove/;
  const weights = pool.map((k) => {
    let w = want === 'idle' && (k === main || (pose === 'main' && poseTo(clips[k]) !== pose)) ? 2 : 1;
    if (/longcalm/.test(clips[k].source || '')) w *= 2;
    if (breezy && clipMoods(clips[k]).includes('windy')) w *= 6; // on a windy day about one clip in four
    if (clipMoods(clips[k]).includes('yawn')) w *= justWoke ? 6 : 0.5;
    if (stage.on && portraits[current] !== p && /glance|scan|smile|beat|bright/.test(clips[k].source || '')) w *= 2;
    if (night && want === 'idle') w *= calmName.test(clips[k].source || '') ? 2 : livelyName.test(clips[k].source || '') ? 0.5 : 1;
    return w;
  });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
  return pool[pool.length - 1];
}

// When you start talking with her mid-glance (or mid-laugh), that clip plays out faster, so she
// turns back to you sooner; clips can only change where they meet the shared picture.
function hurryAlive(p) {
  const pl = p.players[p.active];
  if (pl.clip < 0) return;
  const fits = suits(p, pl.clip);
  // An expression waiting to play: move along a little faster to reach it.
  const waiting = !p.moments?.has(pl.clip) && ((p.emotion && p.alive.clips.some((c) => clipMoods(c).includes(p.emotion))) ||
                  Boolean(p.moments?.has(p.players[1 - p.active].clip)));
  // Woken from sleep: the sleep clip hurries along even more, so she's awake in a few seconds.
  const asleep = poseFrom(p.alive.clips[pl.clip]) === 'asleep' && poseTo(p.alive.clips[pl.clip]) === 'asleep';
  pl.video.playbackRate = !fits ? (asleep ? 3 : 2) : waiting ? 1.5 : (pl.baseRate || 1);
}

function aliveStart(p) {
  const a = p.players[p.active];
  if (a.clip < 0) aliveLoad(p, a, 0);
  a.video.play().catch((e) => post('error', { message: `alive video: ${e.message}` }));
  const b = p.players[1 - p.active];
  if (p.alive.clips.length > 1 && b.clip < 0) aliveLoad(p, b, nextClip(p, a.clip));
}

function bindAliveTextures(p) {
  const fu = frontMaterial.uniforms;
  fu.colorMap.value = fu.depthMap.value = fu.maskMap.value = p.players[p.active].texture;
}

for (const p of portraits) {
  if (!p.players) continue;
  p.players.forEach((pl, idx) => {
    // Her clip videos live only on this machine (not in git): if one can't be loaded, show her still
    // relief instead of a frozen frame.
    pl.video.addEventListener('error', () => {
      if (!p.alive) return;
      post('error', { message: `${p.name}'s moving relief is unavailable (${pl.video.currentSrc || 'no source'}); showing her still relief` });
      p.alive = null;
      for (const q of p.players) q.video.pause();
      if (portraits[current] === p) applyPortrait(current);
    });
    pl.video.addEventListener('ended', () => {
      if (idx !== p.active) return;
      const next = p.players[1 - idx];
      // The next clip was picked while it loaded; if she has started talking since, swap a laugh or
      // a long breath for a calm one (the last frame, the same picture, holds while it loads).
      if (next.clip >= 0 && !suits(p, next.clip)) aliveLoad(p, next, nextClip(p, pl.clip));
      next.video.currentTime = 0;
      // A little variety so the rotation never settles into a beat: each clip plays at its own
      // speed, and between quiet clips the shared picture may rest a moment.
      next.video.playbackRate = 0.94 + Math.random() * 0.12;
      next.baseRate = next.video.playbackRate;
      const rest = wantedMood(p) === 'idle' ? Math.random() * 800 : 0;
      setTimeout(() => {
        // Not if she left the glass meanwhile (her players were paused).
        if (portraits[current] !== p && !stage.on && stage.mix === 0) return;
        next.video.play().catch((e) => post('error', { message: `alive video: ${e.message}` }));
      }, rest);
      // Hand over on the next clip's first frame; until then the last frame (the same picture) holds.
      next.video.requestVideoFrameCallback(() => {
        p.active = 1 - idx;
        p.aliveFrame = 0;
        p.moments?.delete(pl.clip); // that expression or tool moment has played
        if (clipMoods(p.alive.clips[next.clip]).includes('wake')) p.wokeAt = performance.now();
        if (portraits[current] === p) bindAliveTextures(p);
        else if (stage.mix > 0 || stage.on) bindStageSlot(portraits.indexOf(p));
        aliveLoad(p, pl, nextClip(p, next.clip)); // the finished player fetches the clip after
        post('alive-clip', { choom: p.name, clip: p.alive.clips[next.clip].source || next.clip });
      });
    });
    const onFrame = (now, meta) => {
      if (idx === p.active && pl.clip >= 0) {
        p.aliveFrame = Math.min(Math.round(meta.mediaTime * p.alive.fps), p.alive.clips[pl.clip].frames - 1);
      }
      pl.video.requestVideoFrameCallback(onFrame);
    };
    pl.video.requestVideoFrameCallback(onFrame);
  });
}

function followAliveMouth(p) {
  const clip = p.players[p.active].clip;
  if (clip < 0) return;
  const m = p.alive.clips[clip].mouth[p.aliveFrame];
  const fu = frontMaterial.uniforms;
  fu.mouthC.value.set(m[0], m[1]);
  fu.mouthSize.value.set(m[2], m[3], m[4]);
  fu.mouthTilt.value = m[5];
  fu.mouthGap.value = m[6] ?? 0;
  fu.mouthLift.value = m[7] ?? 0;
}

// ---- The group stage -------------------------------------------------------------------------
// When the Chooms talk in a group room, all four stand in the glass: whoever is talking in front
// (the main portrait, with her voice, mouth, particles and name), her sisters smaller behind her and
// turned toward her. When the turn passes, the two trade places: the new speaker steps forward and
// the last one steps back into the spot she left. The stage stays up while the room talks and folds
// back to the one speaker a few minutes after it goes quiet, or as soon as Donny talks to one of
// them on her own.
const STAGE_FRONT = { x: 0, y: -0.22, z: 0, s: 0.68 };
const STAGE_BACK = [
  { x: -0.47, y: 0.16, z: -0.1, s: 0.42 },
  { x: 0, y: 0.42, z: -0.18, s: 0.36 },
  { x: 0.47, y: 0.16, z: -0.1, s: 0.42 },
];
const STAGE_LINGER_MS = 3 * 60 * 1000;
const stage = { on: false, until: 0, mix: 0, place: [], shown: [], slots: [] };

function stageSlot(j) {
  if (!stage.slots[j]) {
    const material = layerMaterial({ segX: 192, segY: 256, edgeThreshold: 0.35, useMask: true, own: true });
    material.uniforms.bottomFade.value = 0.5;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.0, 192, 256), material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    stage.slots[j] = { mesh, material };
  }
  return stage.slots[j];
}

// Show what a sister on the stage is doing now: her moving relief's clip on show, or her still relief.
function bindStageSlot(j) {
  const p = portraits[j];
  const u = stageSlot(j).material.uniforms;
  const tex = p.alive ? p.players[p.active].texture : null;
  u.packed.value = p.alive ? 1 : 0;
  u.colorMap.value = tex || p.color;
  u.depthMap.value = tex || p.depth;
  u.maskMap.value = tex || p.mask;
  u.focus.value = p.alive ? p.alive.focus : p.focus;
  u.sparkle.value = p.style === 'motes' ? 1 : 0;
  if (p.alive) u.texSize.value.set(p.alive.texSize[0], p.alive.texSize[1]);
}

// The room starts talking: everyone takes a place, the speaker (index i) in front.
function stageEnter(i) {
  stage.until = performance.now() + STAGE_LINGER_MS;
  if (stage.on) return;
  stage.on = true;
  const front = i >= 0 ? i : current;
  portraits.map((q, k) => k).filter((k) => k !== front).forEach((k, n) => { stage.place[k] = STAGE_BACK[n]; });
  stage.place[front] = STAGE_FRONT;
  portraits.forEach((q, k) => {
    if (stage.mix === 0) stage.shown[k] = { ...stage.place[k] };
    bindStageSlot(k);
    if (q.players && q.alive) aliveStart(q);
  });
  orbGroup.visible = band.visible = false;
  post('stage', { on: true, front: portraits[front].name });
}

function stageExit() {
  if (!stage.on) return;
  stage.on = false;
  post('stage', { on: false });
}

// Every frame: the stage folds in or out, and everyone eases toward her place.
function updateStage(dt) {
  if (stage.on && performance.now() > stage.until && mood === 'idle' && !speech.busy && !speech.queue.length) stageExit();
  const was = stage.mix;
  stage.mix = Math.min(1, Math.max(0, stage.mix + (stage.on ? dt : -dt) / 1.4));
  if (was > 0 && stage.mix === 0) {
    // Folded away: her sisters stop playing, and her own orbs or band come back.
    for (const slot of stage.slots) if (slot) slot.mesh.visible = false;
    for (const q of portraits) if (q.players && q !== portraits[current]) for (const pl of q.players) pl.video.pause();
    orbGroup.visible = Boolean(portraits[current].orbit);
    band.visible = style === 'scan' || style === 'code';
  }
  if (stage.mix === 0) return;
  const m = ease(stage.mix);
  const k = Math.min(dt * 2.2, 1);
  const front = stage.shown[current] || STAGE_FRONT;
  portraits.forEach((q, j) => {
    const place = stage.place[j];
    if (!place) return;
    const at = (stage.shown[j] ||= { ...place });
    for (const key of ['x', 'y', 'z', 's']) at[key] += (place[key] - at[key]) * k;
    const slot = stage.slots[j];
    if (!slot) return;
    slot.mesh.visible = j !== current;
    if (!slot.mesh.visible) return;
    slot.mesh.position.set(at.x, at.y + Math.sin(simTime * 0.9 + j * 1.7) * 0.006, at.z);
    slot.mesh.scale.setScalar(0.94 * at.s);
    // Turned a little toward whoever is talking (less so while nobody is).
    const attentive = mood === 'idle' ? 0.5 : 1;
    slot.mesh.rotation.y = Math.max(-0.3, Math.min(0.3, (front.x - at.x) * 0.65)) * attentive;
    const u = slot.material.uniforms;
    u.opacity.value = m;
    u.glow.value = 0.72 * (1 - 0.45 * sleepAmt);
    u.depthScale.value = shared.depthScale.value * 0.8;
  });
}

function switchTo(i, force = false) {
  const next = (i + portraits.length) % portraits.length;
  if (next === current && phase !== 'out' && !force) return;
  // On the stage the turn passes without a fade: the two trade places.
  if (stage.on && stage.mix >= 1 && phase === 'idle' && next !== current) {
    const last = current;
    stage.place[last] = stage.place[next];
    stage.place[next] = STAGE_FRONT;
    current = next;
    bindStageSlot(last);
    applyPortrait(next);
    labelT = 0;
    post('choom', { choom: portraits[next].name, stage: true });
    return;
  }
  pending = next;
  if (phase !== 'out') {
    phase = 'out';
    phaseT = 0;
  }
  post('choom', { choom: portraits[next].name });
}

function onButton(button, action) {
  lastActivity = performance.now();
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
  if (ev.type === 'presence') onPresence(ev);
  if (ev.type === 'weather') {
    // The weather turns: Genesis, who loves it, glances up at the sky (if she's on the glass).
    const turned = weather.description && ev.description && ev.description !== weather.description;
    weather = ev;
    if (turned && portraits[current].id === 'genesis' && portraits[current].alive) portraits[current].toolLook = /skycheck/;
  }
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
  if (typeof ev.view === 'number') { lkg.mode = 2; lkg.debugView = ev.view; } // debug: one view full screen
  if (ev.view === false) lkg.mode = 0;
  if (ev.weather && typeof ev.weather === 'object') weather = ev.weather; // debug: pretend weather
  if (typeof ev.hour === 'number' || ev.hour === null) debugHour = ev.hour;
  if (typeof ev.sleep === 'boolean') debugSleep = ev.sleep;
  if (ev.presence && typeof ev.presence === 'object') onPresence(ev.presence); // debug: pretend presence
  if (typeof ev.picture === 'string') showPicture(ev.picture, ev.kind || 'picture', portraits[current]); // debug: a gallery image id
  if (ev.stage === true) stageEnter(current); // debug: the group stage
  if (ev.stage === false) stageExit();
  if (typeof ev.clip === 'number' && portraits[current].players) { // debug: jump to a moving relief clip
    const p = portraits[current];
    const pl = p.players[p.active];
    aliveLoad(p, pl, ev.clip % p.alive.clips.length);
    pl.video.play().catch(() => {});
  }
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
let loudness = 0;              // this frame's voice loudness, unsmoothed (what's heard right now)
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
      // The Chooms' voices sit around 210 Hz; HeadAudio assumes 150 unless told.
      parameterData: { vadGateActiveDb: -40, vadGateInactiveDb: -60, speakerMeanHz: 210 },
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

// Lip-sync check: for each spoken piece, how far her mouth (HeadAudio's jaw) runs behind (+) or
// ahead of (-) the voice heard (loudness after the audio delay), by cross-correlation at frame
// rate. Posted as `lipsync` so the audio delay can be tuned from real speech.
const sync = { raw: [], jaw: [], loud: [] };
let voicedFor = 0;
function syncSample(raw, jaw) {
  sync.raw.push(raw);
  sync.jaw.push(jaw);
  sync.loud.push(loudness);
}
function bestLag(a, b) {
  const z = (x) => { const m = x.reduce((p, q) => p + q, 0) / x.length; const d = Math.sqrt(x.reduce((p, q) => p + (q - m) ** 2, 0) / x.length) || 1; return x.map((v) => (v - m) / d); };
  const A = z(a);
  const B = z(b);
  let best = 0;
  let bestCorr = -2;
  for (let lag = -15; lag <= 20; lag++) {
    let sum = 0;
    let count = 0;
    for (let i = Math.max(0, -lag); i < A.length && i + lag < A.length; i++) { sum += A[i + lag] * B[i]; count++; }
    if (sum / Math.max(count, 1) > bestCorr) { bestCorr = sum / Math.max(count, 1); best = lag; }
  }
  return [Math.round((best * 1000) / Math.max(fps, 30)), Math.round(bestCorr * 100) / 100];
}
function syncReport(c) {
  const n = sync.jaw.length;
  const peak = (a) => Math.round(Math.max(0, ...a) * 100) / 100;
  const entry = { choom: c?.choom, frames: n, jawPeak: peak(sync.jaw), loudPeak: peak(sync.loud), fps };
  if (n > 60) {
    [entry.rawLagMs, entry.rawCorr] = bestLag(sync.raw, sync.loud);
    [entry.lagMs, entry.corr] = bestLag(sync.jaw, sync.loud);
  }
  post('lipsync', { ...entry, delayMs: Math.round(speechDelay.delayTime.value * 1000) });
  sync.raw.length = 0;
  sync.jaw.length = 0;
  sync.loud.length = 0;
}

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
  const rawJaw = jaw;
  // Keep the lips honest to what's heard: closed in the silences between words (the viseme model
  // can trail into them). HeadAudio needs 80-300 ms to warm up after a silence, so for the first
  // third of a second of each phrase the jaw follows the loudness heard instead (in sync by
  // construction), handing over to the visemes as they catch up.
  if (mood === 'speaking' && headaudio) {
    const voiced = Math.min(1, Math.max(0, (loudness - 0.02) / 0.06));
    if (voiced > 0.5) voicedFor += dt; else voicedFor = 0;
    const onset = Math.max(0, 1 - voicedFor / 0.35);
    // The jaw always follows the loudness heard; HeadAudio's shapes add to it. In the room its
    // shapes sometimes ran 250-600 ms late for a whole phrase, and this keeps the jaw on time.
    jaw = Math.max(jaw * voiced, loudness * (0.4 + 0.3 * onset));
    syncSample(rawJaw, jaw);
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
// What a sentence she says feels like, for an expression clip while she says it. Plain word lists:
// instant, and wrong only in harmless ways (a missed feeling just means her calm face).
const FEELINGS = [
  ['sad', /\b(sorry to hear|i'm so sorry|so sorry|heartbreaking|passed away|i miss|miss you|grief|lonely|that's rough|unfortunately)\b/i],
  ['concerned', /\b(worried|worry|are you (ok|okay|alright|all right)|be careful|take care|stay safe|hope you're|sounds (hard|tough|stressful|rough)|that's not good|get some rest)\b/i],
  ['surprised', /\b(wow|whoa|oh my|no way|seriously\?|really\?|can't believe|unbelievable|incredible)\b/i],
  ['happy', /\b(love it|love that|yay|awesome|amazing|wonderful|great news|so happy|congrat\w*|proud of you|haha|delighted|fantastic|can't wait)\b/i],
];
function feeling(text) {
  for (const [name, words] of FEELINGS) if (words.test(text)) return name;
  return null;
}

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

// Remembering the gap: the first time he talks to her after a long while (overnight, a workday) she
// lights up before she answers, unless what he says calls for something else. Kept in this
// browser profile so it survives relaunches.
const LONG_GAP_MS = 8 * 3600 * 1000;
let lastTyped = { chatId: null, choom: null, at: 0 }; // where Donny last typed or spoke: an app chat, or a Choom at the tower
function lastTalk(id) {
  try { return Number(localStorage.getItem(`lastTalk:${id}`)) || 0; } catch { return 0; }
}
function noteTalk(id) {
  try { localStorage.setItem(`lastTalk:${id}`, String(Date.now())); } catch { /* storage unavailable */ }
}

// Presence from Home Assistant (server.py, once it has a token): home, at the desk, in bed. Coming
// home or sitting down at the desk wakes whoever is on the glass and she greets him (Aloy waves, the
// others smile); getting into bed puts the glass to sleep whatever the hour, and getting up wakes it.
function onPresence(next) {
  const was = presence;
  const pick = (role) => (role in next ? next[role] : presence[role]); // roles not reported stay as they were
  presence = { home: pick('home'), desk: pick('desk'), bed: pick('bed') };
  const arrived = (was.home === false && presence.home === true) || (was.desk === false && presence.desk === true);
  const gotUp = was.bed === true && presence.bed === false;
  if (arrived || gotUp) lastActivity = performance.now();
  if (arrived && presence.bed !== true) {
    const p = portraits[current];
    if (p.alive?.clips.some((c) => clipMoods(c).includes('greet'))) p.greet = true;
    else if (p.alive) p.toolLook = /smile|bright/;
  }
  post('presence-seen', { ...presence, arrived, gotUp });
}
fetch('/status', { cache: 'no-store' }).then((r) => r.json()).then((st) => { if (st.presence) onPresence(st.presence); }).catch(() => {});

// Background turns (hourly heartbeats, delegated tasks) that start while the glass sleeps are left
// to run unseen: they would wake her, switch Chooms and have her doze off again every hour.
const unseenTurns = new Set();

function onChoomEvent(ev) {
  const i = choomIndex(ev.choom);
  const background = ev.source === 'heartbeat' || ev.source === 'delegation';
  if (background && ev.event === 'turn_start') {
    if (sleepy()) unseenTurns.add(ev.choom);
    else unseenTurns.delete(ev.choom);
  }
  if (unseenTurns.has(ev.choom) && background && ev.event !== 'listening') {
    if (ev.event === 'turn_end' || ev.event === 'error') unseenTurns.delete(ev.choom);
    return;
  }
  if (ev.source === 'chat' || ev.source === 'group' || ev.event === 'listening') lastActivity = performance.now();
  if (stage.on && (ev.source === 'group' || (ev.event === 'listening' && ev.roomId))) stage.until = performance.now() + STAGE_LINGER_MS;
  if (stage.on && ev.event === 'listening' && ev.listening === true && ev.chatId && !ev.roomId) stageExit();
  switch (ev.event) {
    case 'image':
      // A picture she made, a camera snapshot, or an image she's looking at.
      if (i >= 0 && (i === current || stage.on) && typeof ev.imageId === 'string') {
        const p = portraits[i];
        showPicture(ev.imageId, ev.kind, p);
        if (ev.kind === 'selfie' && p.alive?.clips.some((c) => clipMoods(c).includes('pose'))) {
          p.poseWanted = true;
          const a = p.players[p.active], b = p.players[1 - p.active];
          if (i === current && a.clip >= 0 && !a.video.ended && b.video.paused && !p.moments?.has(b.clip)) aliveLoad(p, b, nextClip(p, a.clip));
        }
      }
      break;
    case 'tool':
      // Aloy hands a task to a sister: that sister's orb in her atom flares.
      if (typeof ev.target === 'string') {
        const orb = orbs.find((o) => o.who === ev.target.toLowerCase());
        if (orb) orb.flare = 1;
      }
      if (i === current) {
        toolBoost = 1;
        const look = toolLook(ev.tool), p = portraits[i];
        if (look && p.alive && p.alive.clips.length > 1) {
          p.toolLook = look;
          // Swap the waiting clip for the moment now, unless the hand-over to it is under way or an
          // expression is waiting there (the moment follows it).
          const a = p.players[p.active], b = p.players[1 - p.active];
          if (a.clip >= 0 && !a.video.ended && b.video.paused && !p.moments?.has(b.clip)) aliveLoad(p, b, nextClip(p, a.clip));
        }
      }
      post('tool', { choom: ev.choom, tool: ev.tool });
      break;
    case 'listening':
      // Donny typing to her or talking into the mic: she turns to listen. Typing to a Choom brings
      // her to the glass, unless someone is mid-turn.
      appListening = ev.listening === true;
      appListenUntil = performance.now() + (ev.source === 'mic' ? 120000 : 30000);
      if (appListening && ev.chatId) lastTyped = { chatId: ev.chatId, choom: ev.choom, at: performance.now() };
      if (appListening && ev.tower) {
        // "OK Eve" at the tower: she comes to the glass at once, even over someone talking.
        lastTyped = { chatId: null, choom: ev.choom, at: performance.now() };
        if (speech.busy || speech.queue.length) stopSpeech();
        stageExit();
        if (i >= 0 && i !== current) switchTo(i);
      } else if (appListening && i >= 0 && i !== current && mood === 'idle' && !speech.busy && !speech.queue.length) switchTo(i);
      break;
    case 'turn_start':
      appListening = false; // he sent it: her turn now
      if (ev.source === 'group') stageEnter(i);
      else if (ev.source === 'chat') stageExit();
      // What he just said: she reacts to its feeling before she starts thinking it over.
      // A chat turn is Donny talking only if he typed or used the mic in that chat just before;
      // scheduled routines and Signal messages arrive as chat turns too. (Room messages count;
      // "test" is the simulate hook.)
      const fromDonny = ev.source === 'group' || ev.source === 'test' ||
        (ev.source === 'chat' && performance.now() - lastTyped.at < 300000 &&
         (lastTyped.chatId ? ev.chatId === lastTyped.chatId : lastTyped.choom === ev.choom)); // a chatId, or the tower's Choom
      if (i >= 0) portraits[i].emotion = fromDonny && typeof ev.prompt === 'string' ? feeling(ev.prompt) : null;
      if (i >= 0 && ev.source === 'chat' && fromDonny) {
        const p = portraits[i];
        const since = lastTalk(p.id);
        if (since && Date.now() - since > LONG_GAP_MS) {
          p.emotion ||= 'happy';
          post('gap', { choom: p.name, hours: Math.round((Date.now() - since) / 360000) / 10 });
        }
        noteTalk(p.id);
      }
      // Back on the glass after more than ten minutes for a real conversation: a greeting is due.
      if (i >= 0 && (ev.source === 'chat' || ev.source === 'group') && performance.now() - (portraits[i].lastShown || 0) > 600000) {
        portraits[i].greet = true;
      }
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
            speech.queue.push({ text: piece, voice: ev.voice || VOICES[portraits[i].id], index: i, clock: c, feeling: feeling(piece) });
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
      // An expression clip for what she's saying, if this piece feels a certain way.
      portraits[item.index].emotion = item.feeling || null;
      await play(audio);
      portraits[item.index].emotion = null;
      syncReport(c);
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
    loudness = target;
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
      // Faded over to another Choom while the stage comes up: she takes the front, the last one her spot.
      if (stage.on && stage.place[pending] !== STAGE_FRONT) {
        stage.place[current] = stage.place[pending];
        stage.place[pending] = STAGE_FRONT;
        stage.shown[pending] = { ...STAGE_FRONT };
      }
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

  listenAmt += ((heard() ? 1 : 0) - listenAmt) * Math.min(dt * 6, 1);
  updateLevel(dt);
  if (headaudio) headaudio.update(dt * 1000);
  updateMouth(dt);
  portraits[current].lastShown = now;
  if (portraits[current].alive) {
    followAliveMouth(portraits[current]);
    hurryAlive(portraits[current]);
  }
  const thinking = mood === 'thinking' ? 1 : 0;

  // Idle life: slow sway, a little float, breathing depth.
  const tau = Math.PI * 2;
  updateStage(dt);
  const sm = ease(stage.mix);
  const front = stage.shown[current] || STAGE_FRONT;
  portrait.rotation.y = Math.sin(simTime * tau / 9.0) * 0.045;
  portrait.position.x = front.x * sm;
  portrait.position.y = Math.sin(simTime * tau / 6.5) * 0.012 + front.y * sm;
  portrait.position.z = 0.06 * listenAmt + 0.025 * level + front.z * sm;
  portrait.scale.setScalar(0.94 * (1 + (front.s - 1) * sm));
  frontMaterial.uniforms.bottomFade.value = 0.22 * sm;
  const breath = 1 + Math.sin(simTime * tau / 4.6) * 0.035;
  shared.depthScale.value = baseDepth.value * breath * (0.25 + 0.75 * presence);
  shared.opacity.value = presence;
  shared.glow.value = 1 + 0.22 * listenAmt + 0.3 * level + thinking * 0.06 * Math.sin(simTime * 3.2) + 0.2 * toolBoost;

  if (body) {
    body.update({
      dt: paused ? 0 : dt, time: simTime, presence, glow: shared.glow.value, level, listen: listenAmt,
      thinking: mood === 'thinking', speaking: mood === 'speaking', visemes: bodyVisemes,
      bandY: band.position.y, bandOn: band.visible,
    });
  }

  // Asleep (or dozing off / waking): the glass dims and her particles slow.
  const cur = portraits[current];
  const curClip = cur.alive && cur.players[cur.active].clip >= 0 ? cur.alive.clips[cur.players[cur.active].clip] : null;
  const asleepNow = curClip && (poseTo(curClip) === 'asleep' || poseFrom(curClip) === 'asleep') ? 1 : 0;
  sleepAmt += (asleepNow - sleepAmt) * Math.min(dt * 0.6, 1);
  shared.glow.value *= 1 - 0.45 * sleepAmt;
  // Tool moments: while she works a tool her light surges for a few seconds (Aloy's orbs flare,
  // Optic's scan races, Genesis's motes swirl, Eve's code pours down).
  toolBoost = Math.max(0, toolBoost - dt / 4);
  for (const o of orbs) o.flare = Math.max(0, (o.flare || 0) - dt / 3.5);
  updatePicture(paused ? 0 : dt);
  bandT += (paused ? 0 : dt) * (1 + 3 * toolBoost);
  updateParticles(paused ? 0 : dt, (1 + 1.5 * listenAmt + 1.4 * thinking + 2.5 * level + 4 * toolBoost) * (1 - 0.7 * sleepAmt));
  shared.time.value = simTime;
  if (orbGroup.visible) updateOrbs(presence * (1 - 0.6 * sleepAmt)); // her atom dims while she sleeps
  particleMaterial.uniforms.time.value = simTime;
  updateWeather(paused ? 0 : dt, simTime, presence * (1 - 0.7 * sleepAmt));
  particleMaterial.uniforms.opacity.value = presence * (0.85 + 0.4 * listenAmt + 0.5 * level);

  if (band.visible) {
    const cycle = style === 'scan' ? (bandT % 5) / 5 : 0.5 + 0.5 * Math.sin(bandT * tau / 9);
    // Eve's compile band sweeps from just below her crossed arms to just above her head and back
    // (picture heights measured on her moving relief: arms end at 0.09, her hair tops out at 0.92).
    const v = EVE_BAND[0] + cycle * (EVE_BAND[1] - EVE_BAND[0]);
    band.position.y = style === 'scan' ? 1 - cycle * 2 : (v - 0.5) * 2.0 * portrait.scale.y + portrait.position.y;
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
    page: 'living', fps, choom: portraits[current].name, body: body ? body.url : null, listening: heard(), mood, voiceOn,
    queued: speech.queue.length, window: windowInfo(),
  });
}
setInterval(sendStatus, 2000);

// Screensaver: when nobody is talking with them (no conversation, typing or button for two minutes)
// the Chooms take turns on the glass, three to five minutes each, picked at random, so the tower
// shows all four going about their quiet moments. Not once she has dozed off at night, not on the
// group stage, and not in the first minutes after she wakes (let her wake up on the glass). A
// Choom arriving after a long while away greets (Aloy waves). QUIET_BEFORE_MS 0 turns it off.
const QUIET_BEFORE_MS = 2 * 60 * 1000;
const TURN_MS = [3 * 60 * 1000, 5 * 60 * 1000];
let turnLength = TURN_MS[0];
setInterval(() => {
  const now = performance.now();
  if (!QUIET_BEFORE_MS || now - lastActivity < QUIET_BEFORE_MS || now - lastSwitchAt < turnLength) return;
  if (mood !== 'idle' || speech.busy || speech.queue.length || heard() || phase !== 'idle' || sleepy() || stage.on) return;
  const here = portraits[current];
  const clip = here.alive && here.players[here.active].clip >= 0 ? here.alive.clips[here.players[here.active].clip] : null;
  if ((clip && (poseFrom(clip) === 'asleep' || poseTo(clip) === 'asleep')) || now - (here.wokeAt || 0) < 3 * 60 * 1000) return;
  const others = portraits.map((q, k) => k).filter((k) => k !== current);
  const next = others[Math.floor(Math.random() * others.length)];
  if (now - (portraits[next].lastShown || 0) > 45 * 60 * 1000) portraits[next].greet = true;
  turnLength = TURN_MS[0] + Math.random() * (TURN_MS[1] - TURN_MS[0]);
  post('quiet-turn', { from: here.name, to: portraits[next].name });
  switchTo(next);
}, 15000);
