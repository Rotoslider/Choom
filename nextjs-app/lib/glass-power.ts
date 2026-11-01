/**
 * The Glass button: turn the Looking Glass picture off to save power, and on again.
 *
 * Donny, Nov 1 2026, on solar after three cloudy days: drawing the Chooms' 48 views kept the
 * NUC's GPU at full clocks, about 100 W, even with nothing else running. Off, the glass page
 * stops drawing and pauses its clips; their voices, the tower's ears and everything else keep
 * working. It stays off until the button is pressed again, across restarts of the app and of the
 * glass: the choice is saved in data/glass-power.json, and every glass that connects to the feed
 * hears it first (app/api/hologram/events).
 *
 * The glass reports what it is doing in its voice heartbeat (glassOff), so the button can tell
 * "off" from "asked to go off but the glass isn't running".
 */
import fs from 'fs';
import path from 'path';
import { publishHologram } from './hologram-bus';

const store = globalThis as unknown as {
  __choomGlassOff?: boolean;
  __choomGlassReported?: { off: boolean; at: number };
};

const REPORT_FRESH_MS = 25_000; // the glass's heartbeat comes every 10 s

export function glassPowerFile(): string {
  return process.env.CHOOM_GLASS_POWER_FILE || path.join(process.cwd(), 'data', 'glass-power.json');
}

/** Whether the glass picture is switched off (as last pressed, kept across restarts). */
export function glassOff(): boolean {
  if (store.__choomGlassOff === undefined) {
    try {
      store.__choomGlassOff = JSON.parse(fs.readFileSync(glassPowerFile(), 'utf8')).off === true;
    } catch {
      store.__choomGlassOff = false; // never pressed, or the file is unreadable: on
    }
  }
  return store.__choomGlassOff;
}

/** The event a glass gets on connecting and whenever the button changes it. */
export function glassPowerEvent(): { type: 'glass_power'; off: boolean } {
  return { type: 'glass_power', off: glassOff() };
}

export function setGlassOff(off: boolean): void {
  store.__choomGlassOff = off;
  try {
    fs.mkdirSync(path.dirname(glassPowerFile()), { recursive: true });
    fs.writeFileSync(glassPowerFile(), JSON.stringify({ off, changedAt: new Date().toISOString() }) + '\n');
  } catch (e) {
    console.warn(`   ⚠️ Glass power: could not save ${glassPowerFile()}: ${e instanceof Error ? e.message : e}`);
  }
  publishHologram(glassPowerEvent());
  console.log(`   🔌 Glass picture ${off ? 'OFF (saving power; voices still play)' : 'ON'}`);
}

/** From the glass's heartbeat: whether its picture is off right now. */
export function setGlassReported(off: boolean): void {
  store.__choomGlassReported = { off, at: Date.now() };
}

/** What the glass last said about its picture, if it said so recently (null: not running). */
export function glassReported(): boolean | null {
  const r = store.__choomGlassReported;
  return r && Date.now() - r.at < REPORT_FRESH_MS ? r.off : null;
}
