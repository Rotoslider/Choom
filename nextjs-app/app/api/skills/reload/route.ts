import { NextResponse } from 'next/server';
import { getSkillRegistry, resetSkillRegistry } from '@/lib/skill-registry';
import { loadCoreSkills, loadCustomSkills, resetCoreSkillsLoaded, resetCustomSkillsLoaded } from '@/lib/skill-loader';

/**
 * POST /api/skills/reload — Hot-reload the skill registry
 * Resets and re-registers all core skills, then reloads custom/external.
 */
export async function POST() {
  try {
    // Reset the registry singleton and loader flags
    resetSkillRegistry();
    resetCoreSkillsLoaded();
    resetCustomSkillsLoaded();

    // Re-register core skills, then custom skills from .choom-skills
    loadCoreSkills();
    loadCustomSkills();

    // Also load any external skills via registry.loadAll()
    const registry = getSkillRegistry();
    await registry.loadAll();

    const skillNames = registry.getSkillNames();
    const toolCount = registry.getToolCount();

    return NextResponse.json({
      success: true,
      message: 'Skill registry reloaded',
      skillCount: skillNames.length,
      toolCount,
      skills: skillNames,
    });
  } catch (error) {
    console.error('[Skills API] POST reload error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
