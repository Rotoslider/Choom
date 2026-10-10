/**
 * The glass camera: the MX Brio on top of the Looking Glass at Donny's desk, run by the hologram on
 * the NUC (tower_eyes.py), not Home Assistant. Requests go down the hologram's feed as
 * camera_request events; the hologram's server posts the answer back to /api/hologram/camera/result.
 * The NUC opens no port for this. Ops: state, settings (change them), frame (a JPEG; purpose
 * "snapshot" for the Chooms, refused when Donny has their access turned off).
 */
import { randomUUID } from 'crypto';
import { hologramConnected, publishHologram } from '@/lib/hologram-bus';

export interface GlassCameraAnswer {
  ok: boolean;
  error?: string;
  status?: number;
  image?: string; // base64 JPEG
  state?: GlassCameraState;
}

export interface GlassCameraState {
  camera: string | null;
  streaming: boolean;
  face: boolean;
  looking: boolean;
  gaze: number | null;
  light: boolean;
  settings: {
    enabled: boolean;
    chooms: boolean;
    eye_contact: boolean;
    yaw_limit: number;
    welcome: boolean;
    welcome_minutes: number;
  };
  controls: Record<string, { value: number; min?: number; max?: number; step?: number; default?: number; options?: number[] }> | null;
}

type Pending = { resolve: (a: GlassCameraAnswer) => void; timer: ReturnType<typeof setTimeout> };
const store = globalThis as unknown as { __choomGlassCamera?: Map<string, Pending> };
const pending = (store.__choomGlassCamera ??= new Map<string, Pending>());

/** Ask the hologram's camera; resolves with its answer, or ok:false if the glass isn't running or doesn't answer. */
export function askGlassCamera(op: 'state' | 'settings' | 'frame', args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<GlassCameraAnswer> {
  if (!hologramConnected()) return Promise.resolve({ ok: false, error: 'The glass (the hologram on the NUC) is not running, so its camera is unavailable.' });
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'The glass camera did not answer in time.' });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    publishHologram({ type: 'camera_request', id, op, args });
  });
}

/** The hologram's answer to a camera_request. */
export function resolveGlassCamera(id: string, answer: GlassCameraAnswer): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(answer);
  return true;
}

/** Whether a camera name the Chooms used means the glass camera ("glass", "desk", "portrait", "hologram"). */
export function isGlassCameraName(ref: string): boolean {
  return /\b(glass|looking[\s_-]*glass|desk|portrait|hologram|brio)\b/i.test(ref.replace(/^camera\./i, ''));
}
