import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { WorkspaceService } from '@/lib/workspace-service';
import { ProjectService } from '@/lib/project-service';
import { WORKSPACE_ROOT } from '@/lib/config';
const WORKSPACE_MAX_FILE_SIZE_KB = 1024;
const WORKSPACE_ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.jsonl', '.py', '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.csv', '.tsv', '.sh', '.bash', '.yaml', '.yml', '.xml', '.sql', '.toml', '.ini', '.cfg', '.r', '.R', '.ipynb', '.log'];

const TOOL_NAMES = new Set([
  'workspace_write_file',
  'workspace_read_file',
  'workspace_list_files',
  'workspace_create_folder',
  'workspace_create_project',
  'workspace_delete_file',
  'workspace_rename_project',
]);

// Top-level shared workspaces. These live at the workspace root and must NOT
// be prefixed by a Choom's selfies_ folder. Chooms repeatedly make the mistake
// of writing `selfies_genesis/sibling_journal/...` — strip the prefix.
const SHARED_TOP_LEVEL_DIRS = new Set([
  'sibling_journal',
  'choom_commons',
]);

function stripMisplacedSharedPrefix(filePath: string): string {
  if (!filePath) return filePath;
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length < 2) return filePath;
  // Pattern: selfies_X/<shared_dir>/...  →  <shared_dir>/...
  if (parts[0].startsWith('selfies_') && SHARED_TOP_LEVEL_DIRS.has(parts[1])) {
    const corrected = parts.slice(1).join('/');
    console.warn(`   🔀 Path corrected: "${filePath}" → "${corrected}" (${parts[1]} is top-level, not inside selfies_*)`);
    return corrected;
  }
  return filePath;
}

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

  /**
   * Sanitize a file path from LLM output.
   * Weak models sometimes hallucinate characters like %, {, }, etc.
   * Instead of erroring, clean the path so the operation succeeds.
   */
  private sanitizePath(filePath: string): string {
    // Strip characters that are never valid in file paths
    let cleaned = filePath.replace(/[{}%<>|*?"\\;=+~`!@#$^&:]/g, '');
    // Collapse multiple spaces into underscore, trim each path segment
    cleaned = cleaned.replace(/\s{2,}/g, '_');
    cleaned = cleaned.split('/').map(s => s.trim()).filter(Boolean).join('/');
    // Collapse multiple slashes
    cleaned = cleaned.replace(/\/{2,}/g, '/');
    if (cleaned !== filePath) {
      console.warn(`   ⚠️ Path auto-sanitized: "${filePath}" → "${cleaned}"`);
    }
    return cleaned;
  }

  private async writeFile(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const { sessionFileCount } = ctx;
      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        return this.error(toolCall, `Session file creation limit reached (${sessionFileCount.maxAllowed}). Cannot create more files in this session.`);
      }

      // Accept common aliases for path
      let filePath = (toolCall.arguments.path || toolCall.arguments.file_path || toolCall.arguments.filename) as string;
      // Stringify objects/arrays if model passes non-string content
      const rawContent = toolCall.arguments.content;
      const content = typeof rawContent === 'string' ? rawContent
        : rawContent != null ? JSON.stringify(rawContent, null, 2) : '';

      // Missing-path safety net: some weaker models (observed on Lissa) systematically
      // send `content` without `path`. Instead of returning a hard error that burns
      // an iteration, try to derive a filename from the content and save it under
      // an inbox folder scoped to the current Choom. The model is told exactly
      // where the file went so it can reference it later.
      let inferredPath = false;
      if (!filePath && content) {
        const choomName = ((ctx.choom as Record<string, unknown>)?.name as string) || 'unassigned';
        const choomSlug = choomName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unassigned';
        // Try to extract a filename from the first markdown heading or first non-empty line
        const titleMatch = content.match(/^\s*#+\s*(.+?)$/m);
        const firstLine = content.split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
        const rawTitle = (titleMatch?.[1] || firstLine || 'untitled').slice(0, 60);
        const slug = rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'note';
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        // Detect file extension hint from content (fenced block lang or raw code patterns)
        const fenceMatch = content.match(/^```(\w+)/m);
        const fenceLang = fenceMatch?.[1]?.toLowerCase() || '';
        const langToExt: Record<string, string> = {
          python: '.py', py: '.py', javascript: '.js', js: '.js', typescript: '.ts', ts: '.ts',
          bash: '.sh', sh: '.sh', shell: '.sh', json: '.json', yaml: '.yaml', yml: '.yaml',
          html: '.html', css: '.css', sql: '.sql', markdown: '.md', md: '.md',
        };
        const ext = langToExt[fenceLang] || '.md';
        filePath = `${choomSlug}_inbox/${today}_${slug}${ext}`;
        inferredPath = true;
        console.warn(`   ⚠️  workspace_write_file called without path — inferred "${filePath}" from content for ${choomName}`);
      }

      if (!filePath) {
        return this.error(toolCall, 'path is required. Provide a relative file path like "my_project/file.md". You must include BOTH "path" and "content" parameters — do not send only content.');
      }

      // Auto-sanitize garbled paths from weak models (e.g., "home %_assistant/good_m}orning.yaml")
      const sanitizedPath = stripMisplacedSharedPrefix(this.sanitizePath(filePath));

      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);
      const result = await ws.writeFile(sanitizedPath, content);

      sessionFileCount.created++;

      ctx.send({ type: 'file_created', path: sanitizedPath });

      const pathNote = sanitizedPath !== filePath ? ` (path corrected from "${filePath}" to "${sanitizedPath}")` : '';
      const inferredNote = inferredPath
        ? ` [Note: no path was provided in the tool call — a filename was inferred from the content and the file was saved to "${sanitizedPath}". Next time, include a "path" parameter explicitly.]`
        : '';
      console.log(`   📝 Workspace write: ${sanitizedPath}${pathNote}${inferredPath ? ' (inferred)' : ''}`);
      return this.success(toolCall, { success: true, message: result + pathNote + inferredNote, path: sanitizedPath });
    } catch (err) {
      console.error('   ❌ Workspace write error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to write file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async readFile(toolCall: ToolCall): Promise<ToolResult> {
    const filePath = stripMisplacedSharedPrefix(this.sanitizePath((toolCall.arguments.path || toolCall.arguments.file_path || toolCall.arguments.filename) as string || ''));
    const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);

    try {
      let content = await ws.readFile(filePath);

      // Truncate large reads to prevent context bloat that causes LLM timeouts.
      // Data files get a tighter limit since models rarely need full content.
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const dataExts = new Set(['json', 'csv', 'tsv', 'xml', 'log']);
      const maxChars = dataExts.has(ext) ? 12000 : 30000;
      let truncated = false;
      if (content.length > maxChars) {
        const originalLen = content.length;
        content = content.slice(0, maxChars);
        truncated = true;
        content += `\n\n[... truncated — showing first ${maxChars.toLocaleString()} of ${originalLen.toLocaleString()} chars. File is too large to include fully in context.]`;
      }

      console.log(`   📖 Workspace read: ${filePath}${truncated ? ` (truncated to ${maxChars} chars)` : ''}`);
      return this.success(toolCall, { success: true, content });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isNotFound = /ENOENT|no such file or directory/i.test(errMsg);
      const isDirectory = /EISDIR|illegal operation on a directory/i.test(errMsg);

      // Directory-instead-of-file recovery: Eve (and others) sometimes pass
      // a directory path to workspace_read_file. Instead of a confusing EISDIR,
      // auto-list the directory so the model can see its contents and pick
      // the actual file it wanted.
      if (isDirectory && filePath) {
        try {
          const entries = await ws.listFiles(filePath);
          const formatted = entries.slice(0, 40).map(e => {
            if (e.type === 'directory') return `  \uD83D\uDCC1 ${e.name}/`;
            const sizeStr = e.size < 1024 ? `${e.size}B` : `${(e.size / 1024).toFixed(1)}KB`;
            return `  \uD83D\uDCC4 ${e.name} (${sizeStr})`;
          }).join('\n') || '  (empty directory)';
          const more = entries.length > 40 ? `\n  ... and ${entries.length - 40} more entries` : '';
          console.log(`   📁 ${filePath} is a directory — auto-listed instead of reading`);
          return this.error(
            toolCall,
            `"${filePath}" is a directory, not a file. Here's what's inside:\n${formatted}${more}\n\nCall workspace_read_file with one of these specific file paths (e.g., "${filePath}/${entries.find(e => e.type === 'file')?.name || 'filename'}").`
          );
        } catch { /* fall through to generic error */ }
      }

      // Dead-path loop breaker: when a file doesn't exist, auto-list the closest
      // existing ancestor directory and return that listing as part of the error.
      // This prevents models (like Genesis hallucinating files under curiosity_cabinet/)
      // from wasting iterations retrying fantasy paths — they get actual filenames
      // to choose from instead of a bare ENOENT.
      if (isNotFound && filePath) {
        const ancestors: string[] = [];
        const segments = filePath.split('/').filter(Boolean);
        // Walk up: parent, grandparent, ..., workspace root
        for (let i = segments.length - 1; i >= 0; i--) {
          ancestors.push(segments.slice(0, i).join('/'));
        }

        for (const dir of ancestors) {
          try {
            const entries = await ws.listFiles(dir);
            if (entries.length > 0) {
              const formatted = entries.slice(0, 40).map(e => {
                if (e.type === 'directory') return `  \uD83D\uDCC1 ${e.name}/`;
                const sizeStr = e.size < 1024 ? `${e.size}B` : `${(e.size / 1024).toFixed(1)}KB`;
                return `  \uD83D\uDCC4 ${e.name} (${sizeStr})`;
              }).join('\n');
              const more = entries.length > 40 ? `\n  ... and ${entries.length - 40} more entries` : '';
              const dirLabel = dir || '(workspace root)';
              console.log(`   📁 ${filePath} not found — auto-listed ${dirLabel} (${entries.length} entries)`);
              return this.error(
                toolCall,
                `File not found: "${filePath}". The closest existing directory is "${dirLabel}" — here's what's actually in it:\n${formatted}${more}\n\nUse one of these exact paths or call workspace_list_files on a different directory. Do NOT retry the same filename.`
              );
            }
          } catch { /* try next ancestor */ }
        }
      }

      console.error('   ❌ Workspace read error:', errMsg);
      return this.error(toolCall, `Failed to read file: ${errMsg}`);
    }
  }

  private async listFiles(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const dirPath = stripMisplacedSharedPrefix(this.sanitizePath((toolCall.arguments.path as string) || ''));

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
      const rawPath = (toolCall.arguments.path || toolCall.arguments.folder || toolCall.arguments.name || toolCall.arguments.project_name || toolCall.arguments.folder_name) as string;
      if (!rawPath) {
        return this.error(toolCall, 'path is required. Provide a relative folder path (e.g., "my_project")');
      }
      const folderPath = this.sanitizePath(rawPath);

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

      const rawName = (toolCall.arguments.name || toolCall.arguments.project_name) as string;
      const description = (toolCall.arguments.description || '') as string;
      const assignedChoom = (toolCall.arguments.assigned_choom || (ctx.choom as Record<string, unknown>).name || '') as string;

      if (!rawName) {
        return this.error(toolCall, 'name is required. Provide a snake_case project name (e.g., "my_project")');
      }
      const name = this.sanitizePath(rawName);

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
      const filePath = this.sanitizePath((toolCall.arguments.path as string) || '');

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
