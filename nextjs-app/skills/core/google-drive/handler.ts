import path from 'path';
import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { ToolCall, ToolResult } from '@/lib/types';
import { getGoogleClient } from '@/lib/google-client';
import { WORKSPACE_ROOT } from '@/lib/config';

const DRIVE_TOOLS = new Set([
  'list_drive_files',
  'search_drive',
  'create_drive_folder',
  'upload_to_drive',
  'download_from_drive',
]);

export default class GoogleDriveHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return DRIVE_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, _ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const googleClient = getGoogleClient();

      switch (toolCall.name) {
        case 'list_drive_files': {
          const folderId = toolCall.arguments.folder_id as string | undefined;
          const maxResults = (toolCall.arguments.max_results as number) || 20;
          const files = await googleClient.listDriveFiles(folderId, maxResults);

          const formatted = files.length === 0
            ? 'No files found.'
            : files.map((f) => `- ${f.name} (${f.mimeType}) ${f.url}`).join('\n');

          console.log(`   [drive] Drive files: ${files.length} found`);

          return this.success(toolCall, { success: true, files, formatted, count: files.length });
        }

        case 'search_drive': {
          const query = toolCall.arguments.query as string;
          const maxResults = (toolCall.arguments.max_results as number) || 20;
          const files = await googleClient.searchDrive(query, maxResults);

          const formatted = files.length === 0
            ? 'No files found matching that search.'
            : files.map((f) => `- ${f.name} (${f.mimeType}) ${f.url}`).join('\n');

          console.log(`   [drive] Drive search "${query}": ${files.length} results`);

          return this.success(toolCall, { success: true, files, formatted, count: files.length, query });
        }

        case 'create_drive_folder': {
          const name = toolCall.arguments.name as string;
          const parentId = toolCall.arguments.parent_id as string | undefined;
          const folder = await googleClient.createDriveFolder(name, parentId);

          console.log(`   [drive] Created Drive folder: "${name}" (${folder.id})`);

          return this.success(toolCall, {
            success: true,
            folder,
            message: `Created folder "${name}" in Google Drive.`,
          });
        }

        case 'upload_to_drive': {
          const workspacePath = toolCall.arguments.workspace_path as string;
          const folderId = toolCall.arguments.folder_id as string | undefined;
          const driveFilename = toolCall.arguments.drive_filename as string | undefined;

          // Resolve workspace path to absolute path
          const absolutePath = path.join(WORKSPACE_ROOT, workspacePath);

          // Security: ensure path stays within workspace
          const resolved = path.resolve(absolutePath);
          if (!resolved.startsWith(WORKSPACE_ROOT)) {
            throw new Error('Path traversal not allowed');
          }

          const result = await googleClient.uploadToDrive(resolved, folderId, driveFilename);

          console.log(`   [drive] Uploaded to Drive: "${workspacePath}" -> ${result.name} (${result.id})`);

          return this.success(toolCall, {
            success: true,
            file: result,
            message: `Uploaded "${workspacePath}" to Google Drive. URL: ${result.url}`,
          });
        }

        case 'download_from_drive': {
          const fileId = toolCall.arguments.file_id as string;
          const workspacePath = toolCall.arguments.workspace_path as string;

          // Resolve workspace path to absolute path
          const absolutePath = path.join(WORKSPACE_ROOT, workspacePath);

          // Security: ensure path stays within workspace
          const resolved = path.resolve(absolutePath);
          if (!resolved.startsWith(WORKSPACE_ROOT)) {
            throw new Error('Path traversal not allowed');
          }

          await googleClient.downloadFromDrive(fileId, resolved);

          console.log(`   [drive] Downloaded from Drive: ${fileId} -> "${workspacePath}"`);

          return this.success(toolCall, {
            success: true,
            path: workspacePath,
            message: `Downloaded to workspace at "${workspacePath}".`,
          });
        }

        default:
          return this.error(toolCall, `Unknown tool: ${toolCall.name}`);
      }
    } catch (err) {
      return this.error(
        toolCall,
        `Failed ${toolCall.name}: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  }
}
