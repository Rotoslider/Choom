/**
 * Deny-by-default environment for child processes spawned by the code
 * sandbox (execute_code / run_command).
 *
 * Threat model (C-48, "lethal trifecta"): a Choom reads untrusted content —
 * a web page, an email, a PDF — that carries hidden instructions. The Chooms
 * run 31-35B local models; they cannot be relied on to recognise an
 * injection. If the injected instruction is "run this shell command", the
 * shell previously inherited the ENTIRE Next.js process environment,
 * including BRAVE_API_KEY, OPENWEATHER_API_KEY, MUSIC_ASSISTANT_TOKEN and
 * every other secret in .env — one `curl` away from being exfiltrated.
 *
 * The fix is architectural, not detective: the sandbox process simply does
 * not hold the secrets. An injected command can still run, but there is
 * nothing in its environment worth stealing.
 *
 * What this does NOT cover, stated plainly:
 *  - Secrets on DISK are still readable (.env, token.json, ~/.ssh). Only the
 *    process environment is cleaned. Blocking file reads would break the
 *    user's real ML work, which routinely reads config and data files.
 *  - The shell can still reach the network. The per-domain fetch cap covers
 *    the tool path, not `curl` inside run_command.
 *  - Anything the user explicitly adds to CHOOM_SANDBOX_ENV_EXTRA.
 */

/** Exact variable names every normal shell/python/node invocation needs. */
const ALLOWED_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV',
  'LANG', 'LANGUAGE', 'TZ', 'PWD', 'OLDPWD', 'HOSTNAME', 'DISPLAY', 'XAUTHORITY',
  // Toolchain / runtime knobs the user's ML and node work depends on.
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV',
  'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX', 'NVM_DIR',
  'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
  'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMD_EXEC_PID',
]);

/**
 * Prefixes for families that are safe and needed wholesale. CUDA/NVIDIA/
 * ROCm matter here: the user runs Isaac Sim and PyTorch training through
 * run_command, and stripping these would break real daily work.
 */
const ALLOWED_PREFIXES = [
  'LC_', 'CUDA', 'NVIDIA', 'NV_', '__NV', 'HIP_', 'ROCM', 'HSA_',
  'OMP_', 'MKL_', 'NCCL_', 'TORCH_', 'PYTORCH_', 'TF_', 'HF_HOME',
  'ISAAC', 'OV_', 'OMNI_',
];

/**
 * Names that must NEVER pass, even if a prefix rule would allow them.
 * Checked first. Deliberately broad — a false positive costs a shell script
 * one variable; a false negative costs a credential.
 */
const DENY_SUBSTRINGS = [
  'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'AUTH',
  'SESSION', 'COOKIE', 'PRIVATE', 'SIGNATURE', 'WEBHOOK', 'DSN',
];

function isAllowed(name: string): boolean {
  const upper = name.toUpperCase();
  // XAUTHORITY is a file path to the X cookie file, not a secret value, and
  // GUI-adjacent tooling needs it; allow it despite the AUTH substring.
  if (upper !== 'XAUTHORITY' && DENY_SUBSTRINGS.some(bad => upper.includes(bad))) return false;
  if (ALLOWED_EXACT.has(upper)) return true;
  return ALLOWED_PREFIXES.some(p => upper.startsWith(p));
}

/**
 * Build the environment for a sandboxed child process.
 *
 * @param extra variables the caller explicitly wants set (e.g.
 *   PYTHONDONTWRITEBYTECODE). These bypass the allowlist because they are
 *   supplied by our own code, not by the model.
 */
export function buildSandboxEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && isAllowed(name)) env[name] = value;
  }
  // Escape hatch: a comma-separated list of extra var names the owner
  // deliberately wants available to their scripts.
  const optIn = (process.env.CHOOM_SANDBOX_ENV_EXTRA || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  for (const name of optIn) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  // Cast: NodeJS.ProcessEnv is declared with a required NODE_ENV in this
  // project's Next.js types, but a child env legitimately may omit it.
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

/** Exported for tests: which of the current env's names would be dropped. */
export function droppedEnvNames(): string[] {
  return Object.keys(process.env).filter(n => !isAllowed(n)).sort();
}
