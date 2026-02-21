/**
 * Skill Sandbox
 * Provides a restricted execution context for external skills.
 * Scopes workspace access, filters sensitive data from send(), and enforces timeouts.
 */

import * as path from 'path';
import type { SkillHandlerContext } from './skill-handler';
import { EXTERNAL_SKILLS_ROOT } from '@/lib/config';

// ============================================================================
// Constants
// ============================================================================

/** Maximum execution time per tool call for external skills (ms) */
const NETWORK_TIMEOUT_MS = 30_000;

/** Fields stripped from data passed through send() */
const SENSITIVE_FIELDS = [
  'apiKey',
  'api_key',
  'secret',
  'token',
  'password',
  'credential',
  'authorization',
  'privateKey',
  'private_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'sessionToken',
  'session_token',
  'connectionString',
  'connection_string',
  'databaseUrl',
  'database_url',
];

// ============================================================================
// SkillSandbox Class
// ============================================================================

export class SkillSandbox {
  private externalRoot: string;

  constructor(externalRoot?: string) {
    this.externalRoot = externalRoot || EXTERNAL_SKILLS_ROOT;
  }

  /**
   * Create a sandboxed SkillHandlerContext for an external skill.
   *
   * Restrictions applied:
   * - Workspace access is scoped to .choom-external-skills/<skill>/data/
   * - send() function is wrapped to filter out sensitive fields
   * - A timeout wrapper is available for async operations
   */
  createContext(baseCtx: SkillHandlerContext, skillName: string): SkillHandlerContext {
    // Validate skill name
    if (!skillName || /[/\\]/.test(skillName) || skillName.includes('..')) {
      throw new Error(`Invalid skill name for sandbox: "${skillName}"`);
    }

    const skillDataDir = path.join(this.externalRoot, skillName, 'data');

    // Create a sandboxed send() that filters sensitive fields
    const sandboxedSend = this.createSandboxedSend(baseCtx.send);

    // Create scoped settings (strip sensitive values)
    const sandboxedSettings = this.filterSensitiveFields(
      { ...baseCtx.settings }
    ) as Record<string, unknown>;

    // Build the sandboxed context
    const sandboxedCtx: SkillHandlerContext = {
      // Memory — pass through (memory client handles its own isolation)
      memoryClient: baseCtx.memoryClient,
      memoryCompanionId: baseCtx.memoryCompanionId,

      // Settings — filtered
      weatherSettings: baseCtx.weatherSettings,
      settings: sandboxedSettings,
      imageGenSettings: baseCtx.imageGenSettings,

      // Choom info — pass through (non-sensitive identifiers)
      choom: this.filterSensitiveFields({ ...baseCtx.choom }) as Record<string, unknown>,
      choomId: baseCtx.choomId,
      chatId: baseCtx.chatId,
      message: baseCtx.message,

      // Streaming — sandboxed
      send: sandboxedSend,

      // Session limits — pass through
      sessionFileCount: baseCtx.sessionFileCount,

      // Skill-specific context
      skillDoc: baseCtx.skillDoc,
      getReference: baseCtx.getReference,
    };

    return sandboxedCtx;
  }

  /**
   * Get the sandboxed data directory path for an external skill.
   * External skills can only read/write within this directory.
   */
  getDataDir(skillName: string): string {
    if (!skillName || /[/\\]/.test(skillName) || skillName.includes('..')) {
      throw new Error(`Invalid skill name: "${skillName}"`);
    }
    return path.join(this.externalRoot, skillName, 'data');
  }

  /**
   * Validate that a file path is within the skill's sandboxed data directory.
   * Throws if the path escapes the sandbox.
   */
  validatePath(skillName: string, filePath: string): string {
    const dataDir = path.resolve(this.getDataDir(skillName));
    const cleaned = filePath.replace(/^[/\\]+/, '');
    const resolved = path.resolve(dataDir, cleaned);

    if (!resolved.startsWith(dataDir)) {
      throw new Error(`Sandbox path traversal blocked: "${filePath}" resolves outside skill data directory`);
    }

    return resolved;
  }

  /**
   * Wrap an async operation with the sandbox network timeout.
   * Rejects if the operation takes longer than NETWORK_TIMEOUT_MS.
   */
  withTimeout<T>(operation: Promise<T>, label?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `Sandbox timeout (${NETWORK_TIMEOUT_MS}ms) exceeded${label ? ` for: ${label}` : ''}`
        ));
      }, NETWORK_TIMEOUT_MS);

      operation
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // ========================================================================
  // Private Helpers
  // ========================================================================

  /**
   * Create a sandboxed version of the send() function that strips sensitive fields.
   */
  private createSandboxedSend(
    originalSend: (data: Record<string, unknown>) => void
  ): (data: Record<string, unknown>) => void {
    return (data: Record<string, unknown>) => {
      const filtered = this.filterSensitiveFields(data) as Record<string, unknown>;
      originalSend(filtered);
    };
  }

  /**
   * Recursively filter sensitive fields from an object.
   * Returns a new object with sensitive keys replaced by '[REDACTED]'.
   */
  private filterSensitiveFields(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map(item => this.filterSensitiveFields(item));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const keyLower = key.toLowerCase();
      const isSensitive = SENSITIVE_FIELDS.some(
        field => keyLower === field.toLowerCase() || keyLower.includes(field.toLowerCase())
      );

      if (isSensitive && typeof value === 'string' && value.length > 0) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.filterSensitiveFields(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
