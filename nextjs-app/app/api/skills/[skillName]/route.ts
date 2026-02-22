import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { getSkillRegistry } from '@/lib/skill-registry';
import { loadCoreSkills, loadCustomSkills } from '@/lib/skill-loader';
import { CUSTOM_SKILLS_ROOT } from '@/lib/config';
import { createRequire } from 'module';
const nodeRequire = createRequire(import.meta.url || __filename);

// Validate skill name to prevent path traversal
function isValidSkillName(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(name) && !name.includes('..');
}

/**
 * GET /api/skills/[skillName] — Read a single skill's full details
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ skillName: string }> }
) {
  try {
    const { skillName } = await params;

    if (!isValidSkillName(skillName)) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name' },
        { status: 400 }
      );
    }

    // Ensure skills are loaded (core + custom from .choom-skills)
    loadCoreSkills();
    loadCustomSkills();
    const registry = getSkillRegistry();
    const skill = registry.getSkill(skillName);

    if (!skill) {
      return NextResponse.json(
        { success: false, error: `Skill "${skillName}" not found` },
        { status: 404 }
      );
    }

    // Read source files from the skill's directory
    const skillPath = skill.metadata.path;
    let skillMdContent = '';
    let toolsSource = '';
    let handlerSource = '';

    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      skillMdContent = fs.readFileSync(skillMdPath, 'utf-8');
    }

    // Try .ts first, then .js
    const toolsTsPath = path.join(skillPath, 'tools.ts');
    const toolsJsPath = path.join(skillPath, 'tools.js');
    if (fs.existsSync(toolsTsPath)) {
      toolsSource = fs.readFileSync(toolsTsPath, 'utf-8');
    } else if (fs.existsSync(toolsJsPath)) {
      toolsSource = fs.readFileSync(toolsJsPath, 'utf-8');
    }

    const handlerTsPath = path.join(skillPath, 'handler.ts');
    const handlerJsPath = path.join(skillPath, 'handler.js');
    if (fs.existsSync(handlerTsPath)) {
      handlerSource = fs.readFileSync(handlerTsPath, 'utf-8');
    } else if (fs.existsSync(handlerJsPath)) {
      handlerSource = fs.readFileSync(handlerJsPath, 'utf-8');
    }

    return NextResponse.json({
      success: true,
      skill: {
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
          parameters: t.parameters,
        })),
        path: skill.metadata.path,
        // Source files
        skillMd: skillMdContent,
        toolsSource,
        handlerSource,
        fullDoc: skill.fullDoc,
      },
    });
  } catch (error) {
    console.error('[Skills API] GET [skillName] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/skills/[skillName] — Update a skill (only custom/external)
 * Body: { description?, tools?: ToolDefinition[], handlerCode?: string, enabled?: boolean }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ skillName: string }> }
) {
  try {
    const { skillName } = await params;

    if (!isValidSkillName(skillName)) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name' },
        { status: 400 }
      );
    }

    loadCoreSkills();
    loadCustomSkills();
    const registry = getSkillRegistry();
    const skill = registry.getSkill(skillName);

    if (!skill) {
      return NextResponse.json(
        { success: false, error: `Skill "${skillName}" not found` },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { description, tools, handlerCode, enabled } = body;

    // Handle enable/disable toggle (allowed for ALL skill types including core)
    if (typeof enabled === 'boolean') {
      registry.setEnabled(skillName, enabled);
    }

    // Core skills: only allow enable/disable toggle, block all other edits
    if (skill.metadata.type === 'core') {
      if (description || tools || handlerCode) {
        return NextResponse.json(
          { success: false, error: 'Core skills cannot be edited (only enable/disable is allowed)' },
          { status: 403 }
        );
      }
      // Return current state after toggle
      return NextResponse.json({
        success: true,
        skill: {
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
        },
      });
    }

    const skillDir = skill.metadata.path;

    // Verify the path is within the custom skills root (security check)
    const resolvedDir = path.resolve(skillDir);
    if (!resolvedDir.startsWith(CUSTOM_SKILLS_ROOT) && skill.metadata.type === 'custom') {
      return NextResponse.json(
        { success: false, error: 'Invalid skill path' },
        { status: 400 }
      );
    }

    // Update SKILL.md if description or tools changed
    if (description || tools) {
      const newDescription = description || skill.metadata.description;
      const toolNames = tools
        ? tools.map((t: { name: string }) => t.name)
        : skill.metadata.tools;

      const skillMd = [
        '---',
        `name: ${skillName}`,
        `description: ${newDescription}`,
        `version: ${skill.metadata.version}`,
        `author: ${skill.metadata.author}`,
        'tools:',
        ...toolNames.map((t: string) => `  - ${t}`),
        'dependencies: []',
        '---',
        '',
        `# ${skillName}`,
        '',
        newDescription,
        '',
      ].join('\n');

      fs.writeFileSync(path.join(resolvedDir, 'SKILL.md'), skillMd, 'utf-8');

      // Update metadata in-place
      if (description) {
        skill.metadata.description = description;
      }
      if (tools) {
        skill.metadata.tools = toolNames;
      }
    }

    // Update tools if changed
    if (tools && Array.isArray(tools)) {
      const toolsSrc = [
        "import type { ToolDefinition } from '@/lib/types';",
        '',
        `export const tools: ToolDefinition[] = ${JSON.stringify(tools, null, 2)};`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(resolvedDir, 'tools.ts'), toolsSrc, 'utf-8');

      // Also update tools.js for runtime loading
      const toolsJsSrc = `// Auto-generated from tools.ts\nexports.tools = ${JSON.stringify(tools, null, 2)};\n`;
      fs.writeFileSync(path.join(resolvedDir, 'tools.js'), toolsJsSrc, 'utf-8');

      // Update in-memory tool definitions
      skill.toolDefinitions = tools;
    }

    // Update handler if changed — write .ts source and re-bundle to .js
    if (handlerCode && typeof handlerCode === 'string') {
      const handlerTsPath = path.join(resolvedDir, 'handler.ts');
      const handlerJsPath = path.join(resolvedDir, 'handler.js');
      fs.writeFileSync(handlerTsPath, handlerCode, 'utf-8');

      try {
        const appRoot = process.cwd();
        const esbuild = nodeRequire('esbuild') as {
          buildSync: (opts: Record<string, unknown>) => { errors: { text: string }[] };
        };
        esbuild.buildSync({
          entryPoints: [handlerTsPath],
          outfile: handlerJsPath,
          bundle: true,
          platform: 'node',
          target: 'node18',
          format: 'cjs',
          alias: { '@': appRoot },
          external: ['fs', 'fs/promises', 'path', 'os', 'child_process', 'crypto', 'stream',
            'http', 'https', 'url', 'util', 'events', 'buffer', 'net', 'tls'],
          logLevel: 'warning',
        });
      } catch (err) {
        console.warn(`[Skills API] Failed to re-bundle handler for ${skillName}:`, err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json({
      success: true,
      skill: {
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
      },
    });
  } catch (error) {
    console.error('[Skills API] PUT [skillName] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/skills/[skillName] — Delete a custom skill
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ skillName: string }> }
) {
  try {
    const { skillName } = await params;

    if (!isValidSkillName(skillName)) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name' },
        { status: 400 }
      );
    }

    loadCoreSkills();
    loadCustomSkills();
    const registry = getSkillRegistry();
    const skill = registry.getSkill(skillName);

    if (!skill) {
      return NextResponse.json(
        { success: false, error: `Skill "${skillName}" not found` },
        { status: 404 }
      );
    }

    // Only custom skills can be deleted via API
    if (skill.metadata.type === 'core') {
      return NextResponse.json(
        { success: false, error: 'Core skills cannot be deleted' },
        { status: 403 }
      );
    }

    if (skill.metadata.type === 'external') {
      return NextResponse.json(
        { success: false, error: 'External skills must be uninstalled, not deleted' },
        { status: 403 }
      );
    }

    // Verify path is within custom skills root before deleting
    const resolvedDir = path.resolve(skill.metadata.path);
    if (!resolvedDir.startsWith(CUSTOM_SKILLS_ROOT)) {
      return NextResponse.json(
        { success: false, error: 'Cannot delete skill: path outside custom skills directory' },
        { status: 400 }
      );
    }

    // Remove directory
    if (fs.existsSync(resolvedDir)) {
      fs.rmSync(resolvedDir, { recursive: true, force: true });
    }

    // Unregister from registry
    registry.unregisterSkill(skillName);

    return NextResponse.json({
      success: true,
      message: `Skill "${skillName}" deleted`,
    });
  } catch (error) {
    console.error('[Skills API] DELETE [skillName] error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
