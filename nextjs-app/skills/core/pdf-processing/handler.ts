import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { PDFService } from '@/lib/pdf-service';
import { WorkspaceService } from '@/lib/workspace-service';
import { WORKSPACE_ROOT } from '@/lib/config';
const WORKSPACE_MAX_FILE_SIZE_KB = 1024;
const WORKSPACE_ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.py', '.ts', '.js', '.html', '.css', '.csv'];
const WORKSPACE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
const WORKSPACE_DOWNLOAD_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx', '.zip', '.tar', '.gz', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sh', '.bash', '.sql', '.r', '.R', '.ipynb'];

const TOOL_NAMES = new Set([
  'workspace_generate_pdf',
  'workspace_read_pdf',
]);

export default class PDFProcessingHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'workspace_generate_pdf':
        return this.generatePDF(toolCall, ctx);
      case 'workspace_read_pdf':
        return this.readPDF(toolCall);
      default:
        return this.error(toolCall, `Unknown PDF tool: ${toolCall.name}`);
    }
  }

  private async generatePDF(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const outputPath = toolCall.arguments.output_path as string;
      const sourcePath = toolCall.arguments.source_path as string | undefined;
      const contentArg = toolCall.arguments.content as string | undefined;
      const title = toolCall.arguments.title as string | undefined;
      const imagesArg = toolCall.arguments.images as Array<{ path: string; width?: number; caption?: string }> | undefined;

      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, WORKSPACE_ALLOWED_EXTENSIONS);

      // Get markdown content from source_path or content argument
      let markdown: string;
      if (sourcePath) {
        markdown = await ws.readFile(sourcePath);
      } else if (contentArg) {
        markdown = contentArg;
      } else {
        return this.error(toolCall, 'Either source_path or content must be provided');
      }

      // Resolve image paths via workspace service
      const resolvedImages = imagesArg?.map(img => ({
        path: ws.resolveSafe(img.path),
        width: img.width,
        caption: img.caption,
      }));

      // Resolve output path
      const fullOutputPath = ws.resolveSafe(outputPath);

      await PDFService.markdownToPDF(markdown, fullOutputPath, title, {
        images: resolvedImages,
        workspaceRoot: WORKSPACE_ROOT,
      });

      ctx.send({ type: 'file_created', path: outputPath });

      console.log(`   📄 PDF generated: ${outputPath}`);
      return this.success(toolCall, {
        success: true,
        message: `Generated PDF: ${outputPath}`,
        path: outputPath,
      });
    } catch (err) {
      console.error('   ❌ PDF generation error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to generate PDF: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async readPDF(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const pdfPath = toolCall.arguments.path as string;
      const pageStart = toolCall.arguments.page_start as number | undefined;
      const pageEnd = toolCall.arguments.page_end as number | undefined;

      // Use all extensions including download extensions so PDFs can be read
      const allExtensions = [
        ...WORKSPACE_ALLOWED_EXTENSIONS,
        ...WORKSPACE_IMAGE_EXTENSIONS,
        ...WORKSPACE_DOWNLOAD_EXTENSIONS,
      ];

      const ws = new WorkspaceService(WORKSPACE_ROOT, WORKSPACE_MAX_FILE_SIZE_KB, allExtensions);
      const text = await ws.readPdfText(pdfPath, {
        start: pageStart,
        end: pageEnd,
      });

      console.log(`   📄 PDF read: ${pdfPath} (${text.length} chars)`);
      return this.success(toolCall, { success: true, text });
    } catch (err) {
      console.error('   ❌ PDF read error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to read PDF: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
