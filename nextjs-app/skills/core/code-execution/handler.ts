import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { WORKSPACE_ROOT } from '@/lib/config';

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
      const projectFolder = toolCall.arguments.project_folder as string;
      const language = toolCall.arguments.language as 'python' | 'node';
      const code = toolCall.arguments.code as string;
      const timeoutSeconds = toolCall.arguments.timeout_seconds as number | undefined;
      const timeoutMs = timeoutSeconds ? Math.min(timeoutSeconds * 1000, 120_000) : undefined;

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
      const projectFolder = toolCall.arguments.project_folder as string;
      const command = toolCall.arguments.command as string;
      const timeoutSeconds = toolCall.arguments.timeout_seconds as number | undefined;
      const timeoutMs = timeoutSeconds ? Math.min(timeoutSeconds * 1000, 120_000) : undefined;

      const result = await sandbox.runCommand(projectFolder, command, timeoutMs);
      return this.success(toolCall, result);
    } catch (err) {
      console.error('   Command execution failed:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Command execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
