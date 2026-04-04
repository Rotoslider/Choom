/**
 * Client-side audio → viseme analysis using Web Audio API.
 *
 * Decodes base64 WAV audio and analyzes at 30fps to produce a VisemeTimeline
 * mapping audio features to viseme morph target weights.
 *
 * Features extracted:
 * - RMS amplitude → jaw openness / mouth height
 * - Spectral centroid → bright vs dark vowels
 * - Zero-crossing rate → fricatives vs stops
 */

import type { VisemeFrame, VisemeTimeline } from './types';

// Singleton AudioContext (browsers limit number of contexts)
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

// Analysis parameters
const FRAME_RATE = 30; // Analyze at 30fps
const SMOOTHING = 0.3; // Exponential moving average alpha

/**
 * Analyze a base64-encoded WAV and produce a viseme timeline.
 */
export async function analyzeAudioForVisemes(
  base64Wav: string
): Promise<VisemeTimeline> {
  const ctx = getAudioContext();

  // Decode base64 to ArrayBuffer
  const binaryString = atob(base64Wav);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Decode audio
  const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
  const channelData = audioBuffer.getChannelData(0); // Mono or first channel
  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;

  const frameDuration = 1 / FRAME_RATE;
  const samplesPerFrame = Math.floor(sampleRate / FRAME_RATE);
  const numFrames = Math.ceil(duration * FRAME_RATE);

  const timeline: VisemeTimeline = [];
  let prevWeights: Record<string, number> = {};

  for (let frame = 0; frame < numFrames; frame++) {
    const startSample = frame * samplesPerFrame;
    const endSample = Math.min(startSample + samplesPerFrame, channelData.length);
    const frameData = channelData.slice(startSample, endSample);

    if (frameData.length === 0) break;

    // Extract audio features
    const rms = computeRMS(frameData);
    const spectralCentroid = computeSpectralCentroid(frameData, sampleRate);
    const zcr = computeZeroCrossingRate(frameData);

    // Map features to viseme weights
    const rawWeights = mapFeaturesToVisemes(rms, spectralCentroid, zcr);

    // Apply smoothing (EMA)
    const smoothedWeights: Record<string, number> = {};
    for (const [name, weight] of Object.entries(rawWeights)) {
      const prev = prevWeights[name] || 0;
      smoothedWeights[name] = prev + SMOOTHING * (weight - prev);
    }
    prevWeights = smoothedWeights;

    timeline.push({
      time: frame * frameDuration,
      weights: { ...smoothedWeights },
    });
  }

  return timeline;
}

/**
 * Compute RMS (root mean square) amplitude of audio frame.
 */
function computeRMS(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length);
}

/**
 * Estimate spectral centroid (brightness of sound).
 * Higher = brighter (ee, eh), Lower = darker (oo, ah).
 */
function computeSpectralCentroid(data: Float32Array, sampleRate: number): number {
  // Simple DFT-free estimation using zero-crossing rate correlation
  // True spectral centroid would need FFT, but this approximation works for visemes
  const zcr = computeZeroCrossingRate(data);
  // ZCR correlates roughly with spectral centroid
  // Normalize to 0-1 range (typical speech ZCR: 0.02-0.3)
  return Math.min(1, Math.max(0, (zcr - 0.02) / 0.28));
}

/**
 * Compute zero-crossing rate (fricatives have high ZCR).
 */
function computeZeroCrossingRate(data: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i] >= 0 && data[i - 1] < 0) || (data[i] < 0 && data[i - 1] >= 0)) {
      crossings++;
    }
  }
  return crossings / data.length;
}

/**
 * Map audio features to viseme blend weights.
 *
 * The mapping is inspired by the Oculus viseme set:
 * - Amplitude drives mouth openness
 * - Spectral centroid differentiates vowel shapes
 * - ZCR detects fricatives/sibilants
 */
function mapFeaturesToVisemes(
  rms: number,
  spectralCentroid: number,
  zcr: number
): Record<string, number> {
  const weights: Record<string, number> = {};

  // Normalize RMS (typical speech RMS: 0.01-0.3)
  const amplitude = Math.min(1, rms / 0.15);

  // Silence threshold
  if (amplitude < 0.05) {
    weights['viseme_sil'] = 1.0;
    return weights;
  }

  // Fricatives (high ZCR, low amplitude) — s, f, sh, z
  const fricative = Math.min(1, Math.max(0, zcr - 0.15) / 0.15) * (1 - amplitude * 0.5);
  if (fricative > 0.3) {
    if (spectralCentroid > 0.6) {
      weights['viseme_SS'] = fricative * 0.8;
      weights['viseme_FF'] = fricative * 0.3;
    } else {
      weights['viseme_CH'] = fricative * 0.6;
      weights['viseme_FF'] = fricative * 0.4;
    }
  }

  // Vowels (amplitude-driven, centroid shapes)
  const vowelStrength = amplitude * (1 - fricative * 0.5);

  if (vowelStrength > 0.1) {
    if (spectralCentroid > 0.65) {
      // Bright vowels: ee, eh
      weights['viseme_I'] = vowelStrength * 0.6;
      weights['viseme_E'] = vowelStrength * 0.4;
    } else if (spectralCentroid > 0.4) {
      // Mid vowels: a, eh
      weights['viseme_aa'] = vowelStrength * 0.5;
      weights['viseme_E'] = vowelStrength * 0.3;
    } else if (spectralCentroid > 0.2) {
      // Dark vowels: oh, aw
      weights['viseme_O'] = vowelStrength * 0.6;
      weights['viseme_aa'] = vowelStrength * 0.3;
    } else {
      // Very dark: oo, u
      weights['viseme_U'] = vowelStrength * 0.5;
      weights['viseme_O'] = vowelStrength * 0.3;
    }
  }

  // Plosives (high amplitude transients) — p, b, t, d, k, g
  // Detected by sudden RMS spike
  if (amplitude > 0.5 && zcr < 0.15) {
    if (spectralCentroid < 0.3) {
      weights['viseme_PP'] = 0.4;
    } else if (spectralCentroid < 0.5) {
      weights['viseme_DD'] = 0.4;
    } else {
      weights['viseme_kk'] = 0.4;
    }
  }

  // Nasals (medium amplitude, low ZCR) — m, n
  if (amplitude > 0.1 && amplitude < 0.4 && zcr < 0.1) {
    weights['viseme_nn'] = 0.3;
    weights['viseme_PP'] = 0.15;
  }

  // Fill silence weight for remaining capacity
  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
  if (totalWeight < 0.3) {
    weights['viseme_sil'] = 1 - totalWeight;
  }

  return weights;
}

/**
 * Interpolate a VisemeTimeline at a given time.
 * Uses linear interpolation between the two nearest frames.
 */
export function interpolateVisemes(
  timeline: VisemeTimeline,
  time: number
): Record<string, number> {
  if (timeline.length === 0) return {};
  if (timeline.length === 1) return timeline[0].weights;

  // Find surrounding frames
  let low = 0;
  let high = timeline.length - 1;

  if (time <= timeline[0].time) return timeline[0].weights;
  if (time >= timeline[high].time) return timeline[high].weights;

  // Binary search for surrounding frames
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (timeline[mid].time <= time) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const a = timeline[low];
  const b = timeline[high];
  const t = (time - a.time) / (b.time - a.time || 1);

  // Lerp all weights
  const result: Record<string, number> = {};
  const allKeys = new Set([...Object.keys(a.weights), ...Object.keys(b.weights)]);
  for (const key of allKeys) {
    const va = a.weights[key] || 0;
    const vb = b.weights[key] || 0;
    result[key] = va + t * (vb - va);
  }

  return result;
}
