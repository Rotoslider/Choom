import { NextRequest, NextResponse } from 'next/server';
import { getSkillRegistry } from '@/lib/skill-registry';
import { loadCoreSkills } from '@/lib/skill-loader';
import { SkillEvalRunner } from '@/lib/skill-eval';
import type { SkillHandlerContext } from '@/lib/skill-handler';
import { MemoryClient } from '@/lib/memory-client';

/**
 * Build a minimal test context for running evals.
 * Similar to the test route but with no-op functions for non-essential services.
 */
function buildEvalContext(skillName: string): SkillHandlerContext {
  const registry = getSkillRegistry();
  const skill = registry.getSkill(skillName);

  return {
    memoryClient: new MemoryClient('http://localhost:7437'),
    memoryCompanionId: 'eval-runner',
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
    choomId: 'eval-runner',
    chatId: 'eval-runner',
    message: `Running evals for skill: ${skillName}`,
    send: () => {},
    sessionFileCount: { created: 0, maxAllowed: 50 },
    skillDoc: skill?.fullDoc ?? '',
    getReference: async (fileName: string) => registry.getLevel3Reference(skillName, fileName),
  };
}

/**
 * GET /api/skills/[skillName]/eval — Get auto-generated evals for a skill (without running them)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ skillName: string }> }
) {
  try {
    const { skillName } = await params;

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

    const runner = new SkillEvalRunner();
    const evals = runner.autoGenerate(skill.toolDefinitions, skillName);

    return NextResponse.json({
      success: true,
      skillName,
      evalCount: evals.length,
      evals: evals.map((e) => ({
        id: e.id,
        toolName: e.toolName,
        description: e.description,
        auto: e.auto,
        expectedSuccess: e.expected.success,
        arguments: e.input.arguments,
      })),
    });
  } catch (error) {
    console.error('[Skills Eval API] GET error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/skills/[skillName]/eval — Run evals for a skill
 * Body (optional): { evalIds?: string[] } — run specific evals only, or all if omitted
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ skillName: string }> }
) {
  try {
    const { skillName } = await params;

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
        { success: false, error: `Skill "${skillName}" has no handler loaded` },
        { status: 400 }
      );
    }

    // Parse optional body
    let evalIds: string[] | undefined;
    try {
      const body = await request.json();
      evalIds = body.evalIds;
    } catch {
      // No body or invalid JSON — run all evals
    }

    const runner = new SkillEvalRunner();
    const ctx = buildEvalContext(skillName);
    const suite = await runner.buildAndRun(skillName, skill.toolDefinitions, skill.handler, ctx);

    // Filter results if specific evalIds requested
    let filteredResults = suite.results;
    let filteredEvals = suite.evals;
    if (evalIds && Array.isArray(evalIds) && evalIds.length > 0) {
      const idSet = new Set(evalIds);
      filteredResults = suite.results.filter((r) => idSet.has(r.evalId));
      filteredEvals = suite.evals.filter((e) => idSet.has(e.id));
    }

    const passed = filteredResults.filter((r) => r.passed).length;
    const failed = filteredResults.length - passed;

    return NextResponse.json({
      success: true,
      skillName,
      generatedAt: suite.generatedAt,
      summary: {
        total: filteredResults.length,
        passed,
        failed,
        passRate: filteredResults.length > 0
          ? Math.round((passed / filteredResults.length) * 100)
          : 100,
      },
      results: filteredResults.map((r) => {
        const evalDef = filteredEvals.find((e) => e.id === r.evalId);
        return {
          evalId: r.evalId,
          toolName: evalDef?.toolName,
          description: evalDef?.description,
          passed: r.passed,
          duration: r.duration,
          reason: r.reason || null,
          actual: {
            success: r.actual.success,
            hasResult: r.actual.result !== null && r.actual.result !== undefined,
            error: r.actual.error || null,
          },
        };
      }),
    });
  } catch (error) {
    console.error('[Skills Eval API] POST error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
