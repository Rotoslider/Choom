// Skill Handler Base Class
// Provides the abstract interface and helpers for all skill handlers

import type { ToolCall, ToolResult, ToolDefinition, ImageGenSettings, WeatherSettings } from './types';
import { MemoryClient } from './memory-client';

// ============================================================================
// Context passed to every skill handler execution
// ============================================================================

export interface SkillHandlerContext {
  // Memory
  memoryClient: MemoryClient;
  memoryCompanionId: string;

  // Settings
  weatherSettings: WeatherSettings;
  settings: Record<string, unknown>;
  imageGenSettings: ImageGenSettings;

  // Choom
  choom: Record<string, unknown>;
  choomId: string;
  chatId: string;
  message: string;

  // Streaming
  send: (data: Record<string, unknown>) => void;

  // Session limits
  sessionFileCount: { created: number; maxAllowed: number };

  // Skill-specific context (injected by registry)
  skillDoc: string;
  getReference: (fileName: string) => Promise<string>;
}

// ============================================================================
// Abstract Base Skill Handler
// ============================================================================

export abstract class BaseSkillHandler {
  /**
   * Check if this handler can handle the given tool name.
   */
  abstract canHandle(toolName: string): boolean;

  /**
   * Execute a tool call and return the result.
   */
  abstract execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult>;

  /**
   * Helper: return a success ToolResult
   */
  protected success(toolCall: ToolCall, result: unknown): ToolResult {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result,
    };
  }

  /**
   * Helper: return an error ToolResult
   */
  protected error(toolCall: ToolCall, message: string): ToolResult {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: message,
    };
  }
}

// ============================================================================
// Skill Metadata (parsed from SKILL.md YAML frontmatter)
// ============================================================================

export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
  author: string;
  tools: string[];
  dependencies: string[];
  type: 'core' | 'custom' | 'external';
  enabled: boolean;
  path: string; // Directory path
}

// ============================================================================
// Loaded Skill (fully hydrated)
// ============================================================================

export interface LoadedSkill {
  metadata: SkillMetadata;
  fullDoc: string;           // Full SKILL.md body (Level 2)
  toolDefinitions: ToolDefinition[];
  handler: BaseSkillHandler;
}
