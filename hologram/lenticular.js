// Quilt renderer + lenticular interleave for a Looking Glass display, driven directly by the
// device's visual.json calibration (no Looking Glass Bridge needed).
//
// Math follows Looking Glass's own sources: the classic HoloPlay fragment shader
// (LookingGlassCoreSDK HoloPlayShaders.h) and the per-view off-axis camera rig in
// @lookingglass/webxr (LookingGlassXRDevice.ts / LookingGlassConfig.ts).

import * as THREE from './vendor/three.module.js';

// Turn raw visual.json values into the uniforms the interleave shader needs.
export function deriveCalibration(cal) {
  const v = (key, fallback = 0) => (cal[key] && typeof cal[key].value === 'number' ? cal[key].value : fallback);
  const flipX = v('flipImageX') ? -1 : 1;
  const slope = v('slope');
  return {
    serial: cal.serial || 'unknown',
    screenW: v('screenW'),
    screenH: v('screenH'),
    pitch: v('pitch') * v('screenW') / v('DPI') * Math.cos(Math.atan(1 / slope)),
    tilt: v('screenH') / (v('screenW') * slope) * flipX,
    subp: 1 / (v('screenW') * 3) * flipX,
    center: v('center'),
    invView: v('invView') ? 1 : 0,
    flipSubp: v('flipSubp') ? 1 : 0,
    viewConeDeg: v('viewCone', 40),
  };
}

const INTERLEAVE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const INTERLEAVE_FRAG = /* glsl */ `
uniform sampler2D quilt;
uniform float pitch;
uniform float tilt;
uniform float center;
uniform float subp;
uniform int invView;
uniform int flipSubp;
uniform vec3 tile;        // cols, rows, number of views
uniform vec2 viewPortion; // fraction of the quilt texture the tiles fill
uniform int mode;         // 0 = lenticular, 1 = raw quilt, 2 = one view full screen (debug)
uniform float debugView;
varying vec2 vUv;

vec2 texArr(vec3 uvz) {
  float x = (mod(uvz.z, tile.x) + uvz.x) / tile.x;
  float y = (floor(uvz.z / tile.x) + uvz.y) / tile.y;
  return vec2(x, y) * viewPortion;
}

vec4 sampleView(float u, float v, float subpixel) {
  float z = (u + subpixel * subp + v * tilt) * pitch - center;
  z = fract(z);
  if (invView == 1) z = 1.0 - z;
  z *= tile.z;
  float z1 = floor(z);
  float z2 = min(z1 + 1.0, tile.z - 1.0);
  float vy = clamp(v, 0.005, 0.995);
  vec4 c1 = texture2D(quilt, texArr(vec3(u, vy, z1)));
  vec4 c2 = texture2D(quilt, texArr(vec3(u, vy, z2)));
  return mix(c1, c2, z - z1);
}

void main() {
  if (mode == 1) {
    gl_FragColor = linearToOutputTexel(texture2D(quilt, vUv));
    return;
  }
  if (mode == 2) {
    gl_FragColor = linearToOutputTexel(texture2D(quilt, texArr(vec3(vUv, debugView))));
    return;
  }
  vec4 s0 = sampleView(vUv.x, vUv.y, 0.0);
  vec4 s1 = sampleView(vUv.x, vUv.y, 1.0);
  vec4 s2 = sampleView(vUv.x, vUv.y, 2.0);
  float r = flipSubp == 1 ? s2.r : s0.r;
  float b = flipSubp == 1 ? s0.b : s2.b;
  gl_FragColor = linearToOutputTexel(vec4(r, s1.g, b, 1.0));
}`;

export class LookingGlassRenderer {
  constructor({ canvas, calibration, cols = 8, rows = 6, quiltWidth = 3360, quiltHeight = 3360, samples = 4 }) {
    this.cal = deriveCalibration(calibration);
    this.cols = cols;
    this.rows = rows;
    this.numViews = cols * rows;
    this.tileW = Math.floor(quiltWidth / cols);
    this.tileH = Math.floor(quiltHeight / rows);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.cal.screenW, this.cal.screenH, false);

    // sRGB storage keeps 8-bit darks smooth; the GPU converts on write and on read.
    const rtOptions = {
      colorSpace: THREE.SRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    };
    this.quilt = new THREE.WebGLRenderTarget(quiltWidth, quiltHeight, rtOptions);
    // Each view renders into one small multisampled tile, then gets copied into the quilt.
    // Multisampling the whole quilt would resolve all 3360x3360 pixels after every view.
    this.tileTarget = new THREE.WebGLRenderTarget(this.tileW, this.tileH, { ...rtOptions, samples });
    this.copyMaterial = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }',
      uniforms: { map: { value: this.tileTarget.texture } },
      depthTest: false,
      depthWrite: false,
    });
    this.copyScene = new THREE.Scene();
    this.copyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial));

    // Tunables, exposed so a test page can adjust them live.
    this.center = this.cal.center;
    this.invView = this.cal.invView;
    this.depthiness = 1.0;     // multiplies the calibrated view cone
    this.fovyDeg = 14;         // narrow lens keeps depth comfortable on the panel
    this.targetDiam = 2.0;     // scene units visible vertically at the focal plane
    this.mode = 0;

    this.viewCamera = new THREE.PerspectiveCamera();
    this.viewCamera.matrixAutoUpdate = true;

    this.material = new THREE.ShaderMaterial({
      vertexShader: INTERLEAVE_VERT,
      fragmentShader: INTERLEAVE_FRAG,
      uniforms: {
        quilt: { value: this.quilt.texture },
        pitch: { value: this.cal.pitch },
        tilt: { value: this.cal.tilt },
        center: { value: this.center },
        subp: { value: this.cal.subp },
        invView: { value: this.invView },
        flipSubp: { value: this.cal.flipSubp },
        tile: { value: new THREE.Vector3(cols, rows, this.numViews) },
        viewPortion: { value: new THREE.Vector2((this.tileW * cols) / quiltWidth, (this.tileH * rows) / quiltHeight) },
        mode: { value: 0 },
        debugView: { value: 24 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.screenScene = new THREE.Scene();
    this.screenScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    this.screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  get focalDistance() {
    return (0.5 * this.targetDiam) / Math.tan(THREE.MathUtils.degToRad(this.fovyDeg) / 2);
  }

  // Place the shared camera for view i (0 = leftmost) looking at `target` from +Z.
  setViewCamera(i, target = new THREE.Vector3()) {
    const cam = this.viewCamera;
    const tanHalfFovy = Math.tan(THREE.MathUtils.degToRad(this.fovyDeg) / 2);
    const focal = this.focalDistance;
    const cone = THREE.MathUtils.degToRad(this.cal.viewConeDeg * this.depthiness);
    const tanAngle = Math.tan(cone * ((i + 0.5) / this.numViews - 0.5));
    const offset = focal * tanAngle;

    cam.position.set(target.x + offset, target.y, target.z + focal);
    cam.quaternion.identity();
    cam.updateMatrixWorld(true);

    const near = Math.max(focal - 3 * this.targetDiam, 0.05);
    const far = focal + 4 * this.targetDiam;
    const halfY = near * tanHalfFovy;
    const halfX = halfY * (this.tileW / this.tileH);
    const midX = near * -tanAngle; // shear so every view shares the same focal plane
    cam.near = near;
    cam.far = far;
    cam.projectionMatrix.makePerspective(midX - halfX, midX + halfX, halfY, -halfY, near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    return cam;
  }

  // Render every view of `scene` into the quilt. `perView(i, camera)` may tweak things per view.
  renderQuilt(scene, { target, perView } = {}) {
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    this.quilt.scissorTest = true;
    for (let i = 0; i < this.numViews; i++) {
      const cam = this.setViewCamera(i, target);
      if (perView) perView(i, cam);
      r.autoClear = true;
      r.setRenderTarget(this.tileTarget);
      r.render(scene, cam);

      const x = (i % this.cols) * this.tileW;
      const y = Math.floor(i / this.cols) * this.tileH;
      this.quilt.viewport.set(x, y, this.tileW, this.tileH);
      this.quilt.scissor.set(x, y, this.tileW, this.tileH);
      r.autoClear = false;
      r.setRenderTarget(this.quilt);
      r.render(this.copyScene, this.screenCamera);
    }
    this.quilt.scissorTest = false;
    r.autoClear = prevAutoClear;
  }

  // Fill each view with its own flat color: the standard check that view order and calibration line up.
  renderViewTest() {
    const r = this.renderer;
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const c = new THREE.Color();
    r.setRenderTarget(this.quilt);
    this.quilt.scissorTest = true;
    for (let i = 0; i < this.numViews; i++) {
      const x = (i % this.cols) * this.tileW;
      const y = Math.floor(i / this.cols) * this.tileH;
      this.quilt.viewport.set(x, y, this.tileW, this.tileH);
      this.quilt.scissor.set(x, y, this.tileW, this.tileH);
      r.setRenderTarget(this.quilt);
      c.setHSL((i / this.numViews) * 0.85, 1, 0.5);
      r.setClearColor(c, 1);
      r.clear(true, true, true);
    }
    this.quilt.scissorTest = false;
    r.setClearColor(prevColor, prevAlpha);
  }

  // Interleave the quilt onto the panel.
  present() {
    const u = this.material.uniforms;
    u.center.value = this.center;
    u.invView.value = this.invView;
    u.mode.value = this.mode;
    u.debugView.value = this.debugView ?? 24;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.screenScene, this.screenCamera);
  }
}
