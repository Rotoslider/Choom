import { NextRequest, NextResponse } from 'next/server';
import { getSkillRegistry } from '@/lib/skill-registry';
import { loadCoreSkills } from '@/lib/skill-loader';
import type { ToolCall } from '@/lib/types';
import type { SkillHandlerContext } from '@/lib/skill-handler';
import { MemoryClient } from '@/lib/memory-client';

/**
 * POST /api/skills/[skillName]/test — Test a tool from a skill
 * Body: { toolName: string, arguments: Record<string, unknown> }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ skillName: string }> }
) {
  try {
    const { skillName } = await params;

    // Validate skill name
    if (!skillName || !/^[a-z][a-z0-9_-]*$/.test(skillName)) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name' },
        { status: 400 }
      );
    }

    loadCoreSkills();
    const registry = getSkillRegistry();
    const skill = registry.getSkill(skillName);

    if (!skill) {
      return NextResponse.json(
        { success: false, error: `Skill "${skillName}" not found` },
        { status: 404 }
      );
    }

    if (!skill.handler) {
      return NextResponse.json(
        { success: false, error: `Skill "${skillName}" has no handler loaded. Try reloading skills first.` },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { toolName, arguments: toolArgs } = body;

    if (!toolName || typeof toolName !== 'string') {
      return NextResponse.json(
        { success: false, error: 'toolName is required' },
        { status: 400 }
      );
    }

    // Verify this tool belongs to this skill
    if (!skill.handler.canHandle(toolName)) {
      return NextResponse.json(
        { success: false, error: `Tool "${toolName}" is not handled by skill "${skillName}"` },
        { status: 400 }
      );
    }

    // Verify the tool exists in the skill's definitions
    const toolDef = skill.toolDefinitions.find((t) => t.name === toolName);
    if (!toolDef) {
      return NextResponse.json(
        { success: false, error: `Tool "${toolName}" not found in skill "${skillName}" definitions` },
        { status: 404 }
      );
    }

    // Build a minimal ToolCall
    const toolCall: ToolCall = {
      id: `test-${Date.now()}`,
      name: toolName,
      arguments: toolArgs || {},
    };

    // Build a minimal test context
    // NOTE: This is a simplified context for testing purposes.
    // Some tools may fail if they depend on specific context values.
    const testCtx: SkillHandlerContext = {
      memoryClient: new MemoryClient('http://localhost:7437'),
      memoryCompanionId: 'test',
      weatherSettings: {
        apiKey: '',
        provider: 'openweathermap',
        location: '',
        units: 'imperial',
        cacheMinutes: 30,
      },
      settings: {},
      imageGenSettings: {
        endpoint: '',
        defaultCheckpoint: '',
        defaultSampler: '',
        defaultScheduler: '',
        defaultSteps: 20,
        defaultCfgScale: 7,
        defaultDistilledCfg: 3.5,
        defaultWidth: 1024,
        defaultHeight: 1024,
        defaultNegativePrompt: '',
        selfPortrait: {
          enabled: false,
          checkpoint: '',
          sampler: '',
          scheduler: '',
          steps: 20,
          cfgScale: 7,
          distilledCfg: 3.5,
          width: 1024,
          height: 1024,
          negativePrompt: '',
          loras: [],
          promptPrefix: '',
          promptSuffix: '',
        },
      },
      choom: {},
      choomId: 'test',
      chatId: 'test',
      message: `Testing tool: ${toolName}`,
      send: () => {}, // No-op for test
      sessionFileCount: { created: 0, maxAllowed: 50 },
      skillDoc: skill.fullDoc,
      getReference: async (fileName: string) => registry.getLevel3Reference(skillName, fileName),
    };

    // Execute the tool
    const startTime = Date.now();
    const result = await skill.handler.execute(toolCall, testCtx);
    const duration = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      toolName,
      skillName,
      duration,
      result: result.result,
      error: result.error || null,
    });
  } catch (error) {
    console.error('[Skills API] POST test error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
