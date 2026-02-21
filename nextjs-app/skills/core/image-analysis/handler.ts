import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult, VisionSettings } from '@/lib/types';
import { VisionService } from '@/lib/vision-service';
import prisma from '@/lib/db';
import { WORKSPACE_ROOT } from '@/lib/config';

const TOOL_NAMES = new Set([
  'analyze_image',
]);

export default class ImageAnalysisHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'analyze_image':
        return this.analyzeImage(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown image-analysis tool: ${toolCall.name}`);
    }
  }

  private async analyzeImage(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const visionSettings: VisionSettings = {
        endpoint: (ctx.settings?.vision as Record<string, unknown>)?.endpoint as string || process.env.VISION_ENDPOINT || 'http://localhost:1234',
        model: (ctx.settings?.vision as Record<string, unknown>)?.model as string || 'vision-model',
        maxTokens: (ctx.settings?.vision as Record<string, unknown>)?.maxTokens as number || 1024,
        temperature: (ctx.settings?.vision as Record<string, unknown>)?.temperature as number || 0.3,
      };

      // If image_id is provided, look up the generated image from the database
      let imageBase64 = toolCall.arguments.image_base64 as string | undefined;
      if (toolCall.arguments.image_id && !imageBase64) {
        try {
          const genImage = await prisma.generatedImage.findUnique({
            where: { id: toolCall.arguments.image_id as string },
          });
          if (genImage?.imageUrl) {
            // Extract base64 from data URL if present
            const dataUrl = genImage.imageUrl;
            if (dataUrl.startsWith('data:')) {
              imageBase64 = dataUrl.split(',')[1];
            } else {
              imageBase64 = dataUrl;
            }
            console.log(`   👁️  Loaded generated image ${toolCall.arguments.image_id} from DB for analysis`);
          } else {
            throw new Error(`Generated image ${toolCall.arguments.image_id} not found in database`);
          }
        } catch (dbErr) {
          throw new Error(`Failed to load generated image: ${dbErr instanceof Error ? dbErr.message : 'Unknown error'}`);
        }
      }

      const visionService = new VisionService(visionSettings);
      const result = await visionService.analyzeImage({
        prompt: toolCall.arguments.prompt as string,
        imagePath: toolCall.arguments.image_path as string | undefined,
        imageUrl: toolCall.arguments.image_url as string | undefined,
        imageBase64: imageBase64,
        mimeType: toolCall.arguments.mime_type as string | undefined,
      }, WORKSPACE_ROOT);

      console.log(`   👁️  Vision analysis complete (${result.model}): ${result.analysis.slice(0, 100)}...`);

      return this.success(toolCall, {
        success: true,
        analysis: result.analysis,
        model: result.model,
      });
    } catch (err) {
      console.error('   ❌ Vision error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Vision analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
