import fs from 'fs';
import path from 'path';

// Group-room model overrides, resolved server-side from bridge-config.json (the
// same cross-process source the Settings UI syncs to). Read here — not from the
// request body — so the orchestrator applies the SAME model whether a run was
// kicked off from the web, a Choom's talk_with_sisters, a heartbeat, or a
// scheduled room follow-up (no web-vs-bridge divergence).

export interface RoomCreatorModel {
  model: string;
  providerId: string | null;
}

const BRIDGE_CONFIG_PATH = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');

let cache: { value: RoomCreatorModel | null; at: number } | null = null;
const CACHE_MS = 5000;

// The model the room CREATOR (host seat) should use in group turns, or null if no
// override is configured (each Choom then uses her own model).
export function getRoomCreatorModel(): RoomCreatorModel | null {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  let value: RoomCreatorModel | null = null;
  try {
    if (fs.existsSync(BRIDGE_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_PATH, 'utf-8'));
      const model = cfg?.llm?.roomCreatorModel;
      if (typeof model === 'string' && model.trim()) {
        const providerId = cfg?.llm?.roomCreatorProviderId;
        value = { model: model.trim(), providerId: (typeof providerId === 'string' && providerId.trim()) ? providerId.trim() : null };
      }
    }
  } catch { /* no override on parse failure */ }

  cache = { value, at: Date.now() };
  return value;
}
