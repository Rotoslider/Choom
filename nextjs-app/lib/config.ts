/**
 * Centralized path configuration.
 * All workspace/skill paths should be imported from here.
 */
import path from 'path';
import os from 'os';

export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(os.homedir(), 'choom-projects');
export const CUSTOM_SKILLS_ROOT = path.join(WORKSPACE_ROOT, '.choom-skills');
export const EXTERNAL_SKILLS_ROOT = path.join(WORKSPACE_ROOT, '.choom-external-skills');
