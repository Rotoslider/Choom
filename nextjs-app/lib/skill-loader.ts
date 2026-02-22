// Skill Loader
// Pre-registers all core skills with the SkillRegistry.
// This is necessary because Next.js cannot dynamically import .ts files at runtime.
// Called once at startup to populate the registry.

import * as path from 'path';
import * as fs from 'fs';
import { getSkillRegistry } from './skill-registry';
import type { SkillMetadata } from './skill-handler';
import { CUSTOM_SKILLS_ROOT } from './config';

// Use createRequire for loading custom skill handler.js files at runtime.
// Turbopack compiles server code as ESM where `require` is not defined,
// so `new Function('p','return require(p)')` fails with "require is not defined".
// createRequire creates a proper CJS require function that works in ESM contexts.
import { createRequire } from 'module';
const nodeRequire = createRequire(import.meta.url || __filename);

// Import all core skill tools
import { tools as memoryTools } from '@/skills/core/memory-management/tools';
import { tools as imageGenTools } from '@/skills/core/image-generation/tools';
import { tools as webSearchTools } from '@/skills/core/web-searching/tools';
import { tools as weatherTools } from '@/skills/core/weather-forecasting/tools';
import { tools as calendarTools } from '@/skills/core/google-calendar/tools';
import { tools as tasksTools } from '@/skills/core/google-tasks/tools';
import { tools as sheetsTools } from '@/skills/core/google-sheets/tools';
import { tools as docsTools } from '@/skills/core/google-docs/tools';
import { tools as driveTools } from '@/skills/core/google-drive/tools';
import { tools as workspaceTools } from '@/skills/core/workspace-files/tools';
import { tools as pdfTools } from '@/skills/core/pdf-processing/tools';
import { tools as scrapingTools } from '@/skills/core/web-scraping/tools';
import { tools as visionTools } from '@/skills/core/image-analysis/tools';
import { tools as sandboxTools } from '@/skills/core/code-execution/tools';
import { tools as notifTools } from '@/skills/core/notifications/tools';
import { tools as reminderTools } from '@/skills/core/reminders/tools';
import { tools as gmailTools } from '@/skills/core/google-gmail/tools';
import { tools as contactsTools } from '@/skills/core/google-contacts/tools';
import { tools as youtubeTools } from '@/skills/core/google-youtube/tools';
import { tools as planModeTools } from '@/skills/core/plan-mode/tools';
import { tools as homeAssistantTools } from '@/skills/core/home-assistant/tools';

// Import all core skill handlers
import { default as MemoryHandler } from '@/skills/core/memory-management/handler';
import { default as ImageGenHandler } from '@/skills/core/image-generation/handler';
import { default as WebSearchHandler } from '@/skills/core/web-searching/handler';
import { default as WeatherHandler } from '@/skills/core/weather-forecasting/handler';
import { default as CalendarHandler } from '@/skills/core/google-calendar/handler';
import { default as TasksHandler } from '@/skills/core/google-tasks/handler';
import { default as SheetsHandler } from '@/skills/core/google-sheets/handler';
import { default as DocsHandler } from '@/skills/core/google-docs/handler';
import { default as DriveHandler } from '@/skills/core/google-drive/handler';
import { default as WorkspaceHandler } from '@/skills/core/workspace-files/handler';
import { default as PdfHandler } from '@/skills/core/pdf-processing/handler';
import { default as ScrapingHandler } from '@/skills/core/web-scraping/handler';
import { default as VisionHandler } from '@/skills/core/image-analysis/handler';
import { default as SandboxHandler } from '@/skills/core/code-execution/handler';
import { default as NotifHandler } from '@/skills/core/notifications/handler';
import { default as ReminderHandler } from '@/skills/core/reminders/handler';
import { default as GmailHandler } from '@/skills/core/google-gmail/handler';
import { default as ContactsHandler } from '@/skills/core/google-contacts/handler';
import { default as YouTubeHandler } from '@/skills/core/google-youtube/handler';
import { default as PlanModeHandler } from '@/skills/core/plan-mode/handler';
import { default as HomeAssistantHandler } from '@/skills/core/home-assistant/handler';

// ============================================================================
// YAML Frontmatter Parser (minimal)
// ============================================================================

function parseYAMLFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlStr = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');
  let currentKey = '';
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') && currentArray !== null) {
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    if (currentArray !== null) {
      frontmatter[currentKey] = currentArray;
      currentArray = null;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value === '' || value === '[]') {
        currentKey = key;
        currentArray = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      } else {
        frontmatter[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  if (currentArray !== null) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body };
}

// ============================================================================
// Skill Registration
// ============================================================================

interface SkillDef {
  dirName: string;
  tools: typeof memoryTools;
  handler: typeof MemoryHandler;
}

const CORE_SKILLS: SkillDef[] = [
  { dirName: 'memory-management', tools: memoryTools, handler: MemoryHandler },
  { dirName: 'image-generation', tools: imageGenTools, handler: ImageGenHandler },
  { dirName: 'web-searching', tools: webSearchTools, handler: WebSearchHandler },
  { dirName: 'weather-forecasting', tools: weatherTools, handler: WeatherHandler },
  { dirName: 'google-calendar', tools: calendarTools, handler: CalendarHandler },
  { dirName: 'google-tasks', tools: tasksTools, handler: TasksHandler },
  { dirName: 'google-sheets', tools: sheetsTools, handler: SheetsHandler },
  { dirName: 'google-docs', tools: docsTools, handler: DocsHandler },
  { dirName: 'google-drive', tools: driveTools, handler: DriveHandler },
  { dirName: 'workspace-files', tools: workspaceTools, handler: WorkspaceHandler },
  { dirName: 'pdf-processing', tools: pdfTools, handler: PdfHandler },
  { dirName: 'web-scraping', tools: scrapingTools, handler: ScrapingHandler },
  { dirName: 'image-analysis', tools: visionTools, handler: VisionHandler },
  { dirName: 'code-execution', tools: sandboxTools, handler: SandboxHandler },
  { dirName: 'notifications', tools: notifTools, handler: NotifHandler },
  { dirName: 'reminders', tools: reminderTools, handler: ReminderHandler },
  { dirName: 'google-gmail', tools: gmailTools, handler: GmailHandler },
  { dirName: 'google-contacts', tools: contactsTools, handler: ContactsHandler },
  { dirName: 'google-youtube', tools: youtubeTools, handler: YouTubeHandler },
  { dirName: 'plan-mode', tools: planModeTools, handler: PlanModeHandler },
  { dirName: 'home-assistant', tools: homeAssistantTools, handler: HomeAssistantHandler },
];

let loaded = false;

/**
 * Load and register all core skills with the SkillRegistry.
 * Safe to call multiple times — only loads once.
 */
export function loadCoreSkills(): void {
  if (loaded) return;

  const registry = getSkillRegistry();
  const skillsDir = path.join(process.cwd(), 'skills', 'core');

  for (const skill of CORE_SKILLS) {
    try {
      const skillPath = path.join(skillsDir, skill.dirName);
      const skillMdPath = path.join(skillPath, 'SKILL.md');

      let fullDoc = '';
      let frontmatter: Record<string, unknown> = {};

      if (fs.existsSync(skillMdPath)) {
        const content = fs.readFileSync(skillMdPath, 'utf-8');
        const parsed = parseYAMLFrontmatter(content);
        frontmatter = parsed.frontmatter;
        fullDoc = parsed.body;
      }

      const metadata: SkillMetadata = {
        name: (frontmatter.name as string) || skill.dirName,
        description: (frontmatter.description as string) || '',
        version: (frontmatter.version as string) || '1.0.0',
        author: (frontmatter.author as string) || 'system',
        tools: (frontmatter.tools as string[]) || skill.tools.map(t => t.name),
        dependencies: (frontmatter.dependencies as string[]) || [],
        type: 'core',
        enabled: true,
        path: skillPath,
      };

      // Instantiate handler if it's a class (constructor), otherwise use directly
      const handler = typeof skill.handler === 'function'
        ? new (skill.handler as unknown as new () => InstanceType<typeof MemoryHandler>)()
        : skill.handler;

      registry.registerSkill(metadata, fullDoc, skill.tools, handler);
    } catch (err) {
      console.warn(`[SkillLoader] Failed to load ${skill.dirName}:`, err instanceof Error ? err.message : err);
    }
  }

  loaded = true;
  console.log(`[SkillLoader] Registered ${registry.getToolCount()} tools from ${registry.getSkillNames().length} core skills`);
}

/**
 * Load custom skills from CUSTOM_SKILLS_ROOT into the registry.
 * Scans the .choom-skills directory for skill folders with SKILL.md + tools.js + handler.js.
 * Safe to call multiple times — skips skills already in the registry.
 */
let customLoaded = false;

export function loadCustomSkills(): void {
  if (customLoaded) return;
  if (!fs.existsSync(CUSTOM_SKILLS_ROOT)) return;
  console.log(`[SkillLoader] Scanning custom skills in ${CUSTOM_SKILLS_ROOT}`);

  const registry = getSkillRegistry();
  const entries = fs.readdirSync(CUSTOM_SKILLS_ROOT, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip if already registered WITH tools (e.g., just created in-memory via POST).
    // Re-load if registered but has 0 tools (stale registration from failed creation).
    const existing = registry.getSkill(entry.name);
    if (existing && existing.toolDefinitions.length > 0) continue;

    const skillPath = path.join(CUSTOM_SKILLS_ROOT, entry.name);
    const skillMdPath = path.join(skillPath, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const parsed = parseYAMLFrontmatter(content);
      const frontmatter = parsed.frontmatter;

      const metadata: SkillMetadata = {
        name: (frontmatter.name as string) || entry.name,
        description: (frontmatter.description as string) || '',
        version: (frontmatter.version as string) || '1.0.0',
        author: (frontmatter.author as string) || 'custom',
        tools: (frontmatter.tools as string[]) || [],
        dependencies: (frontmatter.dependencies as string[]) || [],
        type: 'custom',
        enabled: true,
        path: skillPath,
      };

      // Load tool definitions from tools.js by extracting the JSON array.
      // We read the file as text and parse the JSON portion because dynamicRequire
      // fails for files outside the project tree in Turbopack.
      let toolDefinitions: typeof memoryTools = [];
      const toolsJsPath = path.join(skillPath, 'tools.js');
      if (fs.existsSync(toolsJsPath)) {
        try {
          const toolsSrc = fs.readFileSync(toolsJsPath, 'utf-8');
          // Extract the JSON array from "exports.tools = [...];" or "module.exports = [...];"
          const jsonMatch = toolsSrc.match(/=\s*(\[[\s\S]*\])\s*;?\s*$/);
          if (jsonMatch) {
            toolDefinitions = JSON.parse(jsonMatch[1]) as typeof memoryTools;
          }
        } catch (err) {
          console.warn(`[SkillLoader] Cannot parse tools.js for ${entry.name}:`, err instanceof Error ? err.message : err);
        }
      }

      // Load the bundled handler.js. Since esbuild --bundle creates a self-contained
      // CJS file with all project deps inlined, dynamicRequire only needs to resolve
      // Node.js builtins — no Turbopack resolution needed.
      const handlerJsPath = path.join(skillPath, 'handler.js');
      const hasHandlerJs = fs.existsSync(handlerJsPath);
      const toolNames = metadata.tools;
      const skillName = entry.name;
      let loadedHandler: InstanceType<typeof MemoryHandler> | null = null;

      // Try to load immediately (bundled handlers should work at boot time)
      if (hasHandlerJs) {
        try {
          const handlerModule = nodeRequire(handlerJsPath);
          const HandlerClass = handlerModule.default || Object.values(handlerModule).find(
            (v: unknown) => typeof v === 'function' && (v as { prototype: Record<string, unknown> }).prototype?.execute
          );
          if (HandlerClass && typeof HandlerClass === 'function') {
            loadedHandler = new (HandlerClass as new () => InstanceType<typeof MemoryHandler>)();
            console.log(`[SkillLoader] Loaded handler for ${skillName}`);
          }
        } catch (err) {
          console.warn(`[SkillLoader] Cannot load handler for ${skillName}:`, err instanceof Error ? err.message : err);
        }
      }

      const handler = loadedHandler || {
        canHandle: (toolName: string) => toolNames.includes(toolName),
        execute: async (toolCall: unknown) => ({
          toolCallId: (toolCall as { id: string }).id || '',
          name: (toolCall as { name: string }).name || '',
          result: null,
          error: `Handler for custom skill "${skillName}" could not be loaded. Try re-creating the skill or POST /api/skills/reload.`,
        }),
        success: () => ({ toolCallId: '', name: '', result: null }),
        error: () => ({ toolCallId: '', name: '', result: null, error: '' }),
      } as unknown as InstanceType<typeof MemoryHandler>;

      // Remove stale registration before re-registering
      if (registry.getSkill(entry.name)) {
        registry.unregisterSkill(entry.name);
      }
      registry.registerSkill(metadata, parsed.body, toolDefinitions, handler);
      console.log(`[SkillLoader] Loaded custom skill: ${entry.name} (${toolDefinitions.length} tools)`);
    } catch (err) {
      console.warn(`[SkillLoader] Failed to load custom skill ${entry.name}:`, err instanceof Error ? err.message : err);
    }
  }
  customLoaded = true;
}

/**
 * Reset the custom loaded flag (for hot-reload).
 */
export function resetCustomSkillsLoaded(): void {
  customLoaded = false;
}

/**
 * Check if core skills have been loaded.
 */
export function areCoreSkillsLoaded(): boolean {
  return loaded;
}

/**
 * Reset the loaded flag so loadCoreSkills() can run again.
 * Used by the hot-reload API route.
 */
export function resetCoreSkillsLoaded(): void {
  loaded = false;
}
