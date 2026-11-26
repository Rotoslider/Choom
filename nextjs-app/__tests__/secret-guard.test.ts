/**
 * 2026-11-26: when a tool fell short, the Chooms went after Donny's keys on
 * disk through run_command. Aloy (Nov 11) grepped the app's .env and bridge
 * settings and called Home Assistant without a key; Eve (Nov 22) searched home
 * and Application Support, then read HA's key from bridge-config.json. Each
 * no-key call to Home Assistant shows in HA as a failed login. The commands
 * below are shaped like theirs; ordinary work must still run.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { secretAccessRefusal, scrubKnownSecrets, knownSecretValues } from '@/lib/secret-guard';
import { PERMISSION_BLOCK, CONFIG_ERROR } from '@/lib/tool-error-classification';

const HA = 'http://ha.example:8123';

describe('refused: what the Chooms actually ran', () => {
  test.each([
    ['Eve reads the bridge settings', `cd ~/Projects/Choom && find . -name "bridge-config.json" -not -path "*/node_modules/*"`],
    ['a script that opens them', `CFG = "/Users/someone/Projects/Choom/nextjs-app/services/signal-bridge/bridge-config.json"\nimport json\nprint(json.load(open(CFG)).keys())`],
    ["Aloy lists the app's .env files", 'cd ~/Projects/Choom 2>/dev/null && for f in .env .env.local nextjs-app/.env; do [ -f "$f" ] && cut -d= -f1 "$f"; done'],
    ['an --include of *.env in the app', 'grep -rIn "8123" ~/Projects/Choom --include="*.ts" --include="*.env"'],
    ['the settings backups', 'ls ~/Projects/Choom/nextjs-app/data/backups/daily/'],
    ["Eve searches Application Support", 'grep -rl -E "hass|homeassistant|8123" ~/Library/Application\\ Support 2>/dev/null | head -20'],
    ['a browser profile', 'ls "$HOME/Library/Application Support/Firefox/Profiles/"'],
    ['saved browser logins by name', 'find / -name logins.json 2>/dev/null'],
    ['the keychain', 'security find-generic-password -s "Home Assistant" -w'],
    ['an SSH private key', 'cat ~/.ssh/id_ed25519'],
    ['a key search of all of home', 'grep -ri "access_token" ~ 2>/dev/null | head'],
    ['a no-key call to Home Assistant', 'curl -s -o /dev/null -w "%{http_code}" http://ha.example:8123/api/'],
    ['HA by its local name', 'curl -s http://homeassistant.local:8123/api/states'],
    ['a network scan for HA', 'for i in $(seq 1 254); do curl -s -m 2 http://192.168.9.$i:8123/ ; done'],
  ])('%s', (_label, command) => {
    const why = secretAccessRefusal(command, HA);
    expect(why).toMatch(/^Blocked: not run, it reaches /);
  });

  test('the reply points somewhere useful, and the loop treats it as recoverable', () => {
    const ha = secretAccessRefusal('curl http://ha.example:8123/api/history/period', HA)!;
    expect(ha).toMatch(/ha_get_history \(with the curve\)/);
    expect(ha).toMatch(/failed login/);
    const keys = secretAccessRefusal('cat services/signal-bridge/bridge-config.json', HA)!;
    expect(keys).toMatch(/tell Donny what's missing/);
    for (const msg of [ha, keys]) {
      expect(PERMISSION_BLOCK.test(msg)).toBe(true); // not counted as the tool failing
      expect(CONFIG_ERROR.test(msg)).toBe(false); // and never blocks run_command for the request
    }
  });
});

describe('still runs: ordinary work', () => {
  test.each([
    ['node reading its environment', 'console.log(process.env.HOME)'],
    ['python reading its environment', 'import os\nprint(os.environ.get("PATH"))'],
    ['her own project', 'cd ~/choom-projects/selfies_eve && ls -la && cat notes.md'],
    ['a pip install', 'pip install numpy pandas'],
    ['grep in her own project for a key word', 'grep -rn "api_key" ~/choom-projects/weather_bot/'],
    ['the public half of an SSH key', 'cat ~/.ssh/id_ed25519.pub'],
    ['the app source', 'grep -n "maxRounds" ~/Projects/Choom/nextjs-app/app/api/group-chat/route.ts'],
    ['a dotenv file in her own project', 'cd ~/choom-projects/bot && cat .env.example'],
    ['LM Studio on the NUC', 'curl -s http://nuc.example:1234/v1/models'],
    ['find in her folder', 'find ~/choom-projects/selfies_aloy -name "*.jpg" | wc -l'],
  ])('%s', (_label, command) => {
    expect(secretAccessRefusal(command, HA)).toBeNull();
  });
});

describe('scrub: a key that turns up in output is replaced', () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  let dir = '';
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    process.chdir(cwd);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  test('keys from the environment and the bridge settings, nothing else', () => {
    // Built here, not written out whole, so no key-shaped literal sits in the repo.
    const envKey = 'brv' + 'x'.repeat(20);
    const haKey = 'ey' + 'J'.repeat(40);
    process.env.SOMETHING_API_KEY = envKey;
    process.env.NEXTAUTH_URL = 'https://localhost:3443';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
    fs.mkdirSync(path.join(dir, 'services/signal-bridge'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'services/signal-bridge/bridge-config.json'), JSON.stringify({
      homeAssistant: { baseUrl: HA, accessToken: haKey, cacheSeconds: 30 },
      providers: [{ name: 'cloud', apiKey: 'sk-' + 'q'.repeat(30) }],
      ownerName: 'Donny',
    }));
    process.chdir(dir);

    const secrets = knownSecretValues();
    expect(secrets).toEqual(expect.arrayContaining([envKey, haKey, 'sk-' + 'q'.repeat(30)]));
    expect(secrets).not.toContain('https://localhost:3443');
    expect(secrets).not.toContain(HA);

    const out = scrubKnownSecrets({ stdout: `TOKEN=${haKey}\nok https://localhost:3443`, stderr: '', exitCode: 0 }, secrets);
    expect(out.stdout).toBe("TOKEN=[removed: one of Donny's keys]\nok https://localhost:3443");
    expect(out.exitCode).toBe(0);
  });
});
