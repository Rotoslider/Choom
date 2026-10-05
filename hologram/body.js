// 3D bodies: a Choom as a rigged avatar (an Avaturn T2 GLB: Mixamo-style skeleton, ARKit and
// Oculus viseme blend shapes), drawn as light in her own colors. She breathes, blinks, glances
// around, leans in to listen, looks away to think, and lip syncs to HeadAudio's visemes.

import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from './vendor/addons/environments/RoomEnvironment.js';

// Framing in scene units: the panel shows y -1..1 and x -0.75..0.75 at the focal plane (z = 0).
// Her eyes sit on the focal plane, where the panel is sharpest, a little above the middle; depth
// is squashed so the back of her head doesn't blur.
const FRAME = { eyeY: 0.28, scale: 2.6, depth: 0.75 };

export const VISEMES = ['viseme_sil', 'viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD', 'viseme_kk',
  'viseme_CH', 'viseme_SS', 'viseme_nn', 'viseme_RR', 'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U'];

const ANIMATED = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder',
  'LeftEye', 'RightEye'];
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

const tau = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
// Smooth wandering in -1..1: a few unrelated sines.
const drift = (t, seed) => 0.6 * Math.sin(t * 0.37 + seed) + 0.3 * Math.sin(t * 0.91 + seed * 2.1)
  + 0.1 * Math.sin(t * 2.3 + seed * 3.7);

const gltfLoader = new GLTFLoader();
let environment = null;

export async function loadBody(url, renderer) {
  const gltf = await gltfLoader.loadAsync(url);
  if (!environment) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }
  return new ChoomBody(gltf.scene, url);
}

// Every material gets the same light treatment: lit from within so no part falls to black (black
// is see-through on the panel), a rim in her color, faint scan lines, her scan band passing over
// her, Genesis's twinkling motes, a fade toward the bottom of the frame like the reliefs' cut edge,
// and a build-up from below when she appears.
const STYLE_VERT_HEAD = /* glsl */ `
varying vec3 vBodyWorld;
varying vec3 vBodyLocal;`;
const STYLE_VERT = /* glsl */ `
vBodyLocal = position;
vBodyWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`;
const STYLE_FRAG_HEAD = /* glsl */ `
uniform float bPresence, bTime, bGlow, bSelf, bRim, bRimPower, bScan, bSparkle, bBandY, bBandOn;
uniform vec3 bRimColor, bAccent;
varying vec3 vBodyWorld;
varying vec3 vBodyLocal;
float bHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }`;
// Appearing, she builds up from the bottom of the frame through a ragged front; leaving, she
// dissolves back down.
const STYLE_FRAG_DISSOLVE = /* glsl */ `
float bFront = mix(-1.25, 1.1, bPresence) - bHash(floor(vBodyLocal * 160.0)) * 0.12;
float bEdge = bFront - vBodyWorld.y;
if (bPresence < 0.999 && bEdge < 0.0) discard;`;
const STYLE_FRAG = /* glsl */ `
{
  vec3 bc = gl_FragColor.rgb + diffuseColor.rgb * bSelf;
  bc *= bGlow;
  float bFacing = abs(dot(normalize(normal), normalize(vViewPosition)));
  bc += bRimColor * pow(1.0 - clamp(bFacing, 0.0, 1.0), bRimPower) * bRim;
  bc *= 1.0 - bScan * (0.5 + 0.5 * sin(vBodyWorld.y * 220.0 - bTime * 3.0));
  bc += bAccent * exp(-pow((vBodyWorld.y - bBandY) / 0.025, 2.0)) * bBandOn;
  bc *= smoothstep(-1.02, -0.62, vBodyWorld.y);
  if (bSparkle > 0.0) {
    vec3 bCell = floor(vBodyLocal * 350.0);
    float bTw = pow(max(0.0, sin(bTime * (1.0 + 2.0 * bHash(bCell + 17.0)) + bHash(bCell + 5.0) * 6.2831)), 8.0);
    bc += bRimColor * step(0.94, bHash(bCell)) * bTw * bSparkle * 1.5;
  }
  if (bPresence < 0.999) bc += bRimColor * (1.0 - smoothstep(0.0, 0.06, bEdge)) * 1.5;
  gl_FragColor.rgb = bc;
}`;

function stylize(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${STYLE_VERT_HEAD}`)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>\n${STYLE_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STYLE_FRAG_HEAD}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${STYLE_FRAG_DISSOLVE}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${STYLE_FRAG}`);
  };
  material.customProgramCacheKey = () => 'choom-body';
}

// Eve's wireframe: the same skinned meshes again as faint lines, brightest where her compile band
// is crossing. Nudged toward the camera so the lines win over the surface they lie on.
function wireMaterial(uniforms) {
  const m = new THREE.MeshBasicMaterial({
    wireframe: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${STYLE_VERT_HEAD}`)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>\n${STYLE_VERT}`)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\ngl_Position.z -= 0.0008 * gl_Position.w;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STYLE_FRAG_HEAD}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${STYLE_FRAG_DISSOLVE}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        float bBand = exp(-pow((vBodyWorld.y - bBandY) / 0.09, 2.0));
        gl_FragColor = vec4(bAccent * (0.07 + 0.9 * bBand) * bGlow, 1.0);`);
  };
  m.customProgramCacheKey = () => 'choom-body-wire';
  return m;
}

export class ChoomBody {
  constructor(model, url) {
    this.url = url;
    this.model = model;
    this.group = new THREE.Group();   // whole-body sway
    this.root = new THREE.Group();    // framing
    this.group.add(this.root);
    this.root.add(model);

    const find = (name) => model.getObjectByName(name) || model.getObjectByName(`mixamorig${name}`);
    model.updateMatrixWorld(true);
    this.poseArms(find);
    model.updateMatrixWorld(true);

    // Each animated bone keeps its rest pose and the model's x/y/z axes in its own frame, so
    // motion can be written as "turn the head about the model's y axis" whatever the rig's roll.
    this.bones = {};
    const q = new THREE.Quaternion();
    for (const name of ANIMATED) {
      const bone = find(name);
      if (!bone) continue;
      bone.getWorldQuaternion(q).invert();
      this.bones[name] = {
        bone,
        rest: bone.quaternion.clone(),
        axes: Object.fromEntries(Object.entries(AXES).map(([k, a]) => [k, a.clone().applyQuaternion(q)])),
        turn: { x: 0, y: 0, z: 0 },
      };
    }

    // Blend shapes by name across every mesh that has them (head, teeth, tongue, lashes...).
    this.morphs = new Map();
    this.uniforms = {
      bPresence: { value: 0 }, bTime: { value: 0 }, bGlow: { value: 1 }, bSelf: { value: 0.22 },
      bRim: { value: 1.2 }, bRimPower: { value: 2.4 }, bScan: { value: 0.07 }, bSparkle: { value: 0 },
      bBandY: { value: -5 }, bBandOn: { value: 0 },
      bRimColor: { value: new THREE.Color() }, bAccent: { value: new THREE.Color() },
    };
    this.wires = [];
    const wire = wireMaterial(this.uniforms);
    const meshes = [];
    model.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const mesh of meshes) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.envMap = environment;
        material.envMapIntensity = 0.6;
        stylize(material, this.uniforms);
      }
      if (mesh.morphTargetDictionary) {
        for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
          if (!this.morphs.has(name)) this.morphs.set(name, []);
          this.morphs.get(name).push([mesh, index]);
        }
      }
      if (mesh.isSkinnedMesh && !/eye|teeth|tongue|shoes/i.test(mesh.name)) {
        const w = new THREE.SkinnedMesh(mesh.geometry, wire);
        w.bind(mesh.skeleton, mesh.bindMatrix);
        w.morphTargetInfluences = mesh.morphTargetInfluences;
        w.morphTargetDictionary = mesh.morphTargetDictionary;
        w.position.copy(mesh.position);
        w.quaternion.copy(mesh.quaternion);
        w.scale.copy(mesh.scale);
        w.visible = false;
        mesh.parent.add(w);
        this.wires.push(w);
      }
    }

    // Lights: a soft key from the front, and her colors from behind as rim lights.
    this.key = new THREE.DirectionalLight(0xffffff, 1.1);
    this.key.position.set(0.6, 1.2, 2.5);
    this.rimA = new THREE.DirectionalLight(0xffffff, 2.5);
    this.rimA.position.set(-1.6, 0.9, -1.4);
    this.rimB = new THREE.DirectionalLight(0xffffff, 2.0);
    this.rimB.position.set(1.6, 0.4, -1.4);
    this.group.add(this.key, this.rimA, this.rimB);

    // Frame her by her eyes.
    const eyes = new THREE.Vector3();
    const l = find('LeftEye');
    const r = find('RightEye');
    if (l && r) {
      eyes.addVectors(l.getWorldPosition(new THREE.Vector3()), r.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    } else {
      find('Head').getWorldPosition(eyes).add(new THREE.Vector3(0, 0.08, 0.06));
    }
    const s = FRAME.scale;
    this.root.scale.set(s, s, s * FRAME.depth);
    this.root.position.set(-eyes.x * s, FRAME.eyeY - eyes.y * s, -eyes.z * s * FRAME.depth);

    this.morphNames = [...this.morphs.keys()];
    this.blinkStart = -1;
    this.nextBlink = rand(1, 4);
    this.nextGlance = 0;
    this.gaze = { x: 0, y: 0 };
    this.gazeTarget = { x: 0, y: 0 };
    this.thinkSide = 1;
    this.wasThinking = false;
    this.emphasis = 0;
  }

  // Avaturn exports a T-pose: lower the arms to her sides with a little bend at the elbows.
  poseArms(find) {
    const turn = (bone, axis, angle) => {
      if (!bone) return;
      const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      const world = bone.getWorldQuaternion(new THREE.Quaternion());
      const r = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      bone.quaternion.copy(parent.invert().multiply(r.multiply(world)));
      bone.updateMatrixWorld(true);
    };
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const arm = find(`${side}Arm`);
      if (!arm) continue;
      const down = arm.getWorldPosition(new THREE.Vector3());
      const elbow = find(`${side}ForeArm`)?.getWorldPosition(new THREE.Vector3());
      // Only if the arm is out sideways (a T- or A-pose); a relaxed export is left alone.
      if (elbow && Math.abs(elbow.y - down.y) < 0.6 * Math.abs(elbow.x - down.x)) {
        const angle = Math.atan2(elbow.y - down.y, Math.abs(elbow.x - down.x));
        turn(arm, AXES.z, -sign * (1.3 + angle));
        turn(arm, AXES.x, -0.12);
        turn(find(`${side}ForeArm`), AXES.x, -0.35);
      }
    }
  }

  setLook(p) {
    const u = this.uniforms;
    u.bRimColor.value.copy(p.tint);
    u.bAccent.value.copy(p.accent);
    u.bSparkle.value = p.style === 'motes' ? 1 : 0;
    u.bScan.value = p.style === 'scan' || p.style === 'code' ? 0.1 : 0.06;
    this.rimA.color.copy(p.tint);
    this.rimB.color.copy(p.accent);
    for (const w of this.wires) w.visible = p.style === 'code';
    this.style = p.style;
  }

  morph(name, value) {
    const targets = this.morphs.get(name);
    if (!targets) return;
    for (const [mesh, index] of targets) mesh.morphTargetInfluences[index] = value;
  }

  turn(name, axis, angle) {
    const b = this.bones[name];
    if (b) b.turn[axis] += angle;
  }

  // state: dt, time, presence 0..1, glow, level (voice loudness), listen 0..1, thinking and
  // speaking (booleans), visemes {viseme_xx: 0..1}, bandY/bandOn (her scan band, if any).
  update(st) {
    const { dt, time } = st;
    const u = this.uniforms;
    u.bPresence.value = st.presence;
    u.bTime.value = time;
    u.bGlow.value = st.glow;
    u.bBandY.value = st.bandY;
    u.bBandOn.value = st.bandOn ? 1.2 : 0;

    for (const b of Object.values(this.bones)) b.turn.x = b.turn.y = b.turn.z = 0;
    const thinking = st.thinking ? 1 : 0;
    const listen = st.listen;
    // Emphasis follows her voice slowly: a nod and lifted brows on stressed words, not every syllable.
    this.emphasis += ((st.speaking ? st.level : 0) - this.emphasis) * Math.min(dt * 4, 1);

    // Breathing, weight shift and sway.
    const breath = Math.sin(time * tau / 4.6);
    this.group.rotation.y = Math.sin(time * tau / 9.0) * 0.035;
    this.group.position.y = Math.sin(time * tau / 6.5) * 0.008;
    this.group.position.z = 0.05 * listen;
    this.turn('Spine1', 'x', -0.012 * breath);
    this.turn('Spine2', 'x', -0.01 * breath + 0.07 * listen + 0.02 * thinking);
    this.turn('Hips', 'z', 0.012 * drift(time * 0.5, 7));
    this.turn('LeftShoulder', 'z', 0.02 * breath);
    this.turn('RightShoulder', 'z', -0.02 * breath);

    // Head: wandering, livelier while she talks, tilted when she listens or thinks.
    const talk = st.speaking ? 1 : 0;
    const yaw = 0.06 * drift(time, 1) + 0.04 * talk * drift(time * 1.8, 4) + 0.1 * thinking * this.thinkSide;
    const pitch = 0.03 * drift(time, 2) + 0.07 * this.emphasis - 0.06 * thinking - 0.03 * listen;
    const roll = 0.03 * drift(time, 3) + 0.08 * listen + 0.05 * thinking * this.thinkSide;
    for (const [name, share] of [['Neck', 0.4], ['Head', 0.6]]) {
      this.turn(name, 'y', yaw * share);
      this.turn(name, 'x', pitch * share);
      this.turn(name, 'z', roll * share);
    }

    // Eyes: quick glances, held eye contact while talking or listening, a look up and away to
    // think. They counter the head's turn so her gaze stays on you.
    if (st.thinking && !this.wasThinking) this.thinkSide = Math.random() < 0.5 ? -1 : 1;
    this.wasThinking = st.thinking;
    if (time >= this.nextGlance) {
      if (st.thinking) {
        this.gazeTarget = { x: -0.15 + rand(-0.03, 0.03), y: 0.25 * this.thinkSide + rand(-0.05, 0.05) };
        this.nextGlance = time + rand(1.5, 3.5);
      } else {
        const range = st.speaking || listen > 0.5 ? 0.04 : 0.09;
        this.gazeTarget = Math.random() < 0.4 ? { x: 0, y: 0 } : { x: rand(-range, range) * 0.6, y: rand(-range, range) };
        this.nextGlance = time + rand(0.8, 3.2);
      }
    }
    const k = Math.min(dt * 28, 1);
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * k;
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * k;
    for (const eye of ['LeftEye', 'RightEye']) {
      this.turn(eye, 'x', this.gaze.x - pitch * 0.7);
      this.turn(eye, 'y', this.gaze.y - yaw * 0.7);
    }

    for (const b of Object.values(this.bones)) {
      const t = b.turn;
      const q = b.bone.quaternion.copy(b.rest);
      if (t.y) q.multiply(_q.setFromAxisAngle(b.axes.y, t.y));
      if (t.x) q.multiply(_q.setFromAxisAngle(b.axes.x, t.x));
      if (t.z) q.multiply(_q.setFromAxisAngle(b.axes.z, t.z));
    }

    // Blinks every few seconds, now and then a double.
    if (time >= this.nextBlink) {
      this.blinkStart = time;
      this.nextBlink = time + (Math.random() < 0.15 ? 0.35 : rand(2, 6));
    }
    const bt = time - this.blinkStart;
    const blink = bt < 0.07 ? bt / 0.07 : bt < 0.22 ? 1 - (bt - 0.07) / 0.15 : 0;
    const lookUp = Math.max(0, -this.gaze.x) * 1.5;
    this.morph('eyeBlinkLeft', Math.min(1, 0.12 + 0.88 * blink - 0.1 * listen));
    this.morph('eyeBlinkRight', Math.min(1, 0.12 + 0.88 * blink - 0.1 * listen));
    this.morph('eyeLookUpLeft', lookUp);
    this.morph('eyeLookUpRight', lookUp);
    this.morph('eyeWideLeft', 0.2 * listen);
    this.morph('eyeWideRight', 0.2 * listen);

    // Face: a friendly resting smile, brows that lift with emphasis and attention.
    this.morph('mouthSmileLeft', 0.14 + 0.12 * listen);
    this.morph('mouthSmileRight', 0.14 + 0.12 * listen);
    this.morph('browInnerUp', 0.25 * listen + 0.45 * this.emphasis + 0.2 * thinking);
    this.morph('browOuterUpLeft', 0.3 * this.emphasis + 0.1 * listen);
    this.morph('browOuterUpRight', 0.3 * this.emphasis + 0.1 * listen);
    this.morph('mouthPressLeft', 0.25 * thinking);
    this.morph('mouthPressRight', 0.25 * thinking);
    this.morph(this.thinkSide > 0 ? 'mouthLeft' : 'mouthRight', 0.12 * thinking);
    this.morph(this.thinkSide > 0 ? 'mouthRight' : 'mouthLeft', 0);

    // Lips.
    for (const name of VISEMES) this.morph(name, st.visemes[name] || 0);
  }
}

const _q = new THREE.Quaternion();
