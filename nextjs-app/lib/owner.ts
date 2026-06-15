import fs from 'fs';
import path from 'path';

// The human owner's identity (name + location), resolved server-side so EVERY
// caller — 1:1 chat, group rooms, the Signal bridge — refers to the user by
// their real name instead of the cold generic word "user".
//
// Priority: env (OWNER_NAME / OWNER_LOCATION) > bridge-config.json (synced from
// the Settings UI) > built-in defaults. bridge-config.json is the cross-process
// source of truth the web Settings store writes to, so a name set in the UI
// flows here without an env change or restart.

export interface OwnerIdentity {
  name: string;
  location: string;
}

const DEFAULT_NAME = 'Donny';
const DEFAULT_LOCATION = 'the southwest New Mexico bootheel (near Rodeo / Animas, NM)';

const BRIDGE_CONFIG_PATH = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');

// Small TTL cache so a per-turn read doesn't hit the disk repeatedly.
let cache: { value: OwnerIdentity; at: number } | null = null;
const CACHE_MS = 5000;

export function getOwnerIdentity(): OwnerIdentity {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  let cfgName = '';
  let cfgLocation = '';
  try {
    if (fs.existsSync(BRIDGE_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_PATH, 'utf-8'));
      if (typeof cfg.ownerName === 'string') cfgName = cfg.ownerName.trim();
      if (typeof cfg.ownerLocation === 'string') cfgLocation = cfg.ownerLocation.trim();
    }
  } catch { /* fall through to env/defaults */ }

  const value: OwnerIdentity = {
    name: (process.env.OWNER_NAME || cfgName || DEFAULT_NAME).trim(),
    location: (process.env.OWNER_LOCATION || cfgLocation || DEFAULT_LOCATION).trim(),
  };
  cache = { value, at: Date.now() };
  return value;
}
