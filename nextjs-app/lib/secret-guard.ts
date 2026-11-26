/**
 * Donny's keys on disk, kept out of run_command and execute_code (Nov 2026).
 *
 * sandbox-env.ts takes the keys out of the shell's environment and, on
 * purpose, leaves files readable. When a tool fell short, the Chooms went
 * looking for keys themselves. Aloy (Nov 11, Home Assistant down) scanned the
 * network for it and grepped the app's .env and the bridge settings. Eve
 * (Nov 22, again Nov 23 and 25) searched home and the browsers' profiles,
 * printed the .env's key names, called Home Assistant without a key (that
 * shows in HA as a failed login from the Mac), then read HA's key from
 * bridge-config.json and fetched the history herself, because ha_get_history
 * gave no curve.
 *
 * Two layers, both narrow:
 *  1. secretAccessRefusal(): a command or script that names one of the key
 *     files, the browsers' saved logins, or Home Assistant's address is not
 *     run. The reply points to the tool that does the job, or to Donny.
 *  2. scrubKnownSecrets(): a key from the app's .env or the bridge settings
 *     that still turns up in what a command printed is replaced.
 * Neither is a sandbox: a script can spell a path another way. They stop a
 * Choom who means well from walking into Donny's keys, and say why.
 */
import fs from 'fs';
import path from 'path';

const ASK = "If a tool can't do what you need, tell Donny what's missing and he'll sort it out.";
const HA_INSTEAD = `Home Assistant is reached through your ha_* tools: ha_get_state, ha_get_history (with the curve), ha_get_logbook, ha_render_template, ha_call_service. A direct call without its key shows up in Home Assistant as a failed login, and the key is Donny's. ${ASK}`;
const KEYS_INSTEAD = `These files hold Donny's keys, and the keys are his. The tools that need them already have them. ${ASK}`;

// The Choom app's own folder, however it's written.
const CHOOM_APP = /nextjs-app|Projects\/Choom\b/; // not ~/choom-projects
// A file named .env (or .env.local …) as a word of its own: not process.env or os.environ.
const ENV_FILE = /(^|[\s'"`/=(<*])\.env(\.[\w-]+)*(?=$|[\s'"`;|&)<>,])/;

const ALWAYS: Array<{ re: RegExp; what: string; instead: string }> = [
  { re: /bridge-config/i, what: "the Signal bridge's settings file", instead: KEYS_INSTEAD },
  { re: /data\/backups\b/i, what: "the app's settings backups", instead: KEYS_INSTEAD },
  { re: /signal-bridge\/[^\s'"]*(token|credentials)\.json/i, what: 'the Google sign-in files', instead: KEYS_INSTEAD },
  { re: /certificates\/[\w.-]*key[\w.-]*\.pem/i, what: "the app's certificate key", instead: KEYS_INSTEAD },
  { re: /\.ssh\/id_[a-z0-9_-]+(?![a-z0-9_.-]*\.pub)/i, what: 'SSH private keys', instead: `${KEYS_INSTEAD} For other machines use run_ssh_command.` },
  { re: /\.config\/choom-hologram\/ha_token|\.git-credentials|\.netrc\b|\.config\/gh\/hosts\.yml/i, what: 'saved logins', instead: KEYS_INSTEAD },
  {
    re: /Application(\\ | |%20)Support\/(Firefox|BraveSoftware|Google\/Chrome|Microsoft Edge|Arc|Chromium)|logins\.json|key4\.db|Login Data|Cookies\.binarycookies|Library\/Keychains|\bsecurity\s+(find-(generic|internet)-password|dump-keychain)/i,
    what: "the browsers' saved logins and the keychain",
    instead: KEYS_INSTEAD,
  },
];

// A recursive search, and where it starts: home itself or ~/Library.
const RECURSIVE_SEARCH = /\b(grep\s+(-\w*[rR]\w*|--recursive)|rg|ag|ack|find)\b/;
const HOME_OR_LIBRARY = /(^|[\s'"=])(~|\$HOME|\$\{HOME\}|\/Users\/[\w.-]+)(\/Library\b[^\s'"]*)?\/?(?=$|[\s'"])/;
const APP_SUPPORT = /Application(\\ | |%20)Support/i;
const KEY_WORDS = /token|api[_-]?key|secret|passw|credential|bearer|auth|hass|homeassistant|8123/i;

function haAddresses(haBaseUrl?: string): string[] {
  const out = ['homeassistant.local', 'nabu.casa', ':8123'];
  try {
    if (haBaseUrl) out.push(new URL(haBaseUrl).host);
  } catch { /* not a URL */ }
  return out.filter(Boolean);
}

/**
 * Why this command or script won't be run, or null to run it. `haBaseUrl` is
 * Home Assistant's address from Settings > Smart Home.
 */
export function secretAccessRefusal(text: string, haBaseUrl?: string): string | null {
  if (!text) return null;
  // "Blocked: not run" is a recoverable block (tool-error-classification.ts): the tool stays usable for everything else.
  const say = (what: string, instead: string) => `Blocked: not run, it reaches ${what}. ${instead}`;
  for (const rule of ALWAYS) {
    if (rule.re.test(text)) return say(rule.what, rule.instead);
  }
  if (CHOOM_APP.test(text) && ENV_FILE.test(text)) return say("the Choom app's .env file", KEYS_INSTEAD);
  const lower = text.toLowerCase();
  if (haAddresses(haBaseUrl).some(a => lower.includes(a.toLowerCase()))) return say('Home Assistant directly', HA_INSTEAD);
  if (RECURSIVE_SEARCH.test(text) && KEY_WORDS.test(text) && (HOME_OR_LIBRARY.test(text) || APP_SUPPORT.test(text))) {
    return say('a search of the whole home folder for keys', KEYS_INSTEAD);
  }
  return null;
}

// ── Output scrub ──────────────────────────────────────────────────────────

const SECRET_NAME = /token|key|secret|passw|auth|credential/i;
// NEXTAUTH_URL, KEY_PATH …: where something is, not a key. Replacing one would blank every path or link to it.
const NOT_A_SECRET_NAME = /(_|^)(URL|URI|HOST|PATH|DIR|FILE|ENDPOINT|PORT)$/i;
const MIN_SECRET_LEN = 12;
let bridgeSecrets: { mtimeMs: number; values: string[] } | null = null;

function collectSecretStrings(value: unknown, keyIsSecret: boolean, out: string[]): void {
  if (typeof value === 'string') {
    if (keyIsSecret && value.length >= MIN_SECRET_LEN && !/^[/~]/.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectSecretStrings(v, keyIsSecret, out); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectSecretStrings(v, keyIsSecret || SECRET_NAME.test(k), out);
  }
}

function bridgeConfigSecrets(): string[] {
  const file = path.join(process.cwd(), 'services/signal-bridge/bridge-config.json');
  try {
    const { mtimeMs } = fs.statSync(file);
    if (bridgeSecrets && bridgeSecrets.mtimeMs === mtimeMs) return bridgeSecrets.values;
    const values: string[] = [];
    collectSecretStrings(JSON.parse(fs.readFileSync(file, 'utf8')), false, values);
    bridgeSecrets = { mtimeMs, values };
    return values;
  } catch {
    return bridgeSecrets?.values || [];
  }
}

/** Every key value the app holds: its environment (.env) and the bridge settings. */
export function knownSecretValues(): string[] {
  const values = new Set<string>();
  for (const [name, v] of Object.entries(process.env)) {
    if (v && v.length >= MIN_SECRET_LEN && SECRET_NAME.test(name) && !NOT_A_SECRET_NAME.test(name) && !/^[/~]/.test(v)) values.add(v);
  }
  for (const v of bridgeConfigSecrets()) values.add(v);
  // Longest first, so a key that contains a shorter one is replaced whole.
  return [...values].sort((a, b) => b.length - a.length);
}

/** Every string in a command's result with any known key value replaced. */
export function scrubKnownSecrets<T>(value: T, secrets: string[] = knownSecretValues()): T {
  if (secrets.length === 0) return value;
  if (typeof value === 'string') {
    let s: string = value;
    for (const k of secrets) if (s.includes(k)) s = s.split(k).join('[removed: one of Donny\'s keys]');
    return s as T;
  }
  if (Array.isArray(value)) return value.map(v => scrubKnownSecrets(v, secrets)) as T;
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubKnownSecrets(v, secrets);
    return out as T;
  }
  return value;
}
