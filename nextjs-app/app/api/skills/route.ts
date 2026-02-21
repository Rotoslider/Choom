import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { getSkillRegistry } from '@/lib/skill-registry';
import { loadCoreSkills } from '@/lib/skill-loader';
import { CUSTOM_SKILLS_ROOT } from '@/lib/config';

// Dynamic require that bypasses Turbopack's static module resolution
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const dynamicRequire = new Function('p', 'return require(p)') as (path: string) => Record<string, unknown>;

// Skill name validation: lowercase letters, numbers, hyphens, underscores only
const VALID_SKILL_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * GET /api/skills — List all skills from the registry
 */
export async function GET() {
  try {
    // Ensure skills are loaded
    loadCoreSkills();
    const registry = getSkillRegistry();

    const skillNames = registry.getSkillNames();
    const skills = skillNames.map((name) => {
      const skill = registry.getSkill(name);
      if (!skill) return null;

      return {
        name: skill.metadata.name,
        description: skill.metadata.description,
        version: skill.metadata.version,
        author: skill.metadata.author,
        type: skill.metadata.type,
        enabled: skill.metadata.enabled,
        toolCount: skill.toolDefinitions.length,
        tools: skill.toolDefinitions.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      };
    }).filter(Boolean);

    return NextResponse.json({ success: true, skills });
  } catch (error) {
    console.error('[Skills API] GET error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/skills — Create a new custom skill
 * Body: { name, description, tools: ToolDefinition[], handlerCode: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, tools, handlerCode } = body;

    // Validate name
    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Skill name is required' },
        { status: 400 }
      );
    }

    if (!VALID_SKILL_NAME.test(name)) {
      return NextResponse.json(
        { success: false, error: 'Skill name must be lowercase, start with a letter, and contain only letters, numbers, hyphens, and underscores' },
        { status: 400 }
      );
    }

    if (!description || typeof description !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Skill description is required' },
        { status: 400 }
      );
    }

    if (!Array.isArray(tools) || tools.length === 0) {
      return NextResponse.json(
        { success: false, error: 'At least one tool definition is required' },
        { status: 400 }
      );
    }

    if (!handlerCode || typeof handlerCode !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Handler code is required' },
        { status: 400 }
      );
    }

    // Prevent path traversal in name
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name: path traversal detected' },
        { status: 400 }
      );
    }

    // Check if skill already exists in the registry
    loadCoreSkills();
    const registry = getSkillRegistry();
    if (registry.getSkill(name)) {
      return NextResponse.json(
        { success: false, error: `Skill "${name}" already exists` },
        { status: 409 }
      );
    }

    // Create the custom skill directory
    const skillDir = path.join(CUSTOM_SKILLS_ROOT, name);
    const resolvedDir = path.resolve(skillDir);
    if (!resolvedDir.startsWith(CUSTOM_SKILLS_ROOT)) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill path: path traversal detected' },
        { status: 400 }
      );
    }

    fs.mkdirSync(resolvedDir, { recursive: true });

    // Build tool names list for frontmatter
    const toolNames = tools.map((t: { name: string }) => t.name);

    // Write SKILL.md
    const skillMd = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      'version: 1.0.0',
      'author: custom',
      'tools:',
      ...toolNames.map((t: string) => `  - ${t}`),
      'dependencies: []',
      '---',
      '',
      `# ${name}`,
      '',
      description,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(resolvedDir, 'SKILL.md'), skillMd, 'utf-8');

    // Write tools.ts
    const toolsSrc = [
      "import type { ToolDefinition } from '@/lib/types';",
      '',
      `export const tools: ToolDefinition[] = ${JSON.stringify(tools, null, 2)};`,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(resolvedDir, 'tools.ts'), toolsSrc, 'utf-8');

    // Write handler.ts (source for display/editing)
    fs.writeFileSync(path.join(resolvedDir, 'handler.ts'), handlerCode, 'utf-8');

    // Also write tools.js for runtime loading
    const toolsJsSrc = `// Auto-generated from tools.ts\nexports.tools = ${JSON.stringify(tools, null, 2)};\n`;
    fs.writeFileSync(path.join(resolvedDir, 'tools.js'), toolsJsSrc, 'utf-8');

    // Transpile handler.ts → handler.js using esbuild for runtime import
    let transpileError: string | null = null;
    try {
      // esbuild is available at runtime (ships with Next.js) but has no TS declarations
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const esbuild = dynamicRequire('esbuild') as { transform: (code: string, opts: Record<string, string>) => Promise<{ code: string }> };
      const result = await esbuild.transform(handlerCode, {
        loader: 'ts',
        target: 'node18',
        format: 'cjs',
      });
      fs.writeFileSync(path.join(resolvedDir, 'handler.js'), result.code, 'utf-8');
    } catch (err) {
      transpileError = err instanceof Error ? err.message : 'Transpilation failed';
      console.warn(`[Skills API] Failed to transpile handler for ${name}:`, transpileError);
    }

    // Register with the registry
    const metadata = {
      name,
      description,
      version: '1.0.0',
      author: 'custom',
      tools: toolNames,
      dependencies: [],
      type: 'custom' as const,
      enabled: true,
      path: resolvedDir,
    };

    // Try to load the transpiled handler.js at runtime
    let handler: Parameters<typeof registry.registerSkill>[3] | null = null;
    if (!transpileError) {
      try {
        const handlerJsPath = path.join(resolvedDir, 'handler.js');
        // Clear require cache for hot-reload
        // No cache clearing needed — dynamicRequire always reads fresh
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const handlerModule = dynamicRequire(handlerJsPath);
        const HandlerClass = handlerModule.default || Object.values(handlerModule).find(
          (v: unknown) => typeof v === 'function' && (v as { prototype: Record<string, unknown> }).prototype?.execute
        );
        if (HandlerClass && typeof HandlerClass === 'function') {
          handler = new (HandlerClass as new () => Parameters<typeof registry.registerSkill>[3])();
        }
      } catch (err) {
        console.warn(`[Skills API] Failed to load transpiled handler for ${name}:`, err instanceof Error ? err.message : err);
      }
    }

    // Fall back to placeholder if transpilation or loading failed
    if (!handler) {
      handler = {
        canHandle: (toolName: string) => toolNames.includes(toolName),
        execute: async () => ({
          toolCallId: '',
          name: '',
          result: null,
          error: transpileError
            ? `Custom skill handler transpilation failed: ${transpileError}`
            : 'Custom skill handler requires a reload to activate. POST /api/skills/reload first.',
        }),
        success: () => ({ toolCallId: '', name: '', result: null }),
        error: () => ({ toolCallId: '', name: '', result: null, error: '' }),
      } as unknown as Parameters<typeof registry.registerSkill>[3];
    }

    registry.registerSkill(
      metadata,
      description,
      tools,
      handler
    );

    return NextResponse.json({
      success: true,
      skill: {
        name,
        description,
        version: '1.0.0',
        author: 'custom',
        type: 'custom',
        enabled: true,
        toolCount: tools.length,
        tools: tools.map((t: { name: string; description: string }) => ({
          name: t.name,
          description: t.description,
        })),
        path: resolvedDir,
      },
    });
  } catch (error) {
    console.error('[Skills API] POST error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
