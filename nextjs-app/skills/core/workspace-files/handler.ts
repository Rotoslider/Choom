import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { WorkspaceService } from '@/lib/workspace-service';
import { ProjectService } from '@/lib/project-service';
import { WORKSPACE_ROOT } from '@/lib/config';
const WORKSPACE_MAX_FILE_SIZE_KB = 1024;
const WORKSPACE_ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.py', '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.csv'];

const TOOL_NAMES = new Set([
  'workspace_write_file',
  'workspace_read_file',
  'workspace_list_files',
  'workspace_create_folder',
  'workspace_create_project',
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
      case 'workspace_create_project':
        return this.createProject(toolCall, ctx);
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

      // Accept common aliases for path
      const filePath = (toolCall.arguments.path || toolCall.arguments.file_path || toolCall.arguments.filename) as string;
      // Stringify objects/arrays if model passes non-string content
      const rawContent = toolCall.arguments.content;
      const content = typeof rawContent === 'string' ? rawContent
        : rawContent != null ? JSON.stringify(rawContent, null, 2) : '';

      if (!filePath) {
        return this.error(toolCall, 'path is required. Provide a relative file path (e.g., "my_project/file.md")');
      }

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

      // Accept common aliases: path, folder, name, project_name, folder_name
      const folderPath = (toolCall.arguments.path || toolCall.arguments.folder || toolCall.arguments.name || toolCall.arguments.project_name || toolCall.arguments.folder_name) as string;
      if (!folderPath) {
        return this.error(toolCall, 'path is required. Provide a relative folder path (e.g., "my_project")');
      }

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

  private async createProject(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const { sessionFileCount } = ctx;
      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        return this.error(toolCall, `Session file creation limit reached.`);
      }

      const name = (toolCall.arguments.name || toolCall.arguments.project_name) as string;
      const description = (toolCall.arguments.description || '') as string;
      const assignedChoom = (toolCall.arguments.assigned_choom || (ctx.choom as Record<string, unknown>).name || '') as string;

      if (!name) {
        return this.error(toolCall, 'name is required. Provide a snake_case project name (e.g., "my_project")');
      }

      const projectService = new ProjectService(WORKSPACE_ROOT);
      const project = await projectService.createProject(name, {
        description,
        assignedChoom: assignedChoom,
        status: 'active',
      });

      sessionFileCount.created++;

      ctx.send({ type: 'file_created', path: `${project.folder}/.choom-project.json` });

      console.log(`   📂 Project created: ${project.folder} (assigned to ${assignedChoom || 'unassigned'})`);
      return this.success(toolCall, {
        success: true,
        project_folder: project.folder,
        metadata: project.metadata,
        message: `Project "${name}" created at ${project.folder}/. All project files should use paths starting with "${project.folder}/".`,
      });
    } catch (err) {
      console.error('   ❌ Project create error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to create project: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
