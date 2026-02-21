import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { SkillInstaller } from '@/lib/skill-installer';
import { getSkillRegistry } from '@/lib/skill-registry';
import { loadCoreSkills } from '@/lib/skill-loader';

// Dynamic require that bypasses Turbopack's static module resolution
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const dynamicRequire = new Function('p', 'return require(p)') as (path: string) => Record<string, unknown>;

// ============================================================================
// POST /api/skills/install — Install an external skill from a GitHub URL
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { source } = body;

    if (!source || typeof source !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing required field: source (GitHub URL)' },
        { status: 400 }
      );
    }

    // Validate it looks like a GitHub URL
    if (!source.startsWith('https://github.com/')) {
      return NextResponse.json(
        { success: false, error: 'Source must be a GitHub URL (https://github.com/owner/repo/...)' },
        { status: 400 }
      );
    }

    const installer = new SkillInstaller();

    // Step 1: Fetch the skill package from GitHub
    console.log(`[Skills Install API] Fetching skill from: ${source}`);
    let pkg;
    try {
      pkg = await installer.fetch(source);
    } catch (fetchError) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to fetch skill: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`,
        },
        { status: 400 }
      );
    }

    // Step 2: Check if skill already exists
    loadCoreSkills();
    const registry = getSkillRegistry();
    const existingSkill = registry.getSkill(pkg.metadata.name);
    if (existingSkill) {
      return NextResponse.json(
        {
          success: false,
          error: `Skill "${pkg.metadata.name}" already exists in the registry (type: ${existingSkill.metadata.type}). Uninstall it first.`,
        },
        { status: 409 }
      );
    }

    // Step 3: Run safety verification
    console.log(`[Skills Install API] Verifying skill "${pkg.metadata.name}"...`);
    const report = installer.verify(pkg);

    // If there are blockers, reject the installation
    if (!report.safe) {
      return NextResponse.json(
        {
          success: false,
          error: 'Skill failed safety verification — installation blocked',
          report: {
            safe: report.safe,
            blockers: report.blockers,
            warnings: report.warnings,
            scannedFiles: report.scannedFiles,
          },
        },
        { status: 400 }
      );
    }

    // Step 4: Install the skill
    console.log(`[Skills Install API] Installing skill "${pkg.metadata.name}"...`);
    await installer.install(pkg);

    // Step 5: Register with the skill registry so it's available immediately
    // The skill will also be loaded on next full reload via loadAll()
    const metadata = {
      name: pkg.metadata.name,
      description: pkg.metadata.description,
      version: pkg.metadata.version,
      author: pkg.metadata.author,
      tools: pkg.metadata.tools,
      dependencies: [],
      type: 'external' as const,
      enabled: true,
      path: `${installer.getExternalRoot()}/${pkg.metadata.name}`,
    };

    // Transpile handler.ts → handler.js if needed
    const skillPath = `${installer.getExternalRoot()}/${pkg.metadata.name}`;
    const handlerTsPath = path.join(skillPath, 'handler.ts');
    const handlerJsPath = path.join(skillPath, 'handler.js');
    if (fs.existsSync(handlerTsPath) && !fs.existsSync(handlerJsPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const esbuild = dynamicRequire('esbuild') as { transform: (code: string, opts: Record<string, string>) => Promise<{ code: string }> };
        const handlerSrc = fs.readFileSync(handlerTsPath, 'utf-8');
        const result = await esbuild.transform(handlerSrc, {
          loader: 'ts',
          target: 'node18',
          format: 'cjs',
        });
        fs.writeFileSync(handlerJsPath, result.code, 'utf-8');
        console.log(`[Skills Install API] Transpiled handler for "${pkg.metadata.name}"`);
      } catch (err) {
        console.warn(`[Skills Install API] Failed to transpile handler:`, err instanceof Error ? err.message : err);
      }
    }

    // Also write tools.js if only tools.ts exists
    const toolsTsPath = path.join(skillPath, 'tools.ts');
    const toolsJsPath = path.join(skillPath, 'tools.js');
    if (fs.existsSync(toolsTsPath) && !fs.existsSync(toolsJsPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const esbuild = dynamicRequire('esbuild') as { transform: (code: string, opts: Record<string, string>) => Promise<{ code: string }> };
        const toolsSrc = fs.readFileSync(toolsTsPath, 'utf-8');
        const result = await esbuild.transform(toolsSrc, {
          loader: 'ts',
          target: 'node18',
          format: 'cjs',
        });
        fs.writeFileSync(toolsJsPath, result.code, 'utf-8');
      } catch (err) {
        console.warn(`[Skills Install API] Failed to transpile tools:`, err instanceof Error ? err.message : err);
      }
    }

    // Try to load the transpiled handler and tools for immediate use
    let handler: Parameters<typeof registry.registerSkill>[3] | null = null;
    let toolDefs: Parameters<typeof registry.registerSkill>[2] = [];
    let fullDoc = '';

    // Load fullDoc from SKILL.md
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const bodyMatch = content.match(/^---[\s\S]*?---\r?\n([\s\S]*)$/);
      fullDoc = bodyMatch ? bodyMatch[1] : content;
    }

    // Load tools
    if (fs.existsSync(toolsJsPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const toolsModule = dynamicRequire(toolsJsPath) as Record<string, unknown>;
        toolDefs = (toolsModule.tools || toolsModule.default || []) as typeof toolDefs;
      } catch {
        // will fall back to empty
      }
    }

    // Load handler
    if (fs.existsSync(handlerJsPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const handlerModule = dynamicRequire(handlerJsPath);
        const HandlerClass = handlerModule.default || Object.values(handlerModule).find(
          (v: unknown) => typeof v === 'function' && (v as { prototype: Record<string, unknown> }).prototype?.execute
        );
        if (HandlerClass && typeof HandlerClass === 'function') {
          handler = new (HandlerClass as new () => Parameters<typeof registry.registerSkill>[3])();
        }
      } catch (err) {
        console.warn(`[Skills Install API] Failed to load handler:`, err instanceof Error ? err.message : err);
      }
    }

    // Fall back to placeholder if handler couldn't be loaded
    if (!handler) {
      const toolNames = pkg.metadata.tools;
      handler = {
        canHandle: (toolName: string) => toolNames.includes(toolName),
        execute: async () => ({
          toolCallId: '',
          name: '',
          result: null,
          error: 'External skill handler requires a reload to activate. POST /api/skills/reload first.',
        }),
        success: () => ({ toolCallId: '', name: '', result: null }),
        error: () => ({ toolCallId: '', name: '', result: null, error: '' }),
      } as unknown as Parameters<typeof registry.registerSkill>[3];
    }

    registry.registerSkill(
      metadata,
      fullDoc,
      toolDefs,
      handler
    );

    console.log(`[Skills Install API] Successfully installed "${pkg.metadata.name}"`);

    return NextResponse.json({
      success: true,
      message: `External skill "${pkg.metadata.name}" installed successfully`,
      skill: {
        name: pkg.metadata.name,
        description: pkg.metadata.description,
        version: pkg.metadata.version,
        author: pkg.metadata.author,
        tools: pkg.metadata.tools,
        source: pkg.source,
        fileCount: pkg.files.length,
      },
      report: {
        safe: report.safe,
        blockers: report.blockers,
        warnings: report.warnings,
        scannedFiles: report.scannedFiles,
      },
      note: report.warnings.length > 0
        ? 'Skill installed with warnings. Review the warnings above.'
        : undefined,
    });
  } catch (error) {
    console.error('[Skills Install API] POST error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// DELETE /api/skills/install — Uninstall an external skill
// ============================================================================

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { skillName } = body;

    if (!skillName || typeof skillName !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing required field: skillName' },
        { status: 400 }
      );
    }

    // Validate name format
    if (skillName.includes('..') || skillName.includes('/') || skillName.includes('\\')) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name: path traversal detected' },
        { status: 400 }
      );
    }

    const installer = new SkillInstaller();

    // Check if it's actually installed
    const meta = installer.getInstalledMeta(skillName);
    if (!meta) {
      return NextResponse.json(
        { success: false, error: `External skill "${skillName}" is not installed` },
        { status: 404 }
      );
    }

    // Uninstall from disk
    console.log(`[Skills Install API] Uninstalling skill "${skillName}"...`);
    await installer.uninstall(skillName);

    // Remove from the registry
    loadCoreSkills();
    const registry = getSkillRegistry();
    const removed = registry.unregisterSkill(skillName);

    console.log(`[Skills Install API] Uninstalled "${skillName}" (registry removed: ${removed})`);

    return NextResponse.json({
      success: true,
      message: `External skill "${skillName}" uninstalled successfully`,
      removedFromRegistry: removed,
    });
  } catch (error) {
    console.error('[Skills Install API] DELETE error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// GET /api/skills/install — List all installed external skills
// ============================================================================

export async function GET() {
  try {
    const installer = new SkillInstaller();
    const installed = installer.listInstalled();

    return NextResponse.json({
      success: true,
      skills: installed,
      count: installed.length,
    });
  } catch (error) {
    console.error('[Skills Install API] GET error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
