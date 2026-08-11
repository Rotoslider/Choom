/**
 * Per-Choom capability grants. Values are stored as JSON so new grants can be
 * added without changing the profile shape again. Unknown or malformed values
 * must never grant access.
 */
export interface ChoomPermissions {
  ssh: boolean;
}

export const DEFAULT_CHOOM_PERMISSIONS: Readonly<ChoomPermissions> = Object.freeze({
  ssh: false,
});

/** Convert a database JSON string or API value into safe, typed grants. */
export function normalizeChoomPermissions(value: unknown): ChoomPermissions {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ...DEFAULT_CHOOM_PERMISSIONS };
    }
  }

  const ssh = parsed !== null
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && 'ssh' in parsed
    && parsed.ssh === true;
  return { ssh };
}

/** Serialize normalized grants for the SQLite-backed Choom profile. */
export function serializeChoomPermissions(value: unknown): string {
  return JSON.stringify(normalizeChoomPermissions(value));
}

/** Accepts either a raw Prisma Choom or the API's parsed Choom object. */
export function choomHasSshPermission(choom: unknown): boolean {
  if (choom === null || typeof choom !== 'object' || Array.isArray(choom) || !('permissions' in choom)) {
    return false;
  }
  return normalizeChoomPermissions(choom.permissions).ssh;
}

export const REMOTE_SSH_DISABLED_MESSAGE =
  'Blocked: remote SSH is disabled for this Choom. The owner can enable it in Edit Choom > Permissions.';
