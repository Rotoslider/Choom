import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { WorkspaceService } from '@/lib/workspace-service';
import { ProjectService } from '@/lib/project-service';
import { WORKSPACE_ROOT } from '@/lib/config';
const WORKSPACE_MAX_FILE_SIZE_KB = 1024;
const WORKSPACE_ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.py', '.ts', '.js', '.html', '.css', '.csv'];

const TOOL_NAMES = new Set([
  'workspace_write_file',
  'workspace_read_file',
  'workspace_list_files',
  'workspace_create_folder',
  'workspace_delete_file',
  'workspace_rename_project',
]);

export default class WorkspaceFilesHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'workspace_write_file':
        return this.writeFile(toolCall, ctx);
      case 'workspace_read_file':
        return this.readFile(toolCall);
      case 'workspace_list_files':
        return this.listFiles(toolCall);
      case 'workspace_create_folder':
        return this.createFolder(toolCall, ctx);
      case 'workspace_delete_file':
        return this.deleteFile(toolCall);
      case 'workspace_rename_project':
        return this.renameProject(toolCall);
      default:
        return this.error(toolCall, `Unknown workspace tool: ${toolCall.name}`);
    }
  }

  private async writeFile(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const { sessionFileCount } = ctx;
      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        return this.error(toolCall, `Session file creation limit reached (${sessionFileCount.maxAllowed}). Cannot create more files in this session.`);
      }

      const filePath = toolCall.arguments.path as string;
      const content = toolCall.arguments.content as string;

      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const result = await ws.writeFile(filePath, content);

      sessionFileCount.created++;

      ctx.send({ type: 'file_created', path: filePath });

      console.log(`   📝 Workspace write: ${filePath}`);
      return this.success(toolCall, { success: true, message: result });
    } catch (err) {
      console.error('   ❌ Workspace write error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to write file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async readFile(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const filePath = toolCall.arguments.path as string;

      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const content = await ws.readFile(filePath);

      console.log(`   📖 Workspace read: ${filePath}`);
      return this.success(toolCall, { success: true, content });
    } catch (err) {
      console.error('   ❌ Workspace read error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to read file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async listFiles(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const dirPath = (toolCall.arguments.path as string) || '';

      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const entries = await ws.listFiles(dirPath);

      const formatted = entries.length === 0
        ? '(empty directory)'
        : entries.map(e => {
            if (e.type === 'directory') {
              return `\uD83D\uDCC1 ${e.name}/`;
            }
            const sizeStr = e.size < 1024
              ? `${e.size}B`
              : `${(e.size / 1024).toFixed(1)}KB`;
            return `\uD83D\uDCC4 ${e.name} (${sizeStr})`;
          }).join('\n');

      console.log(`   📂 Workspace list: ${dirPath || '/'} (${entries.length} entries)`);
      return this.success(toolCall, { success: true, entries, formatted });
    } catch (err) {
      console.error('   ❌ Workspace list error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to list files: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async createFolder(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const { sessionFileCount } = ctx;
      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        return this.error(toolCall, `Session file creation limit reached (${sessionFileCount.maxAllowed}). Cannot create more folders in this session.`);
      }

      const folderPath = toolCall.arguments.path as string;

      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const result = await ws.createFolder(folderPath);

      sessionFileCount.created++;

      ctx.send({ type: 'file_created', path: folderPath });

      console.log(`   📁 Workspace create folder: ${folderPath}`);
      return this.success(toolCall, { success: true, message: result });
    } catch (err) {
      console.error('   ❌ Workspace create folder error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to create folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async deleteFile(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const filePath = toolCall.arguments.path as string;

      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      await ws.deleteFile(filePath);

      console.log(`   🗑️ Workspace delete: ${filePath}`);
      return this.success(toolCall, { success: true, message: `Deleted: ${filePath}` });
    } catch (err) {
      console.error('   ❌ Workspace delete error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to delete file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async renameProject(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const oldName = toolCall.arguments.old_name as string;
      const newName = toolCall.arguments.new_name as string;

      const projectService = new ProjectService(WORKSPACE_ROOT);
      const result = await projectService.renameProject(oldName, newName);

      console.log(`   🔄 Workspace rename: "${oldName}" → "${result.folder}"`);
      return this.success(toolCall, {
        success: true,
        message: `Renamed project "${oldName}" to "${result.folder}"`,
        project: result,
      });
    } catch (err) {
      console.error('   ❌ Workspace rename error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to rename project: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
