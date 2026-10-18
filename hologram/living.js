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
// Install settings (optional): glass-settings.json beside this page overrides the hours, temperatures
// and visit lengths (see glass-settings.example.json). Missing, broken or a wrong type: the default.
const settings = await fetch('/glass-settings.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const setting = (key, fallback) => (typeof settings[key] === typeof fallback ? settings[key] : fallback);

const lkg = new LookingGlassRenderer({ canvas: document.getElementById('c'), calibration });
// A lost graphics context (a driver reset, the GPU out of memory: twice on Oct 10) leaves the glass
// black for good: reload the page after a moment.
document.getElementById('c').addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  post('error', { message: 'WebGL context lost; reloading the page in 5 s' });
  setTimeout(() => location.reload(), 5000);
});
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
    role: m.role || ROLES[m.id] || '',
    voice: m.voice || VOICES[m.id] || null,  // a Choom the Studio adds can name hers in the manifest
    color: asColor(color),
    depth: asData(depth),
    mask: asData(mask),
    plate: asColor(plate),
    plateDepth: asData(plateDepth),
    tint: new THREE.Color(m.color),
    accent: new THREE.Color(m.accent || m.color),
  };
}));

// Moments she's waiting to play (an expression, her mishap face, a tool look) go stale: one she
// couldn't play within 90 s (she left the glass, or was asleep) is dropped, not played an hour later
// when she comes back. They're set as usual; read after that, they're gone.
const WANT_FRESH_MS = 90 * 1000;
for (const p of portraits) {
  for (const key of ['emotion', 'mishapPending', 'toolLook']) {
    let value = null, at = 0;
    Object.defineProperty(p, key, {
      enumerable: true,
      get: () => (value && performance.now() - at > WANT_FRESH_MS ? (value = null) : value),
      set: (v) => { value = v; at = performance.now(); },
    });
  }
}

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
      mouthStyle: { value: 3 },                           // 0 lower lip only; 1 both lips; 2 a hint of teeth; 3 her teeth
      mouthShape: { value: new THREE.Vector3() },        // jaw open, lips round, lips wide (0..1)
      bottomFade: { value: 0 },                           // on the group stage: fade out her lowest part
      flip: { value: 0 },                                 // 1: mirrored (a seat at the campfire circle)
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
    uniform float focus, depthScale, faceZ, flip;
    uniform vec2 texel;
    varying vec2 vUv;
    varying float vEdge;
    ${PACKED_GLSL}
    void main() {
      // Mirrored, her picture is read right to left; everything after works in her picture's own
      // coordinates (vUv), so her mouth and motes mirror with her.
      vec2 tuv = flip > 0.5 ? vec2(1.0 - uv.x, uv.y) : uv;
      vUv = tuv;
      float d = depthAt(depthMap, tuv);
      float dl = depthAt(depthMap, tuv - vec2(texel.x, 0.0));
      float dr = depthAt(depthMap, tuv + vec2(texel.x, 0.0));
      float dd = depthAt(depthMap, tuv - vec2(0.0, texel.y));
      float du = depthAt(depthMap, tuv + vec2(0.0, texel.y));
      vEdge = max(max(abs(d - dl), abs(d - dr)), max(abs(d - dd), abs(d - du)));
      vec3 p = position;
      p.z = (d - focus) * depthScale + faceZ;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }`;

const LAYER_FRAG = /* glsl */ `
    uniform sampler2D colorMap, maskMap;
    uniform float opacity, glow, edgeThreshold, sparkle, time, bottomFade;
    uniform int useMask, mouthOn, mouthStyle;
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
    vec2 mouthWarp(vec2 uv, out float gap, out vec4 spot) {
      gap = 0.0;
      spot = vec4(0.0);
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
      // Style 1 and 2: both lips move, as in real speech. The upper lip lifts about a third of the
      // opening and the jaw drops the rest (style 0: the upper lip stays put).
      float rise = mouthStyle >= 1 ? 0.32 * open : 0.0;
      float drop = open - rise;
      // The upper lip's inner edge, nudged up past the seam between closed lips: left showing, the
      // seam (with a glint of teeth in a smile) reads as a straight line under the upper lip.
      float top = (mouthGap + 0.15 * hh) * lens;
      float rest = -mouthGap * lens;                        // the lower lip's, before she speaks
      if (rise > 0.0 && q.y > top) {
        float above = smoothstep(0.0, hh * 2.6, q.y - top);  // the lift fades out toward her nose
        s.y -= rise * lens * (1.0 - above);
      }
      if (q.y < rest) {
        float below = smoothstep(0.0, hh * 3.0, rest - q.y); // 0 at the lips, 1 toward the chin
        float jawShape = exp(-pow(q.x / (hw * 2.0), 2.0));  // the jaw itself is wider than the mouth
        float down = smoothstep(-chin * 1.7, -chin * 0.15, q.y);
        s.y += drop * mix(lens, jawShape, below) * down;
      }
      // The opening: between the upper lip's (raised) inner edge and the lowered lower lip.
      float lowerLip = rest - drop * lens;
      // Edges soft by about one panel pixel, so they don't stair-step at the panel's resolution.
      float aa = clamp(fwidth(q.y), 0.5, 4.0);
      // Closed lips: the opening starts at the upper lip. Parted lips: her teeth stay, and only what
      // the lowered lower lip uncovers goes dark.
      float gapTop = mix(top + rise * lens, rest, parted);
      gap = smoothstep(-0.5 * aa, aa, gapTop - q.y) * smoothstep(-0.5 * aa, 1.5 * aa, q.y - lowerLip)
          * smoothstep(0.5, 3.0, open);
      // Where in the opening this pixel sits, for shading the inside: height (0 at the lower lip,
      // 1 at the upper lip) and how central it is (1 mid-mouth, 0 at the corners). No teeth: pale
      // teeth with no real detail read as a second upper lip.
      spot.xy = vec2(clamp((q.y - lowerLip) / max(gapTop - lowerLip, 0.5), 0.0, 1.0), lens);
      if (mouthStyle >= 3) {
        // Style 3, her teeth (z upper, w lower: how much tooth and how lit). The upper front teeth
        // show under the upper lip whenever her lips part: up to 0.7 of a lip high (teeth don't grow
        // as she opens) and never more than half the opening, so there's always dark below them.
        // Shadowed where the lip overhangs, a little darker at the biting edge, darker toward the
        // corners as they curve away, with faint gaps between the front teeth so they read as
        // teeth rather than a pale band. The lower teeth only on wide sounds, a sliver over the
        // lower lip. Already parted lips show her own teeth instead.
        float topC = mouthGap + 0.15 * hh + rise, lowC = -mouthGap - drop;  // mid-mouth edges
        float toothH = max(min(0.7 * hh, 0.5 * (topC - lowC)), 0.5);
        float edge = topC - toothH;                                    // the biting edge, level
        float down = clamp((gapTop - q.y) / toothH, 0.0, 1.0);         // 0 under the lip, 1 at the edge
        float u = abs(q.x) / cw;
        float gaps = min(min(u, abs(u - 0.36)), abs(u - 0.64));        // between the front teeth
        float apart = 1.0 - 0.22 * (1.0 - smoothstep(0.01, 0.035, gaps));
        float upper = smoothstep(edge - 0.08 * hh, edge + 0.08 * hh, q.y)
                    * mix(0.4, 1.0, smoothstep(0.0, 0.45, down)) * mix(1.0, 0.8, smoothstep(0.75, 1.0, down))
                    * smoothstep(0.3, 0.8, lens) * (0.65 + 0.35 * lens) * apart;
        float over = (q.y - lowerLip) / hh;                            // lip heights over the lower lip
        float lower = (1.0 - smoothstep(0.2, 0.36, over)) * smoothstep(0.4, 0.85, lens) * apart
                    * max(smoothstep(0.15, 0.6, wide), 0.5 * parted);
        spot.zw = vec2(upper * (1.0 - parted), lower);
      }
      s.y += seam;
      return mouthC + vec2(ca * s.x - sa * s.y, sa * s.x + ca * s.y) / texSize;
    }

    void main() {
      if (useMask == 1 && maskAt(maskMap, vUv) < 0.5) discard;
      // Only extreme depth jumps are dropped. Smaller ones stretch, which shows nearby skin or
      // cloth instead of a black gap.
      if (vEdge > edgeThreshold) discard;
      float gap = 0.0;
      vec4 spot = vec4(0.0);
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
        if (mouthStyle >= 1) {
          // Softer and less red, darkest at the back, the tongue only just there.
          mouthRed = mix(lip, vec3(0.36, 0.11, 0.10), 0.5);
          inside = mouthRed * mix(0.26, 0.06, smoothstep(0.25, 1.0, height));
          inside = mix(inside, mouthRed * 0.5, tongue * 0.6);
        }
        if (mouthStyle == 2) {
          // The edge of her upper teeth in shadow, only when she opens wide: dimmer than her lip,
          // so it never reads as a second lip.
          float teeth = smoothstep(0.74, 0.9, height) * smoothstep(0.45, 0.85, middle) * smoothstep(0.35, 0.75, mouthShape.x);
          vec3 enamel = mix(lip, vec3(0.93, 0.86, 0.76), 0.75) * 0.72;   // warm ivory in the lip's light, in shadow
          inside = mix(inside, enamel, teeth * 0.75);
        }
        if (mouthStyle >= 3) {
          // Warm ivory in her own light: tinted by her lips' hue and as bright as her light, so they
          // don't look grey beside warm skin. Shading darkens them toward the inside of her mouth;
          // the lower teeth are dimmer still, in the upper ones' shadow.
          float light = dot(lip, vec3(0.3, 0.5, 0.2));
          vec3 enamel = mix(vec3(0.98, 0.88, 0.7), lip / max(light, 0.05), 0.25) * clamp(1.7 * light, 0.5, 1.0);
          inside = mix(inside, enamel * spot.z, smoothstep(0.0, 0.25, spot.z));
          inside = mix(inside, enamel * 0.6 * spot.w, smoothstep(0.0, 0.25, spot.w));
        }
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
        // Bits of black background caught inside her cut-out (at her hair) are invisible on black
        // glass, but on the stage they would hide whoever stands behind her.
        if (dot(c, vec3(0.2126, 0.7152, 0.0722)) < 0.0015) discard; // about 5/255: background black, not her pupils
        float f = smoothstep(0.15 * bottomFade, bottomFade, vUv.y);
        if (f < 0.01) discard;
        c *= pow(f, 2.2);
      }
      gl_FragColor = vec4(c * glow * opacity, 1.0);
    }`;

const frontMaterial = layerMaterial({ segX: 384, segY: 512, edgeThreshold: 0.35, useMask: true });
const plateMaterial = layerMaterial({ segX: 192, segY: 256, edgeThreshold: 0.22, useMask: false });
const portrait = new THREE.Group();
const [plateMesh, frontMesh] = [[plateMaterial, 192, 256], [frontMaterial, 384, 512]].map(([material, segX, segY]) => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.0, segX, segY), material);
  mesh.frustumCulled = false;
  portrait.add(mesh);
  return mesh;
});
// On the group stage the speaker always stands in front. Her sisters are drawn first (renderOrder -1)
// and their depth is cleared before her, so no part of a sister can cover her: Eve's dark lower body
// reached forward past the speaker's shoulders and cut into her.
// Around the campfire it's real depth instead: the seats sit where they sit, the ends nearest you.
frontMesh.onBeforeRender = (renderer) => { if (stage.mix > 0 && !circle.on) renderer.clearDepth(); };
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
  ...o, color: portraits.find((p) => p.id === o.who)?.tint.getHex() ?? o.color,  // each sister's own color
  rx: ATOM.rx, ry: ATOM.ry, cy: ATOM.cy, speed: ATOM.speed, yaw: 0, pitch: ATOM.pitch,
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
const picture = { group: new THREE.Group(), mesh: null, frame: null, t: 0, hold: 0, active: false, low: false };
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
    // Always drawn over her (no depth test): a hand or arm reaching forward in her relief cut into it.
    picture.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
    picture.frame = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.024, h + 0.024),
      new THREE.MeshBasicMaterial({ color: p.tint, transparent: true, opacity: 0,  // her color, from the manifest
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    picture.frame.renderOrder = 10;
    picture.mesh.renderOrder = 11;
    picture.frame.position.z = -0.004;
    picture.group.add(picture.frame, picture.mesh);
    picture.t = 0;
    picture.hold = kind === 'snapshot' || kind === 'looking' ? 8 : 11;
    // Tall pictures float beside her face. Wide and square ones go lower right, below her chin: beside
    // her face they reached across her left eye, and down there a look at them is a glance down.
    picture.low = aspect >= 0.9;
    // She turns to look at it (a selfie gets a "look at me" move instead), if she has a look for it.
    if (kind !== 'selfie' && p.alive && p === portraits[current]) {
      p.lookAt = picture.low ? 'picturedown' : 'picture';
      const a = p.players[p.active], b = p.players[1 - p.active];
      if (a.clip >= 0 && !a.video.ended && b.video.paused && !p.moments?.has(b.clip)) aliveLoad(p, b, nextClip(p, a.clip));
    }
    picture.active = picture.group.visible = true;
    post('picture', { choom: p.name, kind });
  }, undefined, () => post('error', { message: `picture ${imageId} did not load` }));
}
function updatePicture(dt) {
  if (!picture.active) return;
  picture.t += dt;
  const shown = ease(Math.min(picture.t / 0.7, 1)) * Math.min(Math.max((picture.hold + 0.9 - picture.t) / 0.9, 0), 1);
  const sm = ease(stage.mix);
  // On the stage, all go to the top right corner, the one place nobody stands (up top in the middle
  // covered the sister at the back).
  const [px, py] = picture.low ? [0.4, -0.42] : [0.5, 0.46];
  picture.group.position.set(px + (0.5 - px) * sm, py + (0.74 - py) * sm + Math.sin(picture.t * 1.1) * 0.012, 0.05);
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
let listeningAt = 0;            // when it went down: a release that never arrives (a USB hiccup, focus
const LISTEN_HOLD_MAX_MS = 60000; // lost mid-hold) would keep her listening for good, so a minute at most
function setListening(on) { if (on && !listening) listeningAt = performance.now(); listening = on; }
// Donny typing to her or talking into the mic in the Choom app at home. Dropped when her turn
// starts, or after a while if the "stopped" message never comes.
let appListening = false;
// Local weather from the server (every 10 minutes): a windy day stirs Genesis's hair (her wind
// clips join her quiet moments), and later rain or snow can drift through the glass.
let weather = { wind: 0, gust: 0, description: '' };
// Windy: a 10-minute average of 12 mph or gusts of 20 (Donny's own weather station when Home Assistant
// has one; OpenWeather's town readings ran low and never reported gusts). The server holds it for 20
// minutes after the last such reading (`windy`): gusts come and go, and the rule alone turned her windy
// day on and off every few minutes.
const windy = () => (typeof weather.windy === 'boolean' ? weather.windy : (weather.wind || 0) >= 12 || (weather.gust || 0) >= 20);
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
  // Rain from his station's rain gauge when it has one (`rain`, inches an hour): the town report said
  // "light rain" for half an hour of a dry afternoon (2026-10-11).
  if (typeof weather.rain === 'number' ? weather.rain > 0 : /rain|drizzle|shower|storm|thunder/.test(d)) return 'rain';
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
const CUT_OUT_S = 0.25;        // a camera cut: her last frame fades out this fast,
const CUT_IN_S = 0.35;         // and the new framing fades in over this
let cutFade = null;            // { t, shown } while a cut is under way
let sleepAmt = 0;              // 1 while she sleeps: the glass dims and slows
let fullAmt = 0;               // 1 during a full-body move: her atom and band step aside
let bandT = 0;                 // the scan/compile band's own clock (it races during tool moments)
let lastActivity = performance.now(); // the last conversation, listening or button press
let lastVoiceNearby = 0;  // someone talking near the tower (tower_ears): no quiet turn now, but it never
                          // keeps her awake (2026-10-18 it woke her as he turned over in bed at night)
let appListenUntil = 0;
const heard = () => (listening && performance.now() - listeningAt < LISTEN_HOLD_MAX_MS) || (appListening && performance.now() < appListenUntil);
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
const poseFrom = (c) => (c.bad ? '-' : c.from || 'main');  // a clip that failed to load starts nowhere
const poseTo = (c) => c.to || 'main';
// A play() cut short because the waiting clip was swapped for a moment (a tool look, a picture
// look) is expected, not an error.
const videoError = (e) => { if (e.name !== 'AbortError') post('error', { message: `alive video: ${e.message}` }); };
const WAKING_POSES = new Set(['main', 'relaxed']);
// Her places (Genesis's campfire: sitting on the ground by a fire): any pose that isn't one every
// Choom may have (tools/clip_roles.py POSES). She goes there when she asks (glass_move), from her full
// body (to_campfire), stays a while and gets up again (from_campfire); see nextClip. "gone" is the
// empty glass: on a quiet turn the one leaving walks off into it and the next walks on from it.
const POSES = new Set(['main', 'relaxed', 'full', 'asleep', 'gone']);
// Her seats at the campfire circle (the group stage after dark; see circleArrange): "circle" faces
// you across the fire (a middle seat), "circleside" is turned in toward the middle from the right (an
// end seat; at the left end it's mirrored). Not places: she sits there only while the circle is on.
const SEAT_LOOKS = ['circle', 'circleside'];
const isSeat = (pose) => SEAT_LOOKS.includes(pose.split('@')[0]);
const isPlace = (pose) => !POSES.has(pose.split('@')[0]) && !isSeat(pose);
const PLACE_STAY_MS = setting('placeMinutes', 10) * 60000;
const goes = (c) => clipMoods(c).includes('go');  // on the way to a place or the empty glass, and back
const LOOKS_AWAY = /glance|look|sidelook|shoulder|daydream|horizon|lookup|lookdown|hunter|skycheck|scan|turn|dreamy|thinkdown|picture/;  // the framings she lives in (not asleep, not full-body)
const FULL_IDLE_CHANCE = 0.07;
// Her clothes. Clips in other outfits live in poses of their own (relaxed@evening), and an outfit's
// name says when she wears it: night… from 10 pm until she wakes, cold… under 45°F, hot… over 85°F,
// evening… from 6 to 11 pm, and day… outfits take turns with her usual clothes, a different one each
// day (picked from the date, so it holds all day). She changes with a camera cut at a quiet moment
// (or a change clip made for it, <choom>_eveningdress-change_night_slip), and back into her usual
// clothes before she sleeps, unless a night outfit has its own asleep look to sleep in.
const outfitOf = (pose) => pose.split('@')[1] || null;
const basePose = (pose) => pose.split('@')[0];
// Her whole figure: her usual full body, or an outfit's own (full@dayspandex), which the glass cuts
// to only while she wears that outfit.
const isFull = (pose) => basePose(pose) === 'full';
const fullOf = (pose) => (outfitOf(pose) ? `full@${outfitOf(pose)}` : 'full');
// Night clothes, from 10 pm until 7 am: nightwarm… when it's 70°F or warmer, nightcold… below
// (his station), any other night… outfit either way. Chosen when she first puts them on and kept until
// morning, so a cooling night doesn't change her pajamas at 2 am. Put on to sleep by day (he naps),
// they're kept only until 10 pm, so the night's own pick still goes by that night's temperature.
const NIGHT_FROM = setting('nightClothesFrom', 22), NIGHT_WARM_F = setting('nightWarmF', 70);
const nightNow = () => { const h = hourNow(); return h >= NIGHT_FROM || h < SLEEP_UNTIL; };
const msUntilHour = (hour) => { const d = new Date(), t = new Date(d); t.setHours(hour, 0, 0, 0); if (t <= d) t.setDate(t.getDate() + 1); return t - d; };
function nightOutfit(p, outfits) {
  const nights = outfits.filter((o) => /^night/.test(o));
  if (!nights.length) return null;
  if (p.nightPick && performance.now() < p.nightPick.until && nights.includes(p.nightPick.o)) return p.nightPick.o;
  const t = weather.temperature, warm = typeof t === 'number' ? t >= NIGHT_WARM_F : null;
  const o = (warm !== null && nights.find((x) => (warm ? /warm/ : /cold/).test(x))) || nights.find((x) => !/warm|cold/.test(x)) || nights[0];
  p.nightPick = { o, until: performance.now() + msUntilHour(nightNow() ? SLEEP_UNTIL : NIGHT_FROM) };
  return o;
}
const COLD_BELOW_F = setting('coldBelowF', 45), HOT_ABOVE_F = setting('hotAboveF', 85);
const EVENING_FROM = setting('eveningFrom', 18), EVENING_UNTIL = setting('eveningUntil', 23);
const OUTFIT_RULES = [
  [/^cold/, () => typeof weather.temperature === 'number' && weather.temperature < COLD_BELOW_F],  // °F
  [/^hot/, () => typeof weather.temperature === 'number' && weather.temperature > HOT_ABOVE_F],
  [/^evening/, () => { const h = hourNow(); return h >= EVENING_FROM && h < EVENING_UNTIL; }],
];
// An outfit or other look with a dozen clips loops them every minute (the clock look), so she wears
// it in short visits spread through its hours: a visit lasts about 30 s per clip it has (each clip
// comes around about six times; 3 to 15 minutes), then she's back in her usual clothes for at least
// 25 minutes. Outfits also have a daily total of 2 minutes per clip. More clips, longer visits. Kept
// across relaunches (localStorage), which used to hand her a fresh evening in the sweater each time.
const VISIT_S_PER_CLIP = setting('visitSecondsPerClip', 30);
const VISIT_MIN_MS = setting('visitMinMinutes', 3) * 60000, VISIT_MAX_MS = setting('visitMaxMinutes', 15) * 60000;
const VISIT_REST_MS = setting('restMinutes', 25) * 60000;
const OUTFIT_DAY_MS_PER_CLIP = setting('dailyMinutesPerClip', 2) * 60000;
const ALT_LOOKS = new Set(['plain', 'noheart']);  // looks in her usual clothes: visits, but no daily total
function wardrobe(p) {
  if (!p.wardrobe) {
    try { p.wardrobe = JSON.parse(localStorage.getItem(`wardrobe-${p.id}`)) || null; } catch { p.wardrobe = null; }
  }
  const today = new Date().toDateString();
  if (!p.wardrobe || p.wardrobe.day !== today) {
    p.wardrobe = { day: today, worn: {}, rested: p.wardrobe?.rested || {}, restedAny: p.wardrobe?.restedAny || 0, visit: null };
  }
  return p.wardrobe;
}
function saveWardrobe(p) {
  try { localStorage.setItem(`wardrobe-${p.id}`, JSON.stringify(p.wardrobe)); } catch { /* the page works without it */ }
}
const lookClips = (p, o) => p.alive.clips.filter((c) => outfitOf(poseFrom(c)) === o).length;
const visitLength = (p, o) => Math.min(VISIT_MAX_MS, Math.max(VISIT_MIN_MS, lookClips(p, o) * VISIT_S_PER_CLIP * 1000));
function mayWear(p, o) {
  // All night long, and only at night: a night outfit she's in by day (woken from a nap, or still in
  // it from last night after a relaunch) would go on as a visit with no hours to end it. Eve put
  // her pajamas back on at 8 am and wore them all day (2026-10-18).
  if (/^night/.test(o)) return nightNow();
  const w = wardrobe(p), now = Date.now();
  if (w.visit && w.visit.o === o) return now - w.visit.start < visitLength(p, o);  // wearing it: until the visit is up
  if (now - (w.rested[o] || 0) < VISIT_REST_MS) return false;                     // just took it off
  return ALT_LOOKS.has(o) || (w.worn[o] || 0) < lookClips(p, o) * OUTFIT_DAY_MS_PER_CLIP;
}
// Called with each clip she finishes (at the hand-over, once per clip): counts time worn, starts and
// ends visits. The end of an outfit's visit starts her rest in her usual clothes (restedAny).
function noteWorn(p, pose, ms) {
  const w = wardrobe(p), o = outfitOf(pose), now = Date.now();
  if (w.visit && w.visit.o !== o) {
    w.rested[w.visit.o] = now;
    if (!ALT_LOOKS.has(w.visit.o) && !/^night/.test(w.visit.o)) w.restedAny = now;
    w.visit = null;
  }
  if (o) {
    if (!w.visit) w.visit = { o, start: now };
    w.worn[o] = (w.worn[o] || 0) + ms;
  }
  saveWardrobe(p);
}
// Clothes she chose herself (glass_wear): kept until she goes to sleep or chooses again, at most
// until midnight (the wardrobe starts fresh each day). Day clothes chosen before night-clothes time
// come off then: Genesis chose denim at 2:45 pm and was still in it past 10 pm (2026-10-16).
function nightStartedAt() {
  const d = new Date();
  if (hourNow() < NIGHT_FROM) d.setDate(d.getDate() - 1);  // after midnight: last night's
  d.setHours(NIGHT_FROM, 0, 0, 0);
  return d.getTime();
}
function chosenOutfit(p) {
  const w = wardrobe(p), c = w.chosen;
  if (!c) return undefined;
  if (nightNow() && !/^night/.test(c.o || '') && (c.at || 0) < nightStartedAt()) {
    w.chosen = null;
    saveWardrobe(p);
    return undefined;
  }
  if (c.o && !p.alive.clips.some((x) => outfitOf(poseFrom(x)) === c.o && clipMoods(x).includes('talk'))) return undefined;
  return c.o;
}
// The outfits she can wear: those with a loop she can talk over.
const wearable = (p) => [...new Set(p.alive.clips.filter((c) => clipMoods(c).includes('talk')).map((c) => outfitOf(poseFrom(c))).filter(Boolean))];
// Night clothes she can sleep in: their own asleep look (asleep@nightcold) to sleep and wake in.
const canSleepIn = (p, o) => ['sleep', 'wake'].every((mood) => p.alive.clips.some((c) => clipMoods(c).includes(mood) && poseFrom(c) === `asleep@${o}`));
function bedOutfit(p) {
  const o = nightOutfit(p, wearable(p));
  return o && canSleepIn(p, o) ? o : null;
}
function wantedOutfit(p, want) {
  if (want === 'sleep') {
    const w = wardrobe(p), chosen = w.chosen?.o;
    if (w.chosen) { w.chosen = null; saveWardrobe(p); }
    // Night clothes she put on herself (glass_wear) stay on to sleep in, and until morning.
    if (chosen && /^night/.test(chosen) && canSleepIn(p, chosen)) {
      p.nightPick = { o: chosen, until: performance.now() + msUntilHour(SLEEP_UNTIL) };
      return chosen;
    }
    return bedOutfit(p);
  }
  const chosen = chosenOutfit(p);
  if (chosen !== undefined) return chosen;
  const outfits = wearable(p).filter((o) => mayWear(p, o));
  const night = nightNow() && nightOutfit(p, outfits);
  if (night) return night;
  // A visit under way goes on until it's up (or its hours or weather end), not swapped mid-way for
  // another outfit of the same kind. After an outfit's visit (up now, or within 25 minutes) she's in
  // her usual clothes (or another look in them), not straight into the next outfit: with three
  // evening outfits Eve went from one to the next all evening.
  const w = wardrobe(p);
  const visiting = w.visit && !ALT_LOOKS.has(w.visit.o) ? w.visit.o : null;
  const ruleOf = (o) => OUTFIT_RULES.find(([rule]) => rule.test(o))?.[1];
  if (visiting && outfits.includes(visiting) && (ruleOf(visiting)?.() ?? true)) return visiting;
  const inUsual = !w.visit || ALT_LOOKS.has(w.visit.o);  // her plain look is her usual clothes too
  const resting = (visiting && !outfits.includes(visiting)) || (inUsual && Date.now() - (w.restedAny || 0) < VISIT_REST_MS);
  let pick = null;
  if (!resting) {
    // Several outfits for the same hours (Eve's three for evenings) take turns: the one off longest.
    for (const [rule, when] of OUTFIT_RULES) {
      const o = outfits.filter((x) => rule.test(x)).sort((a, b) => (w.rested[a] || 0) - (w.rested[b] || 0))[0];
      if (o && when()) return o;
    }
    // One day outfit a day, from the date: picked from all of them, so while it rests she's in her
    // usual clothes. Picked from the ones she could wear right then, it moved on to the next day outfit
    // whenever the day's went to rest (Eve wore three on Oct 12).
    const days = [null, ...wearable(p).filter((x) => /^day/.test(x)).sort()];
    const d = new Date();
    let seed = d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();
    for (const ch of p.id) seed = (seed * 31 + ch.charCodeAt(0)) % 1000003;
    pick = days[seed % days.length];
    if (pick && !outfits.includes(pick)) pick = null;
  }
  // Her other looks in her usual clothes (Genesis without her glow, Optic without her heart): about a
  // third of the time, decided every twenty minutes, changed on screen with clips made for it.
  const alt = pick === null && outfits.find((o) => ALT_LOOKS.has(o));
  if (alt) {
    let h = Math.floor(Date.now() / (20 * 60000));
    for (const ch of p.id) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
    if (h % 10 < 3) return alt;
  }
  return pick;
}  // of her quiet clips, the share that cut to her whole figure (about one a minute)

function wantedMood(p) {
  if (portraits[current] !== p) return 'idle';
  if (heard()) return 'listen';
  if (mood === 'idle' && sleepy() && canSleep(p)) return 'sleep';
  if (mood === 'idle' && gaze.looking) return 'listen'; // he's looking at her: her facing-you clips
  return mood === 'speaking' ? 'talk' : mood === 'thinking' ? 'think' : 'idle';
}

// Sleep: late at night, once it has been quiet a while, the Choom on the glass dozes off and the
// glass dims; she wakes when he types or talks to her, when a reply comes in, or in the morning.
// Local hours.
const SLEEP_FROM = setting('sleepFrom', 23);
const SLEEP_UNTIL = setting('sleepUntil', 7);
const SLEEP_AFTER_QUIET_MS = setting('sleepAfterQuietMinutes', 10) * 60 * 1000;
let debugHour = null;     // debug: pretend it's this hour (/control {"hour": 23})
let debugJaw = null;      // debug: hold the mouth open this far (/control {"jaw": 0.6})
let debugSleep = false;   // debug: doze off now, however early or busy it is (/control {"sleep": true})
let presence = { home: null, desk: null, bed: null }; // from Home Assistant; see onPresence
let gaze = { looking: false, face: false };          // from the tower's camera; see onGaze
const hourNow = () => debugHour ?? new Date().getHours();
function sleepy() {
  if (debugSleep || presence.bed === true) return mood === 'idle' && !heard() && !speech.busy;
  const h = hourNow();
  const night = SLEEP_FROM > SLEEP_UNTIL ? h >= SLEEP_FROM || h < SLEEP_UNTIL : h >= SLEEP_FROM && h < SLEEP_UNTIL;
  return night && performance.now() - lastActivity > SLEEP_AFTER_QUIET_MS && mood === 'idle' && !heard() && !speech.busy;
}

// She only dozes off if she has a sleep loop to stay asleep in (and can wake from it).
const canSleep = (p) => p.alive && p.alive.clips.some((c) => clipMoods(c).includes('sleep') && basePose(poseFrom(c)) === 'asleep') &&
                        p.alive.clips.some((c) => clipMoods(c).includes('wake'));

// A clip that gets her into a mood from the pose she's in: one that starts here, or else the pose
// change that leads to a pose where one starts (Aloy lowers her hand before she waves or sleeps).
// Stand-ins for a feeling in a look without its expression clip (every outfit, so far), by clip name.
const FEEL_LIKE = {
  happy: /[_-](laugh|softlaugh|smile|grin|giggle|chuckle|proud)\d*\.mp4$/,
  surprised: /[_-](brows|eyebrow|curious|surprised)\d*\.mp4$/,
  concerned: /[_-](tilt|slowblink)\d*\.mp4$/,
  sad: /[_-](lookdown|sigh|eyesclose)\d*\.mp4$/,
  oops: /[_-](shrug|headshake|shy|sigh)\d*\.mp4$/,
};

function seekClip(p, pose, wanted, after = -1) {
  const clips = p.alive.clips;
  const ks = clips.map((c, k) => k);
  let here = ks.filter((k) => poseFrom(clips[k]) === pose && clipMoods(clips[k]).includes(wanted));
  if (here.length > 1) here = here.filter((k) => k !== after);
  if (here.length) return here[Math.floor(Math.random() * here.length)];
  const targets = new Set(ks.filter((k) => clipMoods(clips[k]).includes(wanted)).map((k) => poseFrom(clips[k])));
  // (Not through a change of clothes: an expression in her night look isn't worth changing out of it.)
  const toward = ks.find((k) => poseFrom(clips[k]) === pose && poseTo(clips[k]) !== pose && targets.has(poseTo(clips[k])) &&
                                !clipMoods(clips[k]).includes('change') && !goes(clips[k]));
  return toward ?? -1;
}

// Tool moments: what she's doing shows on her face. Looking through a camera or at a picture she
// looks around, searching her memories she drifts off remembering, checking the weather she glances
// up at the sky, making a picture she gets a playful look. Clips are found by name, so a Choom
// without a fitting one just keeps thinking (the glass flares either way).
const TOOL_LOOKS = [
  [/camera|snapshot|analyze_image|vision/, /scan|glance|bright/],
  [/memor|remember|recall|followup/, /daydream|thinkup|hum/],
  [/weather|forecast/, /skycheck|thinkup/], // (her wind clips are for windy days only)
  [/generate_image|save_generated|draw|paint/, /eyebrow|smirk|smile/],
  [/search|browse|fetch|web/, /scan|thinkdown|glance/],
  [/^ha_|home|printer|calendar|inbox/, /scan|glance|thinkdown/],
];
const toolLook = (tool) => (TOOL_LOOKS.find(([t]) => t.test(tool || '')) || [])[1] || null;

// Clips that join a mood's own clips in nextClip: her wind and yawns while she's quiet on a windy day
// or a sleepy hour, and her quiet clips that keep facing forward while he looks at her or she thinks
// (not the lively ones while she thinks). suits() has to know them too: the handover swapped any clip
// without the mood back out and hurried the few that got through (in a week of about 97,000 clips her
// wind played 9 times and the yawns 4, 2026-10-11).
const NOT_THINKING = /amused|eyebrow|smirk|beat|giggle|groove|laugh|wink|wave|tease|kiss|dance/;
function joinsMood(want, c) {
  const m = clipMoods(c), src = c.source || '';
  if (want === 'idle') return m.includes('yawn') || (m.includes('windy') && windy());
  const facing = m.includes('idle') && poseFrom(c) === poseTo(c) && !LOOKS_AWAY.test(src);
  if (want === 'listen') return facing;
  if (want === 'think') return facing && !NOT_THINKING.test(src);
  return false;
}
// While a picture floats beside her she doesn't look up and away from it.
const LOOKS_UP = /thinkup|skycheck|lookup/;
// A look without picture looks (her outfits, the plain look) turns to the picture with a quiet clip
// that looks its way: the Studio's glance is to her left, toward the picture's side of the frame, and
// one lower right gets a look down first.
const PICTURE_GLANCES = { picture: [/glance(?!right)/], picturedown: [/lookdown/, /glance(?!right)/] };
// Thinking, she looks up or down (her thinking clips) at most this often.
const THINK_LOOK_GAP_MS = 30000;

// Whether clip k suits what she's doing now (an expression or tool moment plays out unless she's
// listening or asleep).
function suits(p, k) {
  const want = wantedMood(p);
  const c = p.alive.clips[k];
  // In her seat at the campfire circle, seatClip chose by who's talking: a sister's clip always fits,
  // and the one talking talks in her loop, not turned away in a listening clip.
  if (p.seat && poseFrom(c) === p.seat) return p !== portraits[current] || !/listen/.test(c.source || '') || want !== 'talk';
  // A moment (expression, tool look) plays out, except into sleep or while he types or talks to her:
  // him only looking at her (the camera) doesn't cut it short.
  return clipMoods(c).includes(want) || (p.moments?.has(k) && want !== 'sleep' && (want !== 'listen' || !heard())) ||
         joinsMood(want, c) ||
         ((p.emotion || p.poseWanted || p.moveWanted || chosenOutfit(p) !== undefined) && poseFrom(c) !== poseTo(c)); // on her way to an expression, a move or her clothes
}

function nextClip(p, after) {
  const clips = p.alive.clips;
  let pose = after >= 0 && clips[after] ? poseTo(clips[after]) : 'main';
  // After a full-body move, cut back to the framing she was in (not to a place she has left).
  if (isFull(pose)) pose = p.cutFrom && !(isPlace(p.cutFrom) && !p.stay) ? p.cutFrom : p.alive.home || 'main';
  // Off the glass (she walked off): back on (walking on, appearing), else a cut to her home loop. While
  // she's leaving for another Choom's turn this waits unplayed (the players' ended handler).
  if (pose === 'gone') {
    const on = clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === 'gone');
    if (on.length) {
      const k = on[Math.floor(Math.random() * on.length)];
      if (isFull(poseTo(clips[k]))) p.cutFrom = p.alive.home || 'main';
      (p.moments ||= new Set()).add(k);
      return k;
    }
    pose = p.alive.home || 'main';
  }
  // At the campfire circle she stays in her seat (seatClip); out of it, the glass cuts to her home pose.
  if (p.seat) {
    const k = seatClip(p, after);
    if (k >= 0) return k;
  }
  if (isSeat(pose)) pose = p.alive.home || 'main';
  const want = wantedMood(p);
  // Time to change clothes (or back into her usual ones before sleep): a cut to her base loop in the
  // other outfit, at a quiet moment. Her places are in her usual clothes: asked to go to one, she
  // changes into them first, and there she stays in them.
  const asleep = basePose(pose) === 'asleep';  // asleep, or asleep in her night outfit (asleep@night)
  const goingTo = p.moveWanted && clips.some((c) => p.moveWanted.sources.has(c.source) && isPlace(poseTo(c)));
  const dressed = outfitOf(pose), dress = asleep || isPlace(pose) ? dressed : goingTo ? null : wantedOutfit(p, want);
  const quiet = want === 'idle' || want === 'sleep' || want === 'listen' || (want === 'think' && chosenOutfit(p) !== undefined);
  if (dress !== dressed && !asleep && quiet) {
    const to = dress ? `${basePose(pose)}@${dress}` : basePose(pose);
    // A clip that makes the change on screen (Genesis's motes fading away or sparkling back), else a cut.
    const change = clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === pose && poseTo(clips[k]) === to);
    if (change.length) {
      const k = change[Math.floor(Math.random() * change.length)];
      (p.moments ||= new Set()).add(k);
      return k;
    }
    const hasLoop = (pz) => clips.some((c) => poseFrom(c) === pz && poseTo(c) === pz && clipMoods(c).includes('talk'));
    const loops = clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === to && poseTo(clips[k]) === to &&
                                                        clipMoods(clips[k]).includes('talk'));
    if (loops.length) return loops[0];
    // The outfit only in her other pose (Aloy's are all hand-down): she moves into that pose first.
    const via = dress ? clips.findIndex((c) => poseFrom(c) === pose && poseTo(c) !== pose && !outfitOf(poseTo(c)) &&
                                               hasLoop(`${poseTo(c)}@${dress}`)) : -1;
    if (via >= 0) return via;
  }
  // At one of her places (sitting by her campfire) she stays a while, then gets up (from_campfire, to
  // her full body, and the glass cuts back), or without such a clip the glass just cuts back. Bedtime,
  // the group stage or her turn on the glass ending cut the stay short.
  if (isPlace(pose)) {
    const now = performance.now();
    // `back`: the look she came from, cut back to once she's up (a full-body move from here cuts back here).
    if (!p.stay || p.stay.pose !== pose) {
      p.stay = { pose, until: now + PLACE_STAY_MS, back: p.cutFrom && !isPlace(p.cutFrom) ? p.cutFrom : p.alive.home || 'main' };
    }
    if (now > p.stay.until || want === 'sleep' || stage.on || p.leaving != null) {
      p.cutFrom = p.stay.back;
      p.stay = null;
      const up = clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === pose && goes(clips[k]));
      if (up.length) {
        const k = up[Math.floor(Math.random() * up.length)];
        (p.moments ||= new Set()).add(k);
        return k;
      }
      pose = p.cutFrom || p.alive.home || 'main';
    }
  } else {
    p.stay = null;
  }
  // Her turn on the glass is over (a quiet turn): she walks off, or vanishes, and the next Choom comes
  // on once she's gone (the players' ended handler). From a waist-up look the glass cuts to her full
  // body to walk off from. With neither, the turn passes with the usual fade (the screensaver below).
  if (p.leaving != null && want !== 'idle') p.leaving = null;  // he's talking with her: she stays
  if (p.leaving != null) {
    const off = (pz) => clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === pz && poseTo(clips[k]) === 'gone');
    const ways = off(pose).concat(isPlace(pose) ? [] : off(fullOf(pose)));
    if (ways.length) {
      const k = ways[Math.floor(Math.random() * ways.length)];
      if (poseFrom(clips[k]) !== pose) p.cutFrom = pose;
      (p.moments ||= new Set()).add(k);
      return k;
    }
  }
  // Asleep: stay asleep, or wake first if anything else is wanted. Sleepy: doze off (via a pose
  // change if needed).
  if (asleep && want !== 'sleep') {
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
  // From another pose she gets there first (Aloy raises her hand, then smiles). Never mid-sentence:
  // a laughing face fights her lip sync, so a feeling from her own words waits until she's done
  // (feelSaid). Him only looking at her (the camera) is no reason to hold a feeling back.
  const free = want === 'think' || want === 'idle' || (want === 'listen' && !heard());
  if (free && p.mishapPending && !p.emotion) {
    p.mishapPending = false;
    p.emotion = 'oops';
  }
  if (free && p.emotion) {
    let felt = seekClip(p, pose, p.emotion, after);
    let arrived = felt >= 0 && clipMoods(clips[felt]).includes(p.emotion);
    if (felt < 0 && FEEL_LIKE[p.emotion]) {
      // The expressions are made for her usual clothes; in an outfit, the nearest clip it has.
      const like = all.filter((k) => k !== after && poseTo(clips[k]) === pose && !/talk_/.test(clips[k].source || '') &&
                                     FEEL_LIKE[p.emotion].test(clips[k].source || ''));
      if (like.length) [felt, arrived] = [like[Math.floor(Math.random() * like.length)], true];
    }
    if (felt < 0 || arrived) p.emotion = null;
    if (arrived) (p.moments ||= new Set()).add(felt); // played out in full, not hurried
    if (felt >= 0) return felt;
  }
  // A move she asked for (glass_move), at her next quiet moment, in the clothes she has on: from the
  // pose she's in if she has it there, else her whole figure in these clothes (a cut), else on the far
  // side of a pose change in these clothes. A move she has only in other clothes doesn't play (it was
  // a cut into another outfit; server.py tells her it's a wish).
  if (p.moveWanted && performance.now() > p.moveWanted.until) p.moveWanted = null;
  if (p.moveWanted && free && isPlace(pose) && clips.some((c) => p.moveWanted.sources.has(c.source) && poseTo(c) === pose)) {
    p.moveWanted = null;  // asked for the place she's at: she stays longer
    if (p.stay) p.stay.until = performance.now() + PLACE_STAY_MS;
  }
  if (p.moveWanted && free) {
    const sameClothes = (pz) => outfitOf(pz) === outfitOf(pose);
    const asked = clips.map((c, k) => k).filter((k) => p.moveWanted.sources.has(clips[k].source) && sameClothes(poseFrom(clips[k])));
    const here = asked.filter((k) => poseFrom(clips[k]) === pose);
    const wide = asked.filter((k) => poseFrom(clips[k]) === fullOf(pose));
    const starts = new Set(asked.filter((k) => !isFull(poseFrom(clips[k]))).map((k) => poseFrom(clips[k])));
    const toward = clips.findIndex((c) => poseFrom(c) === pose && poseTo(c) !== pose && starts.has(poseTo(c)) && !clipMoods(c).includes('change') && !goes(c));
    if (!here.length && !wide.length && toward >= 0) return toward; // Aloy raises her hand first
    const from = here.length ? here : wide;
    if (!from.length) post('glass', { choom: p.id, missed: [...p.moveWanted.sources][0] || null, why: 'not in the clothes she has on' });
    p.moveWanted = null;
    if (from.length) {
      const k = from[Math.floor(Math.random() * from.length)];
      if (isFull(poseFrom(clips[k]))) p.cutFrom = pose; // back to this framing after it
      post('glass', { choom: p.id, picked: clips[k].source });
      (p.moments ||= new Set()).add(k);
      return k;
    }
  }
  // A selfie she just made: one of her "look at me" moves (via a pose change if needed).
  if (p.poseWanted && want !== 'sleep' && (want !== 'listen' || !heard())) {
    const full = clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === fullOf(pose) && clipMoods(clips[k]).includes('pose'));
    const waistUp = clips.some((c) => clipMoods(c).includes('pose') && !isFull(poseFrom(c)));
    if (full.length && !isFull(pose) && (!waistUp || Math.random() < 0.65)) { // full-body (by a cut) two times in three
      p.poseWanted = false;
      p.cutFrom = pose; // where to cut back to after the move
      const move = full[Math.floor(Math.random() * full.length)];
      (p.moments ||= new Set()).add(move);
      return move;
    }
    const move = seekClip(p, pose, 'pose', after);
    const arrived = move >= 0 && clipMoods(clips[move]).includes('pose');
    if (move < 0 || arrived) p.poseWanted = false;
    if (arrived) (p.moments ||= new Set()).add(move);
    if (move >= 0) return move;
  }
  // A picture just floated up beside her: she turns to look at it (or down, at one lower right). One
  // that comes up while she talks waits until she's done, if the picture is still showing.
  if (p.lookAt && !picture.active) p.lookAt = null;
  if (free && p.lookAt) {
    const look = p.lookAt;
    p.lookAt = null;
    let looks = all.filter((k) => clipMoods(clips[k]).includes(look) && poseTo(clips[k]) === pose);
    for (const name of PICTURE_GLANCES[look] || []) {
      if (looks.length) break;
      looks = all.filter((k) => poseTo(clips[k]) === pose && name.test(clips[k].source || ''));
    }
    if (looks.length) {
      const k = looks[Math.floor(Math.random() * looks.length)];
      (p.moments ||= new Set()).add(k);
      return k;
    }
  }
  if (free && p.toolLook) {
    const look = p.toolLook;
    p.toolLook = null;
    const moments = all.filter((k) => k !== after && poseTo(clips[k]) === pose && look.test(clips[k].source || '') &&
                                      !(picture.active && LOOKS_UP.test(clips[k].source || '')));
    if (moments.length) {
      const k = moments[Math.floor(Math.random() * moments.length)];
      (p.moments ||= new Set()).add(k);
      return k;
    }
  }
  // Now and then while she's quiet, the glass cuts to her whole figure for a few seconds and back,
  // like a camera changing shots (her full-body quiet clips). Only the Choom on the glass, never on
  // the stage, and not twice running. In an outfit, only to that outfit's own full body.
  const cameFromWide = after >= 0 && clips[after] && isFull(poseFrom(clips[after]));
  if (want === 'idle' && !stage.on && p === portraits[current] && !cameFromWide && !isPlace(pose) && Math.random() < FULL_IDLE_CHANCE) {
    const wide = clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === fullOf(pose) && clipMoods(clips[k]).includes('idle'));
    if (wide.length) {
      p.cutFrom = pose;
      return wide[Math.floor(Math.random() * wide.length)];
    }
  }
  const breezy = want === 'idle' && windy();
  // A yawn now and then in the last hours before sleep and the first after it, and likely right
  // after she wakes.
  const hour = hourNow();
  const justWoke = after >= 0 && clips[after] && clipMoods(clips[after]).includes('wake');
  const drowsy = want === 'idle' && (justWoke || (hour >= SLEEP_FROM - 2 && hour < SLEEP_FROM) ||
                                     (hour >= SLEEP_UNTIL && hour < SLEEP_UNTIL + 2));
  let fits = all.filter((k) => clipMoods(clips[k]).includes(want) || (breezy && clipMoods(clips[k]).includes('windy')) ||
                                 (drowsy && clipMoods(clips[k]).includes('yawn')));
  // Facing him (he's looking at the glass) in a look with few listening clips (an outfit has four):
  // her quiet clips that keep facing forward join in, or four clips loop every twenty seconds.
  if (want === 'listen' && fits.length < 10) fits = fits.concat(all.filter((k) => !fits.includes(k) && joinsMood('listen', clips[k])));
  // Thinking (waiting on her model, a minute or more through a heartbeat's tools): a look has only its
  // base loop and a look up for it, so she took turns with them and looked up every ten seconds (eleven
  // times in two minutes, 2026-10-11). Her calm facing clips join in, her base loop may play twice
  // running, and a look up or down comes at most every 30 seconds (below).
  if (want === 'think') fits = fits.concat(all.filter((k) => !fits.includes(k) && joinsMood('think', clips[k])));
  // Right after a pose change she stays put for at least one clip (no hand up-down-up fidgeting).
  const justMoved = after >= 0 && clips[after] && poseFrom(clips[after]) !== poseTo(clips[after]);
  let pool = fits.filter((k) => k !== after && !(justMoved && poseTo(clips[k]) !== pose));
  // Her home pose is where she spends most of her time. Aloy's is her hand down: her raised finger
  // looked odd held up most of the time, so it comes up now and then while she talks (about one clip
  // in eight; an expression raises it too) and rarely while she's quiet, and goes back down after a
  // clip or two. Her hand moves are idle clips, so while she talks they join the pool here.
  const home = p.alive.home || (clips.some((c) => poseFrom(c) === 'relaxed' && clipMoods(c).includes('talk')) ? 'relaxed' : 'main');
  const handMove = (k) => poseTo(clips[k]) !== pose && WAKING_POSES.has(poseTo(clips[k])) && !clipMoods(clips[k]).includes('change');
  if (want === 'talk' && !justMoved) pool.push(...all.filter((k) => handMove(k) && !pool.includes(k)));
  const stays = all.filter((k) => !goes(clips[k]));  // never off to a place or the empty glass by chance
  if (!pool.length) pool = fits.length ? fits : stays.filter((k) => k !== after);   // the only fitting clip may repeat
  if (!pool.length) pool = stays.length ? stays : [0];
  // The pose's main loop comes up twice as often as each other idle clip.
  const main = all.find((k) => poseTo(clips[k]) === pose && clipMoods(clips[k]).includes('talk'));
  // Quiet clips play like a shuffled deck: one that played lately waits until most of the others
  // have had their turn (pure chance brought some back within a minute and left others unseen).
  // Her main loop is exempt; it's her resting state.
  // Quiet and listening clips play like a shuffled deck (her main loop is exempt while she's quiet:
  // it's her resting state; while she faces him it takes its turn like the rest).
  const recent = (p.recentClips ||= []);
  const shuffled = want === 'idle' || want === 'listen';
  if (shuffled) {
    const fresh = pool.filter((k) => (want === 'idle' && k === main) || !recent.includes(k));
    if (fresh.length) pool = fresh;
  }
  const thinkLook = (k) => k !== main && clipMoods(clips[k]).includes('think') && !clipMoods(clips[k]).includes('talk');
  if (want === 'think') {
    const mainThinks = main !== undefined && (clipMoods(clips[main]).includes('think') || joinsMood('think', clips[main]));
    if (mainThinks && !pool.includes(main)) pool.push(main);
    if (performance.now() - (p.thoughtAt ?? -Infinity) < THINK_LOOK_GAP_MS) {
      const steady = pool.filter((k) => !thinkLook(k));
      if (steady.length) pool = steady;
    }
  }
  if (picture.active && p === portraits[current]) {
    const level = pool.filter((k) => !LOOKS_UP.test(clips[k].source || ''));
    if (level.length) pool = level;
  }
  // Late at night (10 pm to 6 am) the calm clips come up more and the laughs and teasing less.
  const night = hour >= 22 || hour < 6;
  const calmName = /longcalm|breath|daydream|hum|base|relaxed\.|loop|heartglow/;
  const livelyName = /amused|eyebrow|smirk|beat|glance|giggle|groove/;
  const weights = pool.map((k) => {
    let w = (want === 'idle' || want === 'think') && k === main ? 2 : 1;
    if (handMove(k)) w = pose === home ? (want === 'talk' ? 0.4 : 0.1) : (want === 'talk' ? 1.5 : 6);
    if (/longcalm/.test(clips[k].source || '')) w *= 2;
    if (breezy && clipMoods(clips[k]).includes('windy')) w *= 6; // on a windy day one every few minutes (the deck holds them back too)
    if (clipMoods(clips[k]).includes('yawn')) w *= justWoke ? 6 : 0.5;
    if (stage.on && portraits[current] !== p && /glance|scan|smile|beat|bright/.test(clips[k].source || '')) w *= 2;
    if (night && want === 'idle') w *= calmName.test(clips[k].source || '') ? 2 : livelyName.test(clips[k].source || '') ? 0.5 : 1;
    return w;
  });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let pick = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) { pick = pool[i]; break; } }
  if (want === 'talk' && handMove(pick)) (p.moments ||= new Set()).add(pick); // a gesture, at its own pace
  if (want === 'think' && thinkLook(pick)) p.thoughtAt = performance.now();
  if (shuffled && !(want === 'idle' && pick === main)) {
    recent.push(pick);
    // Remember most of the deck for the look she's in (an outfit's dozen, or her usual hundred).
    const deck = all.filter((k) => clipMoods(clips[k]).some((m) => m === 'idle' || m === 'listen')).length;
    while (recent.length > Math.max(1, Math.floor(deck * 0.7))) recent.shift();
  }
  return pick;
}

// When you start talking with her mid-glance (or mid-laugh), that clip plays out faster, so she
// turns back to you sooner; clips can only change where they meet the shared picture.
function hurryAlive(p) {
  const pl = p.players[p.active];
  if (pl.clip < 0) return;
  const fits = suits(p, pl.clip);
  // An expression waiting to play: move along a little faster to reach it.
  const waiting = !p.moments?.has(pl.clip) && ((p.emotion && wantedMood(p) !== 'talk' && p.alive.clips.some((c) => clipMoods(c).includes(p.emotion))) ||
                  Boolean(p.moments?.has(p.players[1 - p.active].clip)));
  // Woken from sleep: the sleep clip hurries along even more, so she's awake in a few seconds.
  const asleep = basePose(poseFrom(p.alive.clips[pl.clip])) === 'asleep' && basePose(poseTo(p.alive.clips[pl.clip])) === 'asleep';
  // At double speed an idle clip reads as frantic talking; 1.4x still brings her back soon.
  pl.video.playbackRate = !fits ? (asleep ? 2.5 : 1.4) : waiting ? 1.3 : (pl.baseRate || 1);
}

// Her loop in her home pose, to start from.
const homeLoop = (p) => Math.max(0, p.alive.clips.findIndex((c) => poseFrom(c) === (p.alive.home || 'main') &&
                                                            poseTo(c) === poseFrom(c) && clipMoods(c).includes('talk')));
// Back from the empty glass: on a quiet turn she walks on (or appears); any other way back (a reply,
// a button, the group stage) she's straight back in her home loop, no waiting for her to walk on.
function backOn(p, walk) {
  const clips = p.alive.clips, a = p.players[p.active];
  const on = walk ? clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === 'gone') : [];
  const k = on.length ? on[Math.floor(Math.random() * on.length)] : homeLoop(p);
  if (on.length) {
    if (isFull(poseTo(clips[k]))) p.cutFrom = p.alive.home || 'main';
    (p.moments ||= new Set()).add(k);
  }
  aliveLoad(p, a, k);
  aliveLoad(p, p.players[1 - p.active], nextClip(p, k));
}
const offGlass = (p) => p.players[p.active].clip >= 0 && poseTo(p.alive.clips[p.players[p.active].clip]) === 'gone';

function aliveStart(p) {
  const a = p.players[p.active];
  if (p.arrive || offGlass(p)) backOn(p, p.arrive);
  p.arrive = false;
  if (a.clip < 0) aliveLoad(p, a, 0);
  a.video.play().catch(videoError);
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
    // Her clip videos live only on this machine (not in git). One that can't be loaded (replaced or
    // removed by a build before the relaunch, a bad encode) is left out from then on and another
    // loads in its place; only several failures in a row show her still relief instead.
    pl.video.addEventListener('error', () => {
      if (!p.alive || pl.clip < 0) return;
      const bad = p.alive.clips[pl.clip];
      bad.bad = true;  // poseFrom() puts it nowhere, so nothing picks it again
      p.videoFails = (p.videoFails || 0) + 1;
      const left = p.alive.clips.filter((c) => !c.bad).length;
      if (p.videoFails >= 4 || !left) {
        post('error', { message: `${p.name}'s moving relief is unavailable (${pl.video.currentSrc || 'no source'}); showing her still relief` });
        p.alive = null;
        for (const q of p.players) q.video.pause();
        if (portraits[current] === p) applyPortrait(current);
        return;
      }
      post('error', { message: `${p.name}: clip ${bad.source || bad.file} can't be played; left out until the next launch` });
      const active = p.players[p.active] === pl;
      if (active) {  // the clip she was to play now: her base loop in that pose instead
        const loop = p.alive.clips.findIndex((c) => !c.bad && poseFrom(c) === (bad.from || 'main') && poseTo(c) === (bad.from || 'main') &&
                                                    clipMoods(c).includes('talk'));
        aliveLoad(p, pl, loop >= 0 ? loop : nextClip(p, -1));
        pl.video.play().catch(videoError);
      } else {
        aliveLoad(p, pl, nextClip(p, p.players[p.active].clip));
      }
    });
    pl.video.addEventListener('loadeddata', () => { p.videoFails = 0; });
    pl.video.addEventListener('ended', () => {
      if (idx !== p.active) return;
      // She has walked off for another Choom's turn: the glass is empty, so the turn passes now (the
      // fade has nothing to fade) and the next one walks on (aliveStart).
      if (p.leaving != null && wantedMood(p) !== 'idle') p.leaving = null;  // spoken to on her way out: she walks back on
      if (p.leaving != null && pl.clip >= 0 && poseTo(p.alive.clips[pl.clip]) === 'gone') {
        const to = p.leaving;
        p.leaving = null;
        portraits[to].arrive = canArrive(portraits[to]);
        switchTo(to);
        return;
      }
      const next = p.players[1 - idx];
      // The next clip was picked while it loaded; if she has started talking since, swap a laugh or
      // a long breath for a calm one (the last frame, the same picture, holds while it loads). A
      // moment swapped out this way is forgotten, or it would count as fitting any mood later.
      if (next.clip >= 0 && !suits(p, next.clip)) {
        p.moments?.delete(next.clip);
        aliveLoad(p, next, nextClip(p, pl.clip));
      }
      next.video.currentTime = 0;
      // A little variety so the rotation never settles into a beat: each clip plays at its own
      // speed, and between quiet clips the shared picture may rest a moment.
      next.video.playbackRate = 0.94 + Math.random() * 0.12;
      next.baseRate = next.video.playbackRate;
      // A clip in another framing (her full-body moves) can't join this picture: a camera cut,
      // her last frame fading out before the next clip starts (and back in on its first frame).
      const isCut = next.clip >= 0 && poseFrom(p.alive.clips[next.clip]) !== poseTo(p.alive.clips[pl.clip]);
      if (isCut && portraits[current] === p) cutFade = { t: 0, shown: false };
      const rest = isCut ? CUT_OUT_S * 1000 : wantedMood(p) === 'idle' ? Math.random() * 800 : 0;
      setTimeout(() => {
        // Not if she left the glass meanwhile (her players were paused).
        if (portraits[current] !== p && !stage.on && stage.mix === 0) return;
        next.video.play().catch(videoError);
      }, rest);
      // Hand over on the next clip's first frame; until then the last frame (the same picture) holds.
      next.video.requestVideoFrameCallback(() => {
        p.active = 1 - idx;
        p.aliveFrame = 0;
        p.moments?.delete(pl.clip); // that expression or tool moment has played
        const done = p.alive.clips[pl.clip];
        if (done) noteWorn(p, poseTo(done), done.frames / (p.alive.fps || 24) * 1000); // once per clip played
        if (clipMoods(p.alive.clips[next.clip]).includes('wake')) p.wokeAt = performance.now();
        if (portraits[current] === p) bindAliveTextures(p);
        else if (stage.mix > 0 || stage.on) bindStageSlot(portraits.indexOf(p));
        if (cutFade) cutFade.shown = true; // the new framing is on: fade back in
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
  const track = p.alive.clips[clip].mouth;
  const m = track[Math.min(p.aliveFrame, track.length - 1)]; // a clip jumped to by hand can start past the last frame
  const fu = frontMaterial.uniforms;
  // In a full-body move her face is small and turning: no lip sync there. Its track is empty, which
  // used to return before this and left the mouth on from the clip before (a mouth over a twirl).
  fu.mouthOn.value = isFull(poseFrom(p.alive.clips[clip])) || !m ? 0 : 1;
  if (!m) return;
  fu.mouthC.value.set(m[0], m[1]);
  fu.mouthSize.value.set(m[2], m[3], m[4]);
  fu.mouthTilt.value = m[5];
  fu.mouthGap.value = m[6] ?? 0;
  fu.mouthLift.value = m[7] ?? 0;
}

// ---- The group stage -------------------------------------------------------------------------
// When the Chooms talk in a group room, the ones in that room stand in the glass (two to four; all
// four when the room isn't known, as for "OK Chooms"): whoever is talking in front (the main
// portrait, with her voice, mouth, particles and name), her sisters smaller behind her and turned
// toward her. When the turn passes, the two trade places: the new speaker steps forward and
// the last one steps back into the spot she left. The stage stays up while the room talks and folds
// back to the one speaker a few minutes after it goes quiet, or as soon as Donny talks to one of
// them on her own.
const STAGE_FRONT = { x: 0, y: -0.22, z: 0, s: 0.68 };
const STAGE_BACK = [
  { x: -0.47, y: 0.16, z: -0.1, s: 0.42 },
  { x: 0, y: 0.42, z: -0.18, s: 0.36 },
  { x: 0.47, y: 0.16, z: -0.1, s: 0.42 },
];
// The places behind her, by how many sisters there are; a sister keeps her place when another joins.
// More than three (a fifth Choom made in the Studio): an arc behind her, smaller the more there are.
const STAGE_BACKS = { 1: [STAGE_BACK[0]], 2: [STAGE_BACK[0], STAGE_BACK[2]], 3: STAGE_BACK };
function stageBacks(n) {
  return (STAGE_BACKS[n] ||= Array.from({ length: n }, (_, k) => {
    const t = k / (n - 1), lift = Math.sin(Math.PI * t);  // 0 at the sides, 1 in the middle
    return { x: -0.55 + 1.1 * t, y: 0.14 + 0.26 * lift, z: -0.1 - 0.08 * lift, s: Math.max(0.26, 0.42 * 3 / n) };
  }));
}
const STAGE_LINGER_MS = 3 * 60 * 1000;
// members: the Chooms in the room (portrait indices), or null for all four.
const stage = { on: false, until: 0, mix: 0, place: [], shown: [], slots: [], members: null };

function stageSlot(j) {
  if (!stage.slots[j]) {
    const material = layerMaterial({ segX: 192, segY: 256, edgeThreshold: 0.35, useMask: true, own: true });
    material.uniforms.bottomFade.value = 0.5;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.0, 192, 256), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;  // behind the speaker, whatever their depth (frontMesh)
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

// ---- The campfire circle ----------------------------------------------------------------------
// After dark, or when one of them asks for the fire, the group stage becomes a campfire circle, laid
// out like Donny's photo of their camping trip: the Chooms in the room sit in an open arc on the far
// side of a fire, the middle seats facing you, the ends turned in, and the fire nearest you. Nobody
// changes seats when the turn passes: her sisters turn to whoever is talking (their listening clips),
// the firelight is brightest on her and the whole circle drifts a little toward her. Each sits in her
// own seat clips (her look "circle" or "circleside", see SEAT_LOOKS); if one in the room has none,
// the room keeps the standing stage.
const CIRCLE_FROM = setting('circleFrom', 19);    // after dark (local hour), until morningFrom
const CIRCLE_ASKED_MS = 60 * 60 * 1000;          // one of them asked for the fire: for the next hour
// Seats by how many sit, left to right on the glass (end seats are turned in; see circleArrange).
const CIRCLE_SEATS = {
  2: [{ x: -0.36, y: -0.12, z: 0, s: 0.62, end: true }, { x: 0.36, y: -0.12, z: 0, s: 0.62, end: true }],
  3: [{ x: -0.44, y: -0.16, z: 0.03, s: 0.54, end: true }, { x: 0, y: 0.08, z: -0.1, s: 0.48 },
      { x: 0.44, y: -0.16, z: 0.03, s: 0.54, end: true }],
  4: [{ x: -0.5, y: -0.2, z: 0.04, s: 0.5, end: true }, { x: -0.18, y: 0.08, z: -0.1, s: 0.44 },
      { x: 0.18, y: 0.08, z: -0.1, s: 0.44 }, { x: 0.5, y: -0.2, z: 0.04, s: 0.5, end: true }],
};
const FIRE_AT = { x: 0, y: -0.6, z: 0.1 };
// Who sits where, left to right on the glass: as in the photo (Aloy, Eve, Genesis), Optic between Eve and
// Genesis when all four sit. A Choom not listed sits after them.
const CIRCLE_ORDER = setting('circleOrder', ['aloy', 'eve', 'optic', 'genesis']);
// standIn (debug): Chooms without seats sit in their usual clips, to try the layout.
// folding: the room went quiet around the fire; her sisters stay hidden while the stage folds away.
const circle = { on: false, asked: 0, standIn: false, pan: 0, flicker: 1, dim: 0, shown: 0, folding: false };

// Her loop in a seat, if she has one (built from her Studio look of that name).
const seatLoop = (q, look) => (q.alive ? q.alive.clips.findIndex((c) => poseFrom(c) === look && poseTo(c) === look &&
                                                                        clipMoods(c).includes('talk')) : -1);
const canSit = (q) => SEAT_LOOKS.some((look) => seatLoop(q, look) >= 0);

// Whether the room sits around the fire: after dark, or asked for, and every Choom in it has a seat.
function circleWanted() {
  const ks = portraits.map((q, k) => k).filter((k) => !stage.members || stage.members.has(k));
  if (ks.length < 2 || !CIRCLE_SEATS[ks.length]) return false;
  if (circle.standIn) return true;
  if (!ks.every((k) => canSit(portraits[k]))) return false;
  const h = hourNow();
  return h >= CIRCLE_FROM || h < MORNING_FROM || performance.now() - circle.asked < CIRCLE_ASKED_MS;
}

// Everyone in the room to her seat, in CIRCLE_ORDER. An end
// seat takes her turned-in look, a middle seat her facing one, else whichever she has. The turned-in
// look faces the middle from the right; on the left half it's mirrored.
function circleArrange() {
  const rank = (k) => (CIRCLE_ORDER.includes(portraits[k].id) ? CIRCLE_ORDER.indexOf(portraits[k].id) : CIRCLE_ORDER.length + k);
  const ks = portraits.map((q, k) => k).filter((k) => !stage.members || stage.members.has(k)).sort((a, b) => rank(a) - rank(b));
  const seats = CIRCLE_SEATS[ks.length] || [];
  portraits.forEach((q, k) => {
    const n = ks.indexOf(k);
    if (n < 0 || !seats[n]) {
      stage.place[k] = null;
      q.seat = null;
      return;
    }
    const seat = seats[n];
    const order = seat.end ? ['circleside', 'circle'] : ['circle', 'circleside'];
    const look = circle.standIn && !canSit(q) ? null : order.find((l) => seatLoop(q, l) >= 0) || null;
    stage.place[k] = { ...seat, look, flip: look === 'circleside' && seat.x < 0 ? 1 : 0 };
    q.seat = look;
    if (k !== current) bindStageSlot(k);
  });
}

// Start her on a clip now (not when the one playing ends): into her seat, or back to her own poses.
function reseat(q) {
  const a = q.players[q.active];
  const k = nextClip(q, a.clip);
  aliveLoad(q, a, k);
  aliveLoad(q, q.players[1 - q.active], nextClip(q, k));
  q.aliveFrame = 0;
  a.video.play().catch(videoError);
  return a;
}

// The circle on or off (or rearranged, `again`, when someone joins): a camera cut. Everything fades
// out, everyone sits down (or gets up) and the glass fades back in on the new framing.
function circleSet(on, again = false) {
  if (on === circle.on && !again) return;
  const sat = portraits.filter((q) => q.seat);
  circle.on = on;
  circle.folding = !on && !stage.on;
  cutFade = { t: 0, shown: false };
  setTimeout(() => {
    if (circle.on) circleArrange();
    else {
      for (const q of portraits) q.seat = null;
      if (stage.on) {
        stage.place = [];
        stageArrange(current);
      }
    }
    // Seated or standing, nobody slides there: the new framing starts in place.
    portraits.forEach((q, k) => { if (stage.place[k]) stage.shown[k] = { ...stage.place[k] }; });
    let waiting = false;  // for her first frame in the new framing
    for (const q of new Set([...sat, ...portraits.filter((x) => x.seat)])) {
      if (!q.alive || !q.players) continue;
      const a = reseat(q);
      if (q === portraits[current]) {
        bindAliveTextures(q);
        followAliveMouth(q);
        waiting = true;
        a.video.requestVideoFrameCallback(() => { if (cutFade) cutFade.shown = true; });
      } else if (stage.place[portraits.indexOf(q)]) bindStageSlot(portraits.indexOf(q));
    }
    if (cutFade && !waiting) cutFade.shown = true;
  }, CUT_OUT_S * 1000);
  post('circle', { on, members: portraits.filter((q, k) => !stage.members || stage.members.has(k)).map((q) => q.name),
                   standIn: circle.standIn || undefined });
}

// What she plays in her seat: her talk loop on her turn; turned toward whoever is talking while a
// sister talks (a facing seat has a listening clip each way: listen_left, listen_right); else her
// loop, a quiet moment now and then (a laugh, a sip, a look into the fire).
function seatClip(p, after) {
  const clips = p.alive.clips, look = p.seat;
  const here = clips.map((c, k) => k).filter((k) => poseFrom(clips[k]) === look && poseTo(clips[k]) === look);
  if (!here.length) return -1;
  const pick = (ks) => {
    const fresh = ks.filter((k) => k !== after);
    return (fresh.length ? fresh : ks)[Math.floor(Math.random() * (fresh.length || ks.length))];
  };
  const src = (k) => clips[k].source || '';
  const listening = here.filter((k) => /listen/.test(src(k)));
  const loops = here.filter((k) => clipMoods(clips[k]).includes('talk') && !/listen/.test(src(k)));
  const moments = here.filter((k) => !listening.includes(k) && !loops.includes(k));
  const want = wantedMood(p);
  if (p === portraits[current]) {
    if (want === 'talk' || want === 'think' || want === 'listen' || !moments.length || Math.random() < 0.6) return pick(loops.length ? loops : here);
    return pick(moments);
  }
  if ((mood === 'speaking' || mood === 'thinking') && listening.length) {
    const me = stage.place[portraits.indexOf(p)], them = stage.place[current];
    let side = me && them ? (them.x < me.x ? 'left' : 'right') : null;  // on the glass
    if (side && me.flip) side = side === 'left' ? 'right' : 'left';     // in her mirrored picture
    const toward = listening.filter((k) => src(k).includes(`listen_${side}`));
    const either = listening.filter((k) => !/listen_(left|right)/.test(src(k)));
    if (toward.length || either.length) return pick(toward.length ? toward : either);
  }
  return pick(moments.length && Math.random() < 0.45 ? moments : loops.length ? loops : here);
}

// The fire, drawn by the glass (not a clip): flames from three crossed planes of rising noise, so it
// has body from every view, a warm pool of light under it, and sparks drifting up. Everyone around
// it flickers with it (circle.flicker).
const FLAME_FRAG = /* glsl */ `
    uniform float time, opacity, seed, flicker;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 q) {
      vec2 i = floor(q), f = fract(q);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    void main() {
      float y = vUv.y, x = (vUv.x - 0.5) * 2.0;
      // Rising turbulence bends the flames; slower noise tears tongues off their tops (the bed stays whole).
      float n1 = fbm(vec2(vUv.x * 4.0 + seed, y * 3.0 - time * 2.0));
      float n2 = fbm(vec2(vUv.x * 9.0 - seed, y * 6.5 - time * 3.3));
      float turb = 0.6 * n1 + 0.4 * n2;
      float tongues = fbm(vec2(vUv.x * 6.0 + seed * 2.0, y * 2.2 - time * 2.6));
      // Hottest low in the middle, cooling upward and outward.
      float spread = abs(x + (n1 - 0.5) * 0.9 * y) * (1.0 + 2.2 * y * y);
      float heat = (1.08 - 1.2 * y) - 1.1 * spread + (turb - 0.5) * (1.5 + 1.6 * y);
      heat -= smoothstep(0.25, 0.9, y) * (1.0 - tongues);
      heat = clamp(heat * 1.35, 0.0, 1.0) * smoothstep(0.0, 0.04, y);
      // Embers glowing in lumps at its foot.
      float lumps = vnoise(vec2(vUv.x * 14.0, time * 1.2 + 3.0));
      float ember = smoothstep(0.1, 0.0, y) * smoothstep(0.8, 0.3, abs(x)) * lumps * lumps * 1.6;
      // Mostly orange: deep red at the edges, yellow-white only at its heart.
      vec3 col = mix(vec3(0.45, 0.04, 0.0), vec3(1.0, 0.36, 0.03), smoothstep(0.05, 0.45, heat));
      col = mix(col, vec3(1.0, 0.68, 0.18), smoothstep(0.5, 0.85, heat));
      col = mix(col, vec3(1.0, 0.93, 0.7), smoothstep(0.88, 1.0, heat));
      col = col * pow(heat, 1.2) + vec3(0.9, 0.22, 0.03) * ember * (1.0 - heat);
      gl_FragColor = vec4(col * opacity * flicker, 1.0);
    }`;
const POOL_FRAG = /* glsl */ `
    uniform float opacity, flicker;
    varying vec2 vUv;
    void main() {
      vec2 d = (vUv - 0.5) * 2.0;  // -1..1 across the plane: nothing left at its edges
      float r = dot(d, d);
      float glow = exp(-3.5 * r) * (1.0 - smoothstep(0.55, 1.0, r));
      gl_FragColor = vec4(vec3(1.0, 0.45, 0.12) * glow * 0.33 * opacity * flicker, 1.0);
    }`;
const PLAIN_VERT = /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const fire = { group: new THREE.Group(), flames: [], mats: [] };
{
  const additive = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false };
  const pool = new THREE.ShaderMaterial({ uniforms: { opacity: { value: 0 }, flicker: { value: 1 } },
                                          vertexShader: PLAIN_VERT, fragmentShader: POOL_FRAG, ...additive });
  const poolMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.42), pool);
  poolMesh.position.set(0, 0.04, -0.06);
  fire.group.add(poolMesh);
  fire.mats.push(pool);
  for (let i = 0; i < 3; i++) {
    const m = new THREE.ShaderMaterial({ uniforms: { time: { value: 0 }, opacity: { value: 0 }, seed: { value: i * 3.7 }, flicker: { value: 1 } },
                                         vertexShader: PLAIN_VERT, fragmentShader: FLAME_FRAG, side: THREE.DoubleSide, ...additive });
    const flame = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.34), m);
    flame.position.y = 0.16;
    flame.rotation.y = (i * Math.PI) / 3;
    fire.group.add(flame);
    fire.mats.push(m);
  }
  // Sparks: each rises on its own cycle, swaying, and fades out as it goes (all in the shader).
  const SPARKS = 48;
  const seeds = new Float32Array(SPARKS * 3);
  for (let i = 0; i < SPARKS * 3; i++) seeds[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));
  const sparks = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, opacity: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float time;
      varying float vLife;
      void main() {
        vec3 s = position;                                  // three random numbers per spark
        float life = fract(time * (0.18 + 0.22 * s.x) + s.y);
        vec3 p = vec3((s.z - 0.5) * 0.12 + sin(time * (1.0 + s.x) + s.y * 6.28) * 0.03 * life,
                      0.08 + life * (0.55 + 0.3 * s.z),
                      (s.x - 0.5) * 0.1);
        vLife = life;
        gl_PointSize = mix(4.0, 1.5, life);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float opacity;
      varying float vLife;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r) * (1.0 - vLife) * smoothstep(0.0, 0.08, vLife);
        gl_FragColor = vec4(vec3(1.0, 0.55, 0.15) * a * opacity, 1.0);
      }`,
    ...additive,
  });
  const points = new THREE.Points(geo, sparks);
  points.frustumCulled = false;
  fire.group.add(points);
  fire.mats.push(sparks);
  fire.group.visible = false;
  scene.add(fire.group);
}

// Every frame: the fire burns while the circle is up, and the circle drifts toward whoever is talking.
function updateFire(dt) {
  const shown = circle.on ? ease(stage.mix) : 0;
  circle.shown = (circle.shown || 0) + (shown - (circle.shown || 0)) * Math.min(dt * 3, 1);
  fire.group.visible = circle.shown > 0.01;
  if (!fire.group.visible) return;
  const t = simTime;
  circle.flicker = 1 + 0.06 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 13.1 + 1.3) + 0.05 * Math.sin(t * 3.1 + Math.sin(t * 1.7));
  const seat = stage.place[current];
  const target = circle.on && seat ? -seat.x * 0.25 : 0;
  circle.pan += (target - circle.pan) * Math.min(dt * 0.8, 1);
  fire.group.position.set(FIRE_AT.x + circle.pan, FIRE_AT.y, FIRE_AT.z);
  for (const m of fire.mats) {
    m.uniforms.opacity.value = circle.shown * (1 - circle.dim);
    if (m.uniforms.time) m.uniforms.time.value = t;
    if (m.uniforms.flicker) m.uniforms.flicker.value = circle.flicker;
  }
}

// The Chooms in a room, from a group turn's member names (the Choom app sends them): the speaker
// always, and null (all four) when the event doesn't say.
function roomMembers(ev, i) {
  if (!Array.isArray(ev.room)) return null;
  const members = new Set(ev.room.map(choomIndex).filter((k) => k >= 0));
  if (i >= 0) members.add(i);
  return members.size ? members : null;
}

// Who stands where: the one in front, and the others in the room behind her, each keeping her place
// when she can. A Choom not in the room has none, and isn't drawn.
function stageArrange(front) {
  if (circle.on) return circleArrange();
  const back = portraits.map((q, k) => k).filter((k) => k !== front && (!stage.members || stage.members.has(k)));
  const free = back.length ? [...stageBacks(back.length)] : [];
  const kept = back.filter((k) => {
    const n = free.indexOf(stage.place[k]);
    if (n >= 0) free.splice(n, 1);
    return n >= 0;
  });
  portraits.forEach((q, k) => {
    if (k === front || kept.includes(k)) return;
    stage.place[k] = back.includes(k) ? free.shift() : null;
    if (stage.place[k]) {
      bindStageSlot(k);
      if (q.players && q.alive) aliveStart(q);
    }
  });
  stage.place[front] = STAGE_FRONT;
}

// The room starts talking: the Chooms in it take a place, the speaker (index i) in front.
function stageEnter(i, members = null) {
  stage.until = performance.now() + STAGE_LINGER_MS;
  if (stage.on) {
    // Already up ("OK Chooms" shows all four): the room's turn says who's in it.
    if (members && [...members].sort().join() !== [...(stage.members || [])].sort().join()) {
      stage.members = members;
      if (circle.on || circleWanted()) circleSet(circleWanted(), true);
      else stageArrange(current);
    }
    return;
  }
  stage.on = true;
  stage.members = members;
  for (const q of portraits) q.leaving = null;  // (one who walked off earlier is back on: aliveStart below)
  const front = i >= 0 ? i : current;
  // The one in front is the one on the glass (drawn last, over her sisters): Genesis stayed "on the
  // glass" from a back place while Optic stood in front, and was drawn over her.
  if (front !== current) {
    if (phase === 'out') pending = front;
    else {
      current = front;
      applyPortrait(front);
      labelT = 0;
      post('choom', { choom: portraits[front].name, stage: true });
    }
  }
  stage.place = [];
  stageArrange(front);
  portraits.forEach((q, k) => {
    if (!stage.place[k]) return;
    if (stage.mix === 0) stage.shown[k] = { ...stage.place[k] };
    bindStageSlot(k);
    if (q.players && q.alive) aliveStart(q);
  });
  orbGroup.visible = band.visible = false;
  post('stage', { on: true, front: portraits[front].name });
  if (circleWanted()) circleSet(true);
}

// The room is still talking (a room turn in the last two minutes): a Choom's 1:1 reply joins the stage
// rather than folding it away (it folded and came back with every turn when Genesis answered Donny
// while she and her sisters were talking in the room).
let lastGroupAt = -Infinity;
const roomActive = () => performance.now() - lastGroupAt < 120000;

function stageExit() {
  if (!stage.on) return;
  stage.on = false;
  post('stage', { on: false });
  circleSet(false);
}

// Every frame: the stage folds in or out, and everyone eases toward her place.
function updateStage(dt) {
  if (stage.on && performance.now() > stage.until && mood === 'idle' && !speech.busy && !speech.queue.length) stageExit();
  const was = stage.mix;
  stage.mix = Math.min(1, Math.max(0, stage.mix + (stage.on ? dt : -dt) / 1.4));
  if (stage.on || stage.mix === 0) circle.folding = false;
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
    if (!place) {
      if (stage.slots[j]) stage.slots[j].mesh.visible = false;
      if (j !== current && stage.shown[j] && portraits[j].players) for (const pl of portraits[j].players) pl.video.pause();
      delete stage.shown[j];
      return;
    }
    const at = (stage.shown[j] ||= { ...place });
    for (const key of ['x', 'y', 'z', 's']) at[key] += (place[key] - at[key]) * k;
    const slot = stage.slots[j];
    if (!slot) return;
    slot.mesh.visible = j !== current;
    if (!slot.mesh.visible) return;
    // Around the fire she sits still in her seat (no floating), the circle drifting with circle.pan.
    const seated = circle.on && place.look;
    slot.mesh.position.set(at.x + (circle.on ? circle.pan : 0), at.y + (seated ? 0 : Math.sin(simTime * 0.9 + j * 1.7) * 0.006), at.z);
    slot.mesh.scale.setScalar(0.94 * at.s);
    // Turned a little toward whoever is talking (less so while nobody is; seated, her clips turn her).
    const attentive = mood === 'idle' ? 0.5 : 1;
    const turn = circle.on ? 0.1 : 0.3;
    slot.mesh.rotation.y = Math.max(-turn, Math.min(turn, (front.x - at.x) * 0.65)) * attentive;
    const u = slot.material.uniforms;
    u.opacity.value = circle.folding ? 0 : m * (1 - circle.dim);
    // By the fire the light on her flickers with it, a little dimmer than on the one talking.
    u.glow.value = (circle.on ? 0.82 * circle.flicker : 0.72) * (1 - 0.45 * sleepAmt);
    u.depthScale.value = shared.depthScale.value * 0.8;
    u.flip.value = place.flip || 0;
    u.bottomFade.value = seated ? 0 : 0.5;  // a seat shows her whole figure
    u.sparkle.value = !seated && q.style === 'motes' ? 1 : 0;  // by the fire Genesis is herself, no motes
  });
}

function switchTo(i, force = false) {
  for (const q of portraits) q.leaving = null;  // a turn passed any other way: nobody walks off for it
  const next = (i + portraits.length) % portraits.length;
  if (next === current && phase !== 'out' && !force) return;
  // On the stage the turn passes without a fade: the two trade places. A Choom who isn't in the room
  // (a 1:1 reply while it talks) joins it; one who isn't in it steps out when she leaves the front.
  if (stage.on && stage.mix >= 1 && phase === 'idle' && next !== current) {
    const last = current;
    stage.members?.add(next);
    if (circle.on) {
      const joined = !stage.place[next];
      current = next;
      if (joined) circleSet(circleWanted(), true);
      if (stage.place[last]) bindStageSlot(last);
      applyPortrait(next);
      labelT = 0;
      post('choom', { choom: portraits[next].name, stage: true, circle: true });
      return;
    }
    stage.place[last] = stage.place[next];
    stage.place[next] = STAGE_FRONT;
    current = next;
    stageArrange(next);
    if (stage.place[last]) bindStageSlot(last);
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
    setListening(action === 'press');
  }
}

const events = new EventSource('/events');
events.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'button') onButton(ev.button, ev.action);
  if (ev.type === 'control') onControl(ev);
  if (ev.type === 'choom') onChoomEvent(ev);
  if (ev.type === 'presence') onPresence(ev);
  if (ev.type === 'gaze') onGaze(ev);
  if (ev.type === 'glass') onGlass(ev);
  if (ev.type === 'mute') setVoice(!ev.muted);  // the app's mute, replayed to a page that just started
  if (ev.type === 'feed' && ev.state === 'reconnected') {
    // The server's feed from the Mac dropped and came back: whatever ended meanwhile never arrived.
    unseenTurns.clear();
    closeTurn('the Mac feed reconnected');
  }
  if (ev.type === 'weather') {
    // The weather turns: Genesis, who loves it, glances up at the sky (if she's on the glass).
    const turned = weather.description && ev.description && ev.description !== weather.description;
    weather = ev;
    const p = portraits[current];  // (Genesis has them; any Choom given sky-check clips does it too)
    if (turned && p.alive?.clips.some((c) => /skycheck/.test(c.source || ''))) p.toolLook = /skycheck/;
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
  if (typeof ev.listening === 'boolean') setListening(ev.listening);
  if (typeof ev.voice === 'boolean') setVoice(ev.voice);
  if (typeof ev.body === 'boolean') setBody(ev.body);
  if (typeof ev.quilt === 'boolean') lkg.mode = ev.quilt ? 1 : 0; // debug: show the raw views
  if (typeof ev.view === 'number') { lkg.mode = 2; lkg.debugView = ev.view; } // debug: one view full screen
  if (ev.view === false) lkg.mode = 0;
  if (ev.weather && typeof ev.weather === 'object') weather = ev.weather; // debug: pretend weather
  if (typeof ev.hour === 'number' || ev.hour === null) debugHour = ev.hour;
  if (typeof ev.sleep === 'boolean') debugSleep = ev.sleep;
  if (ev.glassReset === true) for (const p of portraits) if (p.alive && wardrobe(p).chosen) { wardrobe(p).chosen = null; saveWardrobe(p); } // forget clothes they chose
  if (ev.activity === true) lastVoiceNearby = performance.now(); // someone talking near the tower (tower_ears)
  if (ev.chime === 'open' || ev.chime === 'close') chime(ev.chime);  // the tower's reply window
  if (typeof ev.gaze === 'boolean') onGaze({ looking: ev.gaze, face: true }); // debug: pretend he's looking
  if (typeof ev.mouthStyle === 'number') frontMaterial.uniforms.mouthStyle.value = ev.mouthStyle; // try a mouth
  if (typeof ev.jaw === 'number' || ev.jaw === null) debugJaw = ev.jaw; // hold the mouth open this far (null: off)
  if (ev.presence && typeof ev.presence === 'object') onPresence(ev.presence); // debug: pretend presence
  if (typeof ev.picture === 'string') showPicture(ev.picture, ev.kind || 'picture', portraits[current]); // debug: a gallery image id
  if (ev.stage === true) stageEnter(current, Array.isArray(ev.room) ? roomMembers(ev, current) : null); // debug: the group stage (room: names)
  if (ev.stage === false) stageExit();
  if (ev.circle === true) { // debug: the campfire circle now (room: names; standIn: seatless Chooms sit in their usual clips)
    circle.asked = performance.now();
    circle.standIn = ev.standIn === true;
    if (!stage.on) stageEnter(current, Array.isArray(ev.room) ? roomMembers(ev, current) : null);
    else circleSet(circleWanted(), true);
  }
  if (ev.circle === false) {
    circle.asked = 0;
    circle.standIn = false;
    circleSet(false);
  }
  if (ev.quietTurn) { // debug: a quiet turn now, to a Choom by name (or the next one)
    const k = portraits.findIndex((q) => q.id === String(ev.quietTurn).toLowerCase());
    if (k !== current) quietTurn(k >= 0 ? k : (current + 1) % portraits.length);
  }
  if (ev.closeTurn === true) closeTurn('debug');  // debug: as if the end of her turn never arrived
  if (ev.loseContext === true) renderer.getContext().getExtension('WEBGL_lose_context')?.loseContext(); // debug: the reload
  if (typeof ev.clip === 'number' && portraits[current].players) { // debug: jump to a moving relief clip
    const p = portraits[current];
    const pl = p.players[p.active];
    aliveLoad(p, pl, ev.clip % p.alive.clips.length);
    p.aliveFrame = 0;
    pl.video.play().catch(() => {});
  }
}

// ---- The Chooms asking the glass (server.py answers; tools/closet.py matches) ------------------
// A move she asked for plays at her next quiet moment on the glass, if that comes within half an hour
// (asleep, or off the glass for a while, it used to lapse after three minutes); clothes she chose she
// keeps until bedtime, or until she chooses again (day clothes chosen by day: until night-clothes time).
const MOVE_FRESH_MS = 30 * 60 * 1000;
function onGlass(ev) {
  const p = portraits.find((q) => q.id === String(ev.choom || '').toLowerCase());
  if (!p?.alive) return;
  // The campfire circle asked for: while the room is talking, everyone sits down around the fire (and
  // the next hour's group stage starts there). Not in a room, she goes to her own campfire if she has
  // one (the server sends it as a move).
  if (ev.circle && (stage.on || roomActive())) {
    circle.asked = performance.now();
    if (stage.on) circleSet(circleWanted());
    post('glass', { choom: p.id, circle: true, seated: circle.on });
    return;
  }
  if (Array.isArray(ev.move)) p.moveWanted = { sources: new Set(ev.move), until: performance.now() + MOVE_FRESH_MS };
  if ('wear' in ev) {
    const w = wardrobe(p);
    w.chosen = { o: ev.wear || null, at: Date.now() };
    saveWardrobe(p);
  }
  swapWaiting(p);
  post('glass', { choom: p.id, move: ev.name || null, wear: 'wear' in ev ? ev.wear || 'usual' : undefined });
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

// The tower's mic opening for his reply: a soft rising two-note chime (and a soft low note when it
// closes without hearing him), so he knows when it's his turn. Straight to the speakers, not through
// her voice's analyser (no glow, no lip movement).
function chime(kind) {
  if (!audioCtx) return;
  ensureAudio();
  const notes = kind === 'open' ? [[880, 0], [1318.5, 0.11]] : [[587.3, 0]];
  for (const [hz, at] of notes) {
    const t = audioCtx.currentTime + at;
    const osc = new OscillatorNode(audioCtx, { type: 'sine', frequency: hz });
    const gain = new GainNode(audioCtx, { gain: 0 });
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(kind === 'open' ? 0.16 : 0.09, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  }
  post('chime', { chime: kind });
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
  if (debugJaw !== null) frontMaterial.uniforms.mouthShape.value.set(debugJaw, 0, 0); // a held opening, to compare styles
  else frontMaterial.uniforms.mouthShape.value.set(mouthNow.jaw, mouthNow.round, mouthNow.wide);
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
// What a sentence she says feels like, for an expression clip once she's done. Plain word lists:
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
// From 11 pm to 5 am only coming home does: up for the kitchen and back to bed, or a minute at the
// desk, leaves her asleep (typing, talking and the buttons still wake her).
const MORNING_FROM = setting('morningFrom', 5);
function onPresence(next) {
  const was = presence;
  const pick = (role) => (role in next ? next[role] : presence[role]); // roles not reported stay as they were
  presence = { home: pick('home'), desk: pick('desk'), bed: pick('bed') };
  const night = hourNow() >= SLEEP_FROM || hourNow() < MORNING_FROM;
  const arrived = (was.home === false && presence.home === true) || (!night && was.desk === false && presence.desk === true);
  const gotUp = !night && was.bed === true && presence.bed === false;
  if (arrived || gotUp) lastActivity = performance.now();
  if (arrived && presence.bed !== true) {
    const p = portraits[current];
    if (p.alive?.clips.some((c) => clipMoods(c).includes('greet'))) p.greet = true;
    else if (p.alive) p.toolLook = /smile|bright/;
  }
  post('presence-seen', { ...presence, arrived, gotUp, night });
}
fetch('/status', { cache: 'no-store' }).then((r) => r.json()).then((st) => { if (st.presence) onPresence(st.presence); }).catch(() => {});

// The tower's eyes (tower_eyes.py): Donny looking at the glass. While he looks she keeps to her
// facing-you clips (a glance aside hurries back) and leans in a little, sometimes with a smile his
// way as he first looks; when he looks away she goes back to her own moments. The screensaver won't
// take her off the glass while he's looking at her.
function onGaze(ev) {
  const was = gaze.looking;
  gaze = { looking: ev.looking === true, face: ev.face === true };
  if (gaze.face) lastActivity = performance.now();
  const p = portraits[current];
  if (gaze.looking && !was && mood === 'idle' && p.alive && Math.random() < 0.35) p.toolLook = /smile|bright/;
  post('gaze-seen', gaze);
}

// Background turns (hourly heartbeats, delegated tasks) that start while the glass sleeps are left
// to run unseen: they would wake her, switch Chooms and have her doze off again every hour. A
// heartbeat that starts while Donny is in a conversation (the stage is up, someone is talking, or
// he talked with one of them in the last few minutes) runs unseen too: it took the front of the
// stage, floated her pictures in the middle of the room's talk, and pulled the glass back to her
// after each sister's reply.
const unseenTurns = new Set();
// Her own mishaps (a tool that failed, a picture that didn't come out right) get their own look, not
// her sad one: a wince, a frown at herself, an eye roll at the tool. Once, after she finishes talking,
// and not more than every two minutes.
const MISHAP_WORDS = /\b(didn['’]?t (come out|turn out|work)|not (quite )?(what|how) I (wanted|meant|pictured|hoped)|let me (try|redo|fix) (that|it|this)|try (that|it) again|that (failed|errored)|something went wrong|it (failed|errored|timed out)|oops|whoops|my bad|ugh)\b/i;
function mishap(p) {
  if (performance.now() - (p.lastMishap || -1e9) < 120000) return;
  p.lastMishap = performance.now();
  p.mishapPending = true;
}
const CONVERSATION_MS = 3 * 60 * 1000;
let lastConversation = -Infinity;  // the last chat or room event, or Donny typing or talking to them

function onChoomEvent(ev) {
  const i = choomIndex(ev.choom);
  if (lastTurn && lastTurn.index === i) lastTurn.at = performance.now(); // her turn is still alive
  const background = ev.source === 'heartbeat' || ev.source === 'delegation';
  if (ev.source === 'chat' || ev.source === 'group' || ev.event === 'listening') lastActivity = lastConversation = performance.now();
  if (background && ev.event === 'turn_start') {
    const talking = ev.source === 'heartbeat' && (stage.on || speech.busy || speech.queue.length > 0 ||
      performance.now() - lastConversation < CONVERSATION_MS);
    if (sleepy() || talking) unseenTurns.add(ev.choom);
    else unseenTurns.delete(ev.choom);
    if (talking) post('unseen', { choom: ev.choom, source: ev.source });
  }
  if (unseenTurns.has(ev.choom) && background && ev.event !== 'listening') {
    if (ev.event === 'turn_end' || ev.event === 'error') unseenTurns.delete(ev.choom);
    return;
  }
  if (ev.source === 'group') lastGroupAt = performance.now();
  if (stage.on && (ev.source === 'group' || (ev.event === 'listening' && ev.roomId))) stage.until = performance.now() + STAGE_LINGER_MS;
  if (stage.on && ev.event === 'listening' && ev.listening === true && ev.chatId && !ev.roomId && !roomActive()) stageExit();
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
    case 'tool_failed':
      // One of her own tools failed: a face at her own mishap, once she's done talking.
      if (i >= 0) mishap(portraits[i]);
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
      if (appListening && ev.tower && ev.group) {
        // "OK Chooms": the room. The stage comes up and all four listen.
        if (ev.wake && (speech.busy || speech.queue.length)) stopSpeech();
        stageEnter(current);
      } else if (appListening && ev.tower) {
        // "OK Eve" at the tower: she comes to the glass at once, even over someone talking.
        lastTyped = { chatId: null, choom: ev.choom, at: performance.now() };
        if (ev.wake && (speech.busy || speech.queue.length)) stopSpeech(); // "OK Eve" interrupts; a reply window never does
        stageExit();
        if (i >= 0 && i !== current) switchTo(i);
      } else if (appListening && !ev.roomId && i >= 0 && i !== current && mood === 'idle' && !speech.busy && !speech.queue.length) {
        switchTo(i); // typing or the mic in a chat brings her forward; in a room they all just listen
      }
      break;
    case 'turn_start':
      appListening = false; // he sent it: her turn now
      if (ev.source === 'group') stageEnter(i, roomMembers(ev, i));
      else if (ev.source === 'chat' && !roomActive()) stageExit(); // a 1:1 reply mid-room comes to the front instead
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
      lastTurn = { index: i, open: true, at: performance.now() };
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
      if (i >= 0 && texts.some((t) => MISHAP_WORDS.test(t))) mishap(portraits[i]);  // "that didn't come out right"
      if (voiceOn && ev.speak === true && i >= 0 && texts.length) {
        const c = clocks.get(ev.choom);
        if (c && !c.firstText) {
          c.firstText = performance.now();
          c.queuedBehind = speech.queue.length + (speech.busy ? 1 : 0);
        }
        for (const text of texts) {
          const first = !speech.busy && speech.queue.length === 0;
          for (const piece of speechPieces(text, first)) {
            speech.queue.push({ text: piece, voice: ev.voice || portraits[i].voice, index: i, clock: c, feeling: feeling(piece) });
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
      if (!speech.busy && !speech.queue.length) {
        mood = 'idle';
        feelSaid();
      }
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
        if (item.clock) {  // that piece is done with, or the turn's clock never finishes
          item.clock.pending--;
          finishClock(item.clock);
        }
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
      // What she's saying feels a certain way: that expression once her turn is over (feelSaid).
      if (item.feeling) portraits[item.index].saidFeeling = item.feeling;
      await play(audio);
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
    feelSaid();
  }
}

// Her turn is over and she has stopped talking: the feeling of the last thing she said that had one
// plays now, once. (While she talks it would fight her lip sync; between pieces of a reply still
// coming in she would be talking again a moment later.)
function feelSaid() {
  for (const p of portraits) {
    if (p.saidFeeling) {
      p.emotion ||= p.saidFeeling;
      swapWaiting(p); // the clip queued while she talked would hold it back several seconds
    }
    p.saidFeeling = null;
  }
}

// Something just became wanted (an expression, a move, clothes): choose the waiting clip again now,
// unless the hand-over to it is under way or an expression already waits there.
function swapWaiting(p) {
  const a = p.players?.[p.active], b = p.players?.[1 - p.active];
  if (p === portraits[current] && a && b && a.clip >= 0 && !a.video.ended && b.video.paused && !p.moments?.has(b.clip)) aliveLoad(p, b, nextClip(p, a.clip));
}

function setVoice(on) {
  voiceOn = on;
  if (!on) stopSpeech();
  sendStatus(); // tell the server right away so the voice hand-off follows without delay
}

function stopSpeech() {
  speech.epoch++;
  speech.queue.length = 0;
  for (const p of portraits) p.saidFeeling = null; // cut off: no reaction to words she didn't finish
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
// Keys that stay in effect until pressed again (pause, mute, body, depth, calibration) work only
// while the readout is up: the glass takes the keyboard when it launches, and one stray space typed
// for another window froze her particles, scan line and orbs for hours (2026-10-15).
const TUNING_KEYS = new Set(['Space', 'KeyM', 'KeyB', 'Minus', 'Equal', 'BracketLeft', 'BracketRight']);
window.addEventListener('keydown', (e) => {
  if (e.repeat && e.code !== 'KeyL') return;
  if (TUNING_KEYS.has(e.code) && !hudOn) return;
  switch (e.code) {
    case 'ArrowLeft': switchTo(current - 1); break;
    case 'ArrowRight': switchTo(current + 1); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9':
      if (Number(e.code.slice(-1)) <= portraits.length) switchTo(Number(e.code.slice(-1)) - 1);
      break;
    case 'KeyL': setListening(true); break;
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
  post('tuning', { key: e.code, depth: baseDepth.value, center: lkg.center, paused, choom: portraits[current].name });
  e.preventDefault();
});
window.addEventListener('keyup', (e) => { if (e.code === 'KeyL') setListening(false); });

const ease = (x) => x * x * (3 - 2 * x);
let frames = 0;
let fps = 0;
let fpsT = performance.now();
let last = performance.now();

for (const p of portraits) if (p.hasBody) bodyFor(p); // real bodies load up front
applyPortrait(current);

// 30 frames a second: the clips are 24 and her motion reads the same, while drawing all 48 views at the
// screen's 60 kept two of the NUC's cores busy (Chrome, and GNOME compositing it) around the clock.
const RENDER_FPS = 30;
let lastRender = 0;
renderer.setAnimationLoop((now) => {
  if (now - lastRender < 1000 / RENDER_FPS - 2) return;
  lastRender = now;
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
      // Around the fire she keeps her seat; one who wasn't in the room joins it (or, seatless, ends it).
      const joining = stage.on && circle.on && !stage.place[pending];
      if (joining) stage.members?.add(pending);
      if (stage.on && !circle.on && stage.place[pending] !== STAGE_FRONT) {
        stage.members?.add(pending);
        stage.place[current] = stage.place[pending];
        stage.place[pending] = STAGE_FRONT;
        stage.shown[pending] = { ...STAGE_FRONT };
      }
      current = pending;
      pending = null;
      if (joining) circleSet(circleWanted(), true);
      else if (stage.on) stageArrange(current);
      applyPortrait(current);
      phase = 'in';
      phaseT = 0;
      presence = 0;
    }
  } else if (phase === 'in') {
    presence = ease(Math.min(phaseT / 0.9, 1));
    if (phaseT >= 0.9) phase = 'idle';
  }

  listenAmt += ((heard() ? 1 : gaze.looking ? 0.35 : 0) - listenAmt) * Math.min(dt * 6, 1); // leans in a little when he looks
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
  updateFire(dt);
  const sm = ease(stage.mix);
  const front = stage.shown[current] || STAGE_FRONT;
  const seated = circle.on && stage.place[current]?.look;  // in her seat at the campfire circle
  portrait.rotation.y = Math.sin(simTime * tau / 9.0) * 0.045;
  portrait.position.x = (front.x + (circle.on ? circle.pan : 0)) * sm;
  portrait.position.y = Math.sin(simTime * tau / 6.5) * (seated ? 0.003 : 0.012) + front.y * sm;
  portrait.position.z = 0.06 * listenAmt + 0.025 * level + front.z * sm;
  portrait.scale.setScalar(0.94 * (1 + (front.s - 1) * sm));
  frontMaterial.uniforms.bottomFade.value = seated ? 0 : 0.22 * sm;
  frontMaterial.uniforms.flip.value = circle.on ? stage.place[current]?.flip || 0 : 0;
  frontMaterial.uniforms.sparkle.value = !seated && portraits[current].style === 'motes' ? 1 : 0;
  const breath = 1 + Math.sin(simTime * tau / 4.6) * 0.035;
  shared.depthScale.value = baseDepth.value * breath * (0.25 + 0.75 * presence);
  // A camera cut: fade out, hold dark until the new framing's first frame, fade in.
  let cutDim = 0;
  if (cutFade) {
    cutFade.t += dt;
    if (!cutFade.shown) cutDim = Math.min(cutFade.t / CUT_OUT_S, 1);
    else {
      cutFade.inT = (cutFade.inT || 0) + dt;
      cutDim = 1 - Math.min(cutFade.inT / CUT_IN_S, 1);
      if (cutDim === 0) cutFade = null;
    }
    if (cutFade && cutFade.t > 3) cutFade = null; // never stay dark if a clip fails to start
  }
  shared.opacity.value = presence * (1 - cutDim);
  circle.dim = circle.on || circle.shown > 0.01 ? cutDim : 0;  // the circle's own cuts dim everyone
  shared.glow.value = 1 + 0.22 * listenAmt + 0.3 * level + thinking * 0.06 * Math.sin(simTime * 3.2) + 0.2 * toolBoost;
  if (circle.shown > 0.01) shared.glow.value *= 1 + (circle.flicker - 1) * circle.shown;  // the firelight on her

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
  const asleepNow = curClip && (basePose(poseTo(curClip)) === 'asleep' || basePose(poseFrom(curClip)) === 'asleep') ? 1 : 0;
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
  // Her atom dims while she sleeps and steps aside in a full-body move, at a place or off the glass
  // (it's sized for her close-up).
  const wideNow = (pz) => isFull(pz) || isPlace(pz) || pz === 'gone';
  const fullNow = curClip && (wideNow(poseFrom(curClip)) || wideNow(poseTo(curClip))) ? 1 : 0;
  fullAmt += (fullNow - fullAmt) * Math.min(dt * 5, 1);
  if (orbGroup.visible) updateOrbs(presence * (1 - 0.6 * sleepAmt) * (1 - fullAmt));
  particleMaterial.uniforms.time.value = simTime;
  updateWeather(paused ? 0 : dt, simTime, presence * (1 - 0.7 * sleepAmt));
  particleMaterial.uniforms.opacity.value = presence * (0.85 + 0.4 * listenAmt + 0.5 * level) * (1 - (circle.shown || 0));  // the fire's sparks instead

  if (band.visible) {
    const cycle = style === 'scan' ? (bandT % 5) / 5 : 0.5 + 0.5 * Math.sin(bandT * tau / 9);
    // Eve's compile band sweeps from just below her crossed arms to just above her head and back
    // (picture heights measured on her moving relief: arms end at 0.09, her hair tops out at 0.92).
    const v = EVE_BAND[0] + cycle * (EVE_BAND[1] - EVE_BAND[0]);
    band.position.y = style === 'scan' ? 1 - cycle * 2 : (v - 0.5) * 2.0 * portrait.scale.y + portrait.position.y;
    const edgeFade = style === 'scan' ? Math.sin(cycle * Math.PI) : 1;
    bandMaterial.opacity = 0.75 * presence * edgeFade * (1 - fullAmt);
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
      hud.innerHTML = `LIVING PORTRAITS  ${fps} fps${paused ? '   <span class="warn">PAUSED (space)</span>' : ''}\nchoom ${portraits[current].name}   ${shown}\n` +
        (exact ? `window ${innerWidth}x${innerHeight} at ${screenX},${screenY}` :
          `<span class="warn">window ${innerWidth}x${innerHeight} at ${screenX},${screenY} NOT pixel-exact</span>`) +
        `\n← → or buttons: switch   hold L or bottom button: listen\nb body   m mute   - = depth   [ ] center   space pause   h hide`;
    }
  }
});

const windowInfo = () => ({
  exact: innerWidth === lkg.cal.screenW && innerHeight === lkg.cal.screenH && devicePixelRatio === 1,
  text: `${innerWidth}x${innerHeight} @${devicePixelRatio}x at ${screenX},${screenY}`,
});
post('start', { page: 'living', chooms: portraits.map((p) => p.name), window: windowInfo() });
function sendStatus() {
  const cp = portraits[current], pl = cp.players?.[cp.active];
  post('status', {
    page: 'living', fps, choom: cp.name, body: body ? body.url : null, listening: heard(), mood, voiceOn, paused,
    queued: speech.queue.length, window: windowInfo(), clip: cp.alive && pl?.clip >= 0 ? cp.alive.clips[pl.clip]?.source : null,
  });
}
setInterval(sendStatus, 2000);

// A turn whose end never arrived (the Mac feed dropped mid-turn) left her thinking for good: no sleep,
// no screensaver, the stage never folding. After 15 minutes without a word of it, or when the feed
// reconnects, the turn is closed (never while she's still talking).
const TURN_LOST_MS = 15 * 60 * 1000;
function closeTurn(why) {
  if (!lastTurn?.open || speech.busy || speech.queue.length) return;
  lastTurn.open = false;
  mood = 'idle';
  for (const p of portraits) p.saidFeeling = null;
  post('turn-closed', { why, choom: portraits[lastTurn.index]?.name || null });
}
setInterval(() => { if (lastTurn?.open && performance.now() - lastTurn.at > TURN_LOST_MS) closeTurn('no word of it for 15 minutes'); }, 30000);

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
  const here = portraits[current];
  // Walking off for a quiet turn: it passes once she's gone (the players' ended handler), or after 30 s
  // if she never got to it.
  if (here.leaving != null) {
    if (now - here.leavingAt > 30000) switchTo(here.leaving);
    return;
  }
  // Bedtime with a Choom on the glass who can't fall asleep (no sleep clips yet, a new one): the glass
  // goes to one who can, so it dims instead of staying lit and awake all night.
  if (sleepy() && !stage.on && phase === 'idle' && !canSleep(here)) {
    const sleepers = portraits.map((q, k) => k).filter((k) => k !== current && canSleep(portraits[k]));
    if (sleepers.length) {
      const next = sleepers[Math.floor(Math.random() * sleepers.length)];
      post('quiet-turn', { from: here.name, to: portraits[next].name, why: 'bedtime' });
      switchTo(next);
    }
    return;
  }
  if (!QUIET_BEFORE_MS || now - Math.max(lastActivity, lastVoiceNearby) < QUIET_BEFORE_MS || now - lastSwitchAt < turnLength) return;
  if (mood !== 'idle' || speech.busy || speech.queue.length || heard() || phase !== 'idle' || sleepy() || stage.on || gaze.looking) return;
  const clip = here.alive && here.players[here.active].clip >= 0 ? here.alive.clips[here.players[here.active].clip] : null;
  if ((clip && (basePose(poseFrom(clip)) === 'asleep' || basePose(poseTo(clip)) === 'asleep')) || now - (here.wokeAt || 0) < 3 * 60 * 1000) return;
  // At her campfire she has the glass until she gets up.
  if (here.stay) return;
  const others = portraits.map((q, k) => k).filter((k) => k !== current);
  const next = others[Math.floor(Math.random() * others.length)];
  if (now - (portraits[next].lastShown || 0) > 45 * 60 * 1000) portraits[next].greet = true;
  turnLength = TURN_MS[0] + Math.random() * (TURN_MS[1] - TURN_MS[0]);
  quietTurn(next);
}, 15000);

// A quiet turn: the one on the glass walks off (or vanishes) if she can from where she is, and the
// next walks on (or appears) if she can; either half without the other is a fade. /control
// {"quietTurn": "genesis"} tries one now.
const canArrive = (q) => Boolean(q.alive?.clips.some((c) => poseFrom(c) === 'gone'));
function quietTurn(next) {
  const here = portraits[current];
  const clip = here.alive && here.players[here.active].clip >= 0 ? here.alive.clips[here.players[here.active].clip] : null;
  const pose = clip ? poseTo(clip) : 'main';
  const canLeave = Boolean(here.alive?.clips.some((c) => poseTo(c) === 'gone' && (poseFrom(c) === pose || poseFrom(c) === fullOf(pose))));
  post('quiet-turn', { from: here.name, to: portraits[next].name, ...(canLeave ? { walkOff: true } : {}),
                       ...(canArrive(portraits[next]) ? { walkOn: true } : {}) });
  if (canLeave) {
    here.leaving = next;
    here.leavingAt = performance.now();
  } else {
    portraits[next].arrive = canArrive(portraits[next]);
    switchTo(next);
  }
}
