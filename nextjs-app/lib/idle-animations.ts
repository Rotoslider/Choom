/**
 * Procedural idle animations for 3D avatar.
 *
 * Pure functions — no React dependencies. Each function takes the current
 * elapsed time and returns animation values.
 *
 * Animation layers:
 * - Blinking: random interval, quick close / slow open
 * - Breathing: subtle vertical oscillation
 * - Head micro-movement: Perlin noise on rotation
 * - Micro-saccades: tiny eye movements
 */

// ============================================================================
// Perlin Noise (2D, minimal implementation)
// ============================================================================

const PERM = new Uint8Array(512);
const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

// Initialize permutation table with deterministic seed
(function initNoise() {
  const p = Array.from({ length: 256 }, (_, i) => i);
  // Fisher-Yates with fixed seed
  let seed = 42;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807 + 0) % 2147483647;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) {
    PERM[i] = p[i & 255];
  }
})();

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

function dot2(g: number[], x: number, y: number): number {
  return g[0] * x + g[1] * y;
}

/**
 * 2D Perlin noise, returns value in roughly [-1, 1].
 */
export function noise2d(x: number, y: number): number {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);

  const aa = PERM[PERM[X] + Y] & 7;
  const ab = PERM[PERM[X] + Y + 1] & 7;
  const ba = PERM[PERM[X + 1] + Y] & 7;
  const bb = PERM[PERM[X + 1] + Y + 1] & 7;

  const x1 = lerp(dot2(GRAD[aa], xf, yf), dot2(GRAD[ba], xf - 1, yf), u);
  const x2 = lerp(dot2(GRAD[ab], xf, yf - 1), dot2(GRAD[bb], xf - 1, yf - 1), u);

  return lerp(x1, x2, v);
}

// ============================================================================
// Blink Animation
// ============================================================================

// Blink state (stateful for random timing)
let nextBlinkTime = 2 + Math.random() * 3; // seconds
let blinkPhase = 0; // 0 = idle, 1 = closing, 2 = opening
let blinkStartTime = 0;

const BLINK_CLOSE_DURATION = 0.06;  // seconds
const BLINK_OPEN_DURATION = 0.12;   // seconds
const BLINK_MIN_INTERVAL = 2;
const BLINK_MAX_INTERVAL = 6;

/**
 * Compute blink weight (0 = open, 1 = closed).
 */
export function computeBlink(time: number): number {
  if (blinkPhase === 0) {
    // Waiting for next blink
    if (time >= nextBlinkTime) {
      blinkPhase = 1;
      blinkStartTime = time;
    }
    return 0;
  }

  const elapsed = time - blinkStartTime;

  if (blinkPhase === 1) {
    // Closing
    if (elapsed >= BLINK_CLOSE_DURATION) {
      blinkPhase = 2;
      return 1;
    }
    return elapsed / BLINK_CLOSE_DURATION;
  }

  if (blinkPhase === 2) {
    // Opening
    const openElapsed = elapsed - BLINK_CLOSE_DURATION;
    if (openElapsed >= BLINK_OPEN_DURATION) {
      blinkPhase = 0;
      nextBlinkTime = time + BLINK_MIN_INTERVAL + Math.random() * (BLINK_MAX_INTERVAL - BLINK_MIN_INTERVAL);
      return 0;
    }
    return 1 - openElapsed / BLINK_OPEN_DURATION;
  }

  return 0;
}

/**
 * Reset blink state (e.g., when switching avatars).
 */
export function resetBlink(): void {
  blinkPhase = 0;
  nextBlinkTime = 2 + Math.random() * 3;
}

// ============================================================================
// Breathing Animation
// ============================================================================

const BREATHING_PERIOD = 4.0;    // seconds per breath cycle
const BREATHING_AMPLITUDE = 0.002; // very subtle vertical scale

/**
 * Compute breathing offset (subtle Y-axis oscillation).
 */
export function computeBreathing(time: number): number {
  return Math.sin((time / BREATHING_PERIOD) * Math.PI * 2) * BREATHING_AMPLITUDE;
}

// ============================================================================
// Head Micro-Movement
// ============================================================================

const HEAD_AMPLITUDE = 0.025; // radians (~1.5 degrees)
const HEAD_FREQUENCY = 0.3;   // Hz

/**
 * Compute head rotation offsets from Perlin noise.
 * Returns Euler angles in radians { x, y, z }.
 */
export function computeHeadMovement(
  time: number,
  intensity: number = 1.0
): { x: number; y: number; z: number } {
  const t = time * HEAD_FREQUENCY;
  const amp = HEAD_AMPLITUDE * intensity;

  return {
    x: noise2d(t, 0.0) * amp,        // nod
    y: noise2d(0.0, t + 100) * amp,  // turn
    z: noise2d(t + 200, t) * amp * 0.5, // tilt (less)
  };
}

// ============================================================================
// Micro-Saccades (Eye Movement)
// ============================================================================

let nextSaccadeTime = 1 + Math.random() * 2;
let saccadeTarget = { x: 0, y: 0 };
let saccadeCurrent = { x: 0, y: 0 };

const SACCADE_AMPLITUDE = 0.02; // radians (~1 degree)
const SACCADE_MIN_INTERVAL = 1;
const SACCADE_MAX_INTERVAL = 3;
const SACCADE_SPEED = 8; // lerp speed

/**
 * Compute micro-saccade eye offsets.
 * Returns { x, y } in radians for eye rotation.
 */
export function computeMicroSaccades(
  time: number,
  deltaTime: number
): { x: number; y: number } {
  if (time >= nextSaccadeTime) {
    saccadeTarget = {
      x: (Math.random() - 0.5) * 2 * SACCADE_AMPLITUDE,
      y: (Math.random() - 0.5) * 2 * SACCADE_AMPLITUDE,
    };
    nextSaccadeTime = time + SACCADE_MIN_INTERVAL +
      Math.random() * (SACCADE_MAX_INTERVAL - SACCADE_MIN_INTERVAL);
  }

  // Smooth interpolation toward target
  const t = 1 - Math.exp(-SACCADE_SPEED * deltaTime);
  saccadeCurrent.x += (saccadeTarget.x - saccadeCurrent.x) * t;
  saccadeCurrent.y += (saccadeTarget.y - saccadeCurrent.y) * t;

  return { ...saccadeCurrent };
}

/**
 * Reset all idle animation state.
 */
export function resetIdleAnimations(): void {
  resetBlink();
  nextSaccadeTime = 1 + Math.random() * 2;
  saccadeTarget = { x: 0, y: 0 };
  saccadeCurrent = { x: 0, y: 0 };
}
