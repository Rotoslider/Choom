import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { WORKSPACE_ROOT } from '@/lib/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Try to infer project_folder from code content by checking which workspace
 * project contains files referenced in the code (e.g., "train.py", "run.log").
 */
function inferProjectFolder(code: string): string | null {
  // Extract filenames referenced in the code (open("file.py"), "file.log", etc.)
  const fileRefs = new Set<string>();
  const patterns = [
    /open\(["']([^"'/]+\.\w+)["']/g,          // open("train.py")
    /["']([^"'/]+\.(?:py|log|tsv|csv|json|txt|yaml|toml))["']/g,  // "train.py", "run.log"
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      fileRefs.add(match[1]);
    }
  }
  if (fileRefs.size === 0) return null;

  // Scan workspace directories for matches
  try {
    const entries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(WORKSPACE_ROOT, entry.name);
      for (const ref of fileRefs) {
        if (fs.existsSync(path.join(projectDir, ref))) {
          console.log(`   🔍 Inferred project_folder="${entry.name}" from file reference "${ref}" in code`);
          return entry.name;
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

const CODE_TOOLS = new Set([
  'execute_code',
  'create_venv',
  'install_package',
  'run_command',
]);

export default class CodeExecutionHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return CODE_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'execute_code':
        return this.executeCode(toolCall);
      case 'create_venv':
        return this.createVenv(toolCall);
      case 'install_package':
        return this.installPackage(toolCall);
      case 'run_command':
        return this.runCommand(toolCall);
      default:
        return this.error(toolCall, `Unknown code execution tool: ${toolCall.name}`);
    }
  }

  private async executeCode(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const { CodeSandbox } = await import('@/lib/code-sandbox');
      const sandbox = new CodeSandbox(WORKSPACE_ROOT);
      const code = (toolCall.arguments.code || toolCall.arguments.command) as string;
      const projectFolder = (toolCall.arguments.project_folder || toolCall.arguments.projectFolder || toolCall.arguments.folder || (code && inferProjectFolder(code))) as string;
      const language = (toolCall.arguments.language || 'python') as 'python' | 'node';
      const timeoutSeconds = toolCall.arguments.timeout_seconds as number | undefined;
      const timeoutMs = timeoutSeconds ? Math.min(timeoutSeconds * 1000, 600_000) : undefined;

      const result = language === 'python'
        ? await sandbox.executePython(projectFolder, code, timeoutMs)
        : await sandbox.executeNode(projectFolder, code, timeoutMs);
      return this.success(toolCall, result);
    } catch (err) {
      console.error('   Code execution failed:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Code execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async createVenv(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const { CodeSandbox } = await import('@/lib/code-sandbox');
      const sandbox = new CodeSandbox(WORKSPACE_ROOT);
      const projectFolder = toolCall.arguments.project_folder as string;
      const runtime = toolCall.arguments.runtime as 'python' | 'node';

      const result = runtime === 'python'
        ? await sandbox.createPythonVenv(projectFolder)
        : await sandbox.initNodeProject(projectFolder);
      return this.success(toolCall, result);
    } catch (err) {
      console.error('   Environment creation failed:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Environment creation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async installPackage(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const { CodeSandbox } = await import('@/lib/code-sandbox');
      const sandbox = new CodeSandbox(WORKSPACE_ROOT);
      const projectFolder = toolCall.arguments.project_folder as string;
      const runtime = toolCall.arguments.runtime as 'python' | 'node';
      const packages = toolCall.arguments.packages as string[];

      const result = runtime === 'python'
        ? await sandbox.pipInstall(projectFolder, packages)
        : await sandbox.npmInstall(projectFolder, packages);
      return this.success(toolCall, result);
    } catch (err) {
      console.error('   Package install failed:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Package install failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async runCommand(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const { CodeSandbox } = await import('@/lib/code-sandbox');
      const sandbox = new CodeSandbox(WORKSPACE_ROOT);
      let projectFolder = toolCall.arguments.project_folder as string;
      let command = toolCall.arguments.command as string;

      // LLMs often put "cd <folder> && ..." in the command instead of using project_folder.
      // Extract the folder and strip the cd prefix so the sandbox runs in the right directory.
      if (!projectFolder && command) {
        const cdMatch = command.match(/^cd\s+([^\s;&]+)\s*&&\s*(.*)/s);
        if (cdMatch) {
          projectFolder = cdMatch[1];
          command = cdMatch[2];
          console.log(`   🔄 Extracted project_folder="${projectFolder}" from cd prefix in command`);
        }
      }
      // Last resort: infer from file references in the command
      if (!projectFolder && command) {
        projectFolder = inferProjectFolder(command) || projectFolder;
      }
      const timeoutSeconds = toolCall.arguments.timeout_seconds as number | undefined;
      const timeoutMs = timeoutSeconds ? Math.min(timeoutSeconds * 1000, 600_000) : undefined;

      const result = await sandbox.runCommand(projectFolder, command, timeoutMs);
      return this.success(toolCall, result);
    } catch (err) {
      console.error('   Command execution failed:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Command execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
