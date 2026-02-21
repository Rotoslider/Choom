// Skill Registry
// Loads, caches, and indexes all skills from core/, custom/, external/ directories.
// Provides progressive disclosure (Level 1/2/3) and tool dispatch.

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition } from './types';
import type { SkillMetadata, LoadedSkill, BaseSkillHandler } from './skill-handler';

// Dynamic require that bypasses Turbopack's static module resolution.
// The indirect eval prevents Turbopack from analyzing the require() call.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const dynamicRequire = new Function('p', 'return require(p)') as (path: string) => Record<string, unknown>;

// ============================================================================
// Skill Registry Singleton
// ============================================================================

let registryInstance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!registryInstance) {
    registryInstance = new SkillRegistry();
  }
  return registryInstance;
}

// Reset for testing
export function resetSkillRegistry(): void {
  registryInstance = null;
}

// ============================================================================
// YAML Frontmatter Parser (minimal — avoids external dependency)
// ============================================================================

function parseYAMLFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];

  // Minimal YAML parser for flat key-value pairs and arrays
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');
  let currentKey = '';
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item
    if (trimmed.startsWith('- ') && currentArray !== null) {
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    // Save pending array
    if (currentArray !== null) {
      frontmatter[currentKey] = currentArray;
      currentArray = null;
    }

    // Key-value pair
    const kvMatch = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === '' || value === '[]') {
        // Could be start of array or empty value
        currentKey = key;
        currentArray = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array: [item1, item2]
        frontmatter[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      } else {
        // Scalar value — strip quotes
        frontmatter[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  // Save final pending array
  if (currentArray !== null) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body };
}

// ============================================================================
// SkillRegistry Class
// ============================================================================

export class SkillRegistry {
  private skills: Map<string, LoadedSkill> = new Map();
  private toolIndex: Map<string, string> = new Map(); // toolName → skillName
  private loaded = false;
  private skillsRoot: string;

  constructor(skillsRoot?: string) {
    // Default: skills/ directory relative to the nextjs-app root
    this.skillsRoot = skillsRoot || path.join(process.cwd(), 'skills');
  }

  // ========================================================================
  // Loading
  // ========================================================================

  /**
   * Load all skills from core/, custom/, external/ directories.
   * Called lazily on first access. Skips skills already pre-registered
   * (e.g., core skills registered via loadCoreSkills()) to preserve
   * their working handlers.
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;

    const dirs = ['core', 'custom', 'external'] as const;
    for (const dir of dirs) {
      const dirPath = path.join(this.skillsRoot, dir);
      if (!fs.existsSync(dirPath)) continue;

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip skills that are already registered (e.g., pre-registered core skills
        // with working handlers — filesystem reload would overwrite with null handlers)
        if (this.skills.has(entry.name)) continue;
        try {
          await this.loadSkill(path.join(dirPath, entry.name), dir);
        } catch (err) {
          console.warn(`[SkillRegistry] Failed to load skill ${entry.name}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    this.loaded = true;
    console.log(`[SkillRegistry] Loaded ${this.skills.size} skills with ${this.toolIndex.size} tools`);
  }

  /**
   * Load a single skill from a directory.
   */
  private async loadSkill(skillPath: string, type: 'core' | 'custom' | 'external'): Promise<void> {
    // Read SKILL.md
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      throw new Error(`Missing SKILL.md in ${skillPath}`);
    }
    const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8');
    const { frontmatter, body } = parseYAMLFrontmatter(skillMdContent);

    // Build metadata
    const metadata: SkillMetadata = {
      name: (frontmatter.name as string) || path.basename(skillPath),
      description: (frontmatter.description as string) || '',
      version: (frontmatter.version as string) || '1.0.0',
      author: (frontmatter.author as string) || 'system',
      tools: (frontmatter.tools as string[]) || [],
      dependencies: (frontmatter.dependencies as string[]) || [],
      type,
      enabled: true,
      path: skillPath,
    };

    // Load tool definitions — prefer .js (transpiled) over .ts (needs build-time)
    let toolDefinitions: ToolDefinition[] = [];
    const toolsJsPath = path.join(skillPath, 'tools.js');
    const toolsPath = path.join(skillPath, 'tools.ts');
    if (fs.existsSync(toolsJsPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const toolsModule = dynamicRequire(toolsJsPath) as { tools?: ToolDefinition[]; default?: ToolDefinition[] };
        toolDefinitions = toolsModule.tools || toolsModule.default || [];
      } catch (err) {
        console.warn(`[SkillRegistry] Cannot require ${toolsJsPath}:`, err instanceof Error ? err.message : err);
      }
    } else if (fs.existsSync(toolsPath)) {
      try {
        const toolsModule = await import(/* webpackIgnore: true */ toolsPath);
        toolDefinitions = toolsModule.tools || toolsModule.default || [];
      } catch {
        console.warn(`[SkillRegistry] Cannot import ${toolsPath} — tools will be loaded via pre-registration`);
      }
    }

    // Load handler — prefer .js (transpiled) over .ts (needs build-time compilation)
    let handler: BaseSkillHandler | null = null;
    const handlerJsPath = path.join(skillPath, 'handler.js');
    const handlerPath = path.join(skillPath, 'handler.ts');
    if (fs.existsSync(handlerJsPath)) {
      try {
        // Use require for CJS .js files (custom/external skills transpiled by esbuild)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const handlerModule = dynamicRequire(handlerJsPath);
        const HandlerClass = handlerModule.default || Object.values(handlerModule).find(
          (v: unknown) => typeof v === 'function' && (v as { prototype: Record<string, unknown> }).prototype?.execute
        );
        if (HandlerClass && typeof HandlerClass === 'function') {
          handler = new (HandlerClass as new () => BaseSkillHandler)();
        }
      } catch (err) {
        console.warn(`[SkillRegistry] Cannot require handler from ${handlerJsPath}:`, err instanceof Error ? err.message : err);
      }
    } else if (fs.existsSync(handlerPath)) {
      try {
        const handlerModule = await import(/* webpackIgnore: true */ handlerPath);
        const HandlerClass = handlerModule.default || Object.values(handlerModule).find(
          (v: unknown) => typeof v === 'function' && (v as { prototype: Record<string, unknown> }).prototype?.execute
        );
        if (HandlerClass && typeof HandlerClass === 'function') {
          handler = new (HandlerClass as new () => BaseSkillHandler)();
        }
      } catch {
        console.warn(`[SkillRegistry] Cannot import handler from ${handlerPath} — handler will be loaded via pre-registration`);
      }
    }

    // Build loaded skill
    const skill: LoadedSkill = {
      metadata,
      fullDoc: body,
      toolDefinitions,
      handler: handler!,
    };

    this.skills.set(metadata.name, skill);

    // Build tool index
    for (const toolDef of toolDefinitions) {
      this.toolIndex.set(toolDef.name, metadata.name);
    }
    // Also index from frontmatter tool names (in case toolDefinitions aren't loaded yet)
    for (const toolName of metadata.tools) {
      if (!this.toolIndex.has(toolName)) {
        this.toolIndex.set(toolName, metadata.name);
      }
    }
  }

  // ========================================================================
  // Pre-registration (for build-time loading in Next.js)
  // ========================================================================

  /**
   * Register a skill directly (used when dynamic import isn't available).
   * This is the preferred method during Phase 0/1 to avoid runtime import issues.
   */
  registerSkill(
    metadata: SkillMetadata,
    fullDoc: string,
    toolDefinitions: ToolDefinition[],
    handler: BaseSkillHandler
  ): void {
    const skill: LoadedSkill = { metadata, fullDoc, toolDefinitions, handler };
    this.skills.set(metadata.name, skill);

    for (const toolDef of toolDefinitions) {
      this.toolIndex.set(toolDef.name, metadata.name);
    }
    for (const toolName of metadata.tools) {
      if (!this.toolIndex.has(toolName)) {
        this.toolIndex.set(toolName, metadata.name);
      }
    }
  }

  // ========================================================================
  // Progressive Disclosure
  // ========================================================================

  /**
   * Level 1: One-line summaries for system prompt (~100 tokens each).
   * Sent with every request.
   */
  getLevel1Summaries(): string {
    const lines: string[] = [];
    for (const [, skill] of this.skills) {
      if (!skill.metadata.enabled) continue;
      const toolList = skill.metadata.tools.map(t => `\`${t}\``).join(', ');
      lines.push(`- **${skill.metadata.name}**: ${skill.metadata.description} [${toolList}]`);
    }
    return lines.join('\n');
  }

  /**
   * Level 2: Full SKILL.md body for a specific skill.
   * Injected when the skill is triggered.
   */
  getLevel2Doc(skillName: string): string {
    const skill = this.skills.get(skillName);
    return skill?.fullDoc || '';
  }

  /**
   * Level 3: Reference file content from skill directory.
   */
  async getLevel3Reference(skillName: string, fileName: string): Promise<string> {
    const skill = this.skills.get(skillName);
    if (!skill) return '';

    const refPath = path.join(skill.metadata.path, 'reference', fileName);
    if (!fs.existsSync(refPath)) return '';

    return fs.readFileSync(refPath, 'utf-8');
  }

  // ========================================================================
  // Tool Dispatch
  // ========================================================================

  /**
   * Get the loaded skill that handles a specific tool.
   */
  getSkillForTool(toolName: string): LoadedSkill | undefined {
    const skillName = this.toolIndex.get(toolName);
    if (!skillName) return undefined;

    const skill = this.skills.get(skillName);
    if (!skill?.metadata.enabled) return undefined;

    return skill;
  }

  /**
   * Get all tool definitions from all enabled skills.
   */
  getAllToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const [, skill] of this.skills) {
      if (!skill.metadata.enabled) continue;
      tools.push(...skill.toolDefinitions);
    }
    return tools;
  }

  /**
   * Get all loaded skill names.
   */
  getSkillNames(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * Get a loaded skill by name.
   */
  getSkill(skillName: string): LoadedSkill | undefined {
    return this.skills.get(skillName);
  }

  /**
   * Check if the registry has been loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get total tool count.
   */
  getToolCount(): number {
    return this.toolIndex.size;
  }

  // ========================================================================
  // Skill Matching (for progressive disclosure Level 2 injection)
  // ========================================================================

  /**
   * Match user message against skill descriptions and tool names.
   * Returns the top N most relevant skills for Level 2 doc injection.
   */
  matchSkills(userMessage: string, maxResults: number = 3): LoadedSkill[] {
    const msgLower = userMessage.toLowerCase();
    const scored: { skill: LoadedSkill; score: number }[] = [];

    for (const [, skill] of this.skills) {
      if (!skill.metadata.enabled) continue;
      let score = 0;

      // Check if any tool names are mentioned
      for (const toolName of skill.metadata.tools) {
        if (msgLower.includes(toolName.replace(/_/g, ' '))) score += 10;
        if (msgLower.includes(toolName)) score += 10;
      }

      // Check description keywords
      const descWords = skill.metadata.description.toLowerCase().split(/\s+/);
      for (const word of descWords) {
        if (word.length > 3 && msgLower.includes(word)) score += 1;
      }

      // Keyword-based pattern matching for common intents
      const patterns: [RegExp, string[]][] = [
        [/\b(remember|memory|recall|forgot|memories)\b/i, ['memory-management']],
        [/\b(image|picture|photo|selfie|portrait|draw|generate)\b/i, ['image-generation']],
        [/\b(search|look up|find out|google)\b/i, ['web-searching']],
        [/\b(weather|temperature|forecast|rain|wind|humid)\b/i, ['weather-forecasting']],
        [/\b(calendar|schedule|meeting|appointment|event)\b/i, ['google-calendar']],
        [/\b(task|todo|list|groceries|shopping)\b/i, ['google-tasks']],
        [/\b(spreadsheet|sheet|budget|tracker|csv)\b/i, ['google-sheets']],
        [/\b(document|doc|report|letter|write)\b/i, ['google-docs']],
        [/\b(drive|upload|download|backup|cloud)\b/i, ['google-drive']],
        [/\b(file|folder|workspace|project|save|read)\b/i, ['workspace-files']],
        [/\b(pdf|convert|export)\b/i, ['pdf-processing']],
        [/\b(scrape|download|web image|page images)\b/i, ['web-scraping']],
        [/\b(analyze|vision|look at|describe image|examine)\b/i, ['image-analysis']],
        [/\b(code|python|node|execute|run|sandbox|pip|npm)\b/i, ['code-execution']],
        [/\b(notify|notification|signal|alert)\b/i, ['notifications']],
        [/\b(remind|reminder|alarm)\b/i, ['reminders']],
        [/\b(home assistant|smart home|lights?|switch|sensor|thermostat|heater|motion|door|window|fan|climate|turn on|turn off|brightness|hvac)\b/i, ['home-assistant']],
        [/\b(email|gmail|inbox|send email|draft|compose)\b/i, ['google-gmail']],
        [/\b(contacts?|phone number|address book)\b/i, ['google-contacts']],
        [/\b(youtube|video|channel|playlist)\b/i, ['google-youtube']],
        [/\b(plan|multi.?step|step.?by.?step|break.?down)\b/i, ['plan-mode']],
      ];

      for (const [pattern, skillNames] of patterns) {
        if (pattern.test(msgLower) && skillNames.includes(skill.metadata.name)) {
          score += 5;
        }
      }

      if (score > 0) {
        scored.push({ skill, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.skill);
  }

  // ========================================================================
  // Hot Reload
  // ========================================================================

  /**
   * Reload a specific skill by name.
   */
  async reloadSkill(skillName: string): Promise<void> {
    const existing = this.skills.get(skillName);
    if (!existing) {
      throw new Error(`Skill ${skillName} not found`);
    }

    // Remove old tool index entries
    for (const toolName of existing.metadata.tools) {
      this.toolIndex.delete(toolName);
    }
    for (const toolDef of existing.toolDefinitions) {
      this.toolIndex.delete(toolDef.name);
    }

    // Reload
    this.skills.delete(skillName);
    await this.loadSkill(existing.metadata.path, existing.metadata.type);
  }

  /**
   * Enable or disable a skill.
   */
  setEnabled(skillName: string, enabled: boolean): void {
    const skill = this.skills.get(skillName);
    if (skill) {
      skill.metadata.enabled = enabled;
    }
  }

  /**
   * Unregister a skill and remove all its tool index entries.
   */
  unregisterSkill(skillName: string): boolean {
    const skill = this.skills.get(skillName);
    if (!skill) return false;

    // Remove tool index entries
    for (const toolDef of skill.toolDefinitions) {
      this.toolIndex.delete(toolDef.name);
    }
    for (const toolName of skill.metadata.tools) {
      if (this.toolIndex.get(toolName) === skillName) {
        this.toolIndex.delete(toolName);
      }
    }

    this.skills.delete(skillName);
    return true;
  }
}
