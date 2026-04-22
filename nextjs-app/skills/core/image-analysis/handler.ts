import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult, VisionSettings, LLMProviderConfig, VisionModelProfile } from '@/lib/types';
import { VisionService } from '@/lib/vision-service';
import { findVisionProfile } from '@/lib/model-profiles';
import prisma from '@/lib/db';
import { WORKSPACE_ROOT } from '@/lib/config';
import * as fs from 'fs';
import * as path from 'path';

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
      // Resolve vision provider: prefer client-sent settings, fall back to bridge-config.json
      const visionProviderId = (ctx.settings?.vision as Record<string, unknown>)?.visionProviderId as string | undefined;
      let visionApiKey = (ctx.settings?.vision as Record<string, unknown>)?.apiKey as string | undefined;
      let visionEndpoint = (ctx.settings?.vision as Record<string, unknown>)?.endpoint as string || process.env.VISION_ENDPOINT || 'http://localhost:1234';

      let visionProviders: LLMProviderConfig[] = (ctx.settings?.providers as LLMProviderConfig[]) || [];
      if (visionProviders.length === 0) {
        try {
          const bridgePath = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');
          if (fs.existsSync(bridgePath)) {
            const bridgeCfg = JSON.parse(fs.readFileSync(bridgePath, 'utf-8'));
            visionProviders = (bridgeCfg.providers || []) as LLMProviderConfig[];
          }
        } catch { /* ignore */ }
      }
      if (visionProviderId && visionProviders.length > 0) {
        const visionProvider = visionProviders.find(
          (p: LLMProviderConfig) => p.id === visionProviderId
        );
        if (visionProvider) {
          if (visionProvider.apiKey) {
            visionApiKey = visionProvider.apiKey;
          }
          if (visionProvider.endpoint) {
            visionEndpoint = visionProvider.endpoint.replace(/\/v1\/?$/, '');
          }
        } else {
          console.warn(`   ⚠️  Vision provider "${visionProviderId}" not found in ${visionProviders.length} providers (available: ${visionProviders.map((p: LLMProviderConfig) => p.id).join(', ')}). Falling back to endpoint: ${visionEndpoint}`);
        }
      }

      // Vision model: fall back to LLM model (multimodal models support vision natively)
      const rawVisionModel = (ctx.settings?.vision as Record<string, unknown>)?.model as string;
      const fallbackModel = ((ctx.settings?.llm as Record<string, unknown>)?.model as string) || 'qwen2.5-7b-instruct';
      const visionModel = (rawVisionModel && rawVisionModel !== 'vision-model')
        ? rawVisionModel
        : fallbackModel;

      const visionSettings: VisionSettings = {
        endpoint: visionEndpoint,
        model: visionModel,
        maxTokens: (ctx.settings?.vision as Record<string, unknown>)?.maxTokens as number || 1024,
        temperature: (ctx.settings?.vision as Record<string, unknown>)?.temperature as number || 0.3,
        apiKey: visionApiKey,
      };
      console.log(`   👁️  Vision config: model=${visionModel}, endpoint=${visionEndpoint}, provider=${visionProviderId || 'none'}, hasApiKey=${!!visionApiKey}`);

      // Apply vision profile if available
      const userVisionProfiles = (ctx.settings?.visionProfiles as VisionModelProfile[]) || [];
      const visionProfile = findVisionProfile(visionModel, userVisionProfiles);
      let visionMaxDimension: number | undefined;
      let visionMaxSizeBytes: number | undefined;
      if (visionProfile) {
        if (visionProfile.maxTokens !== undefined) visionSettings.maxTokens = visionProfile.maxTokens;
        if (visionProfile.temperature !== undefined) visionSettings.temperature = visionProfile.temperature;
        visionMaxDimension = visionProfile.maxImageDimension;
        visionMaxSizeBytes = visionProfile.maxImageSizeBytes;
        console.log(`   👁️  Vision profile applied: "${visionProfile.label || visionProfile.modelId}" (maxDim=${visionMaxDimension}, maxSize=${visionMaxSizeBytes ? Math.round(visionMaxSizeBytes / 1024 / 1024) + 'MB' : 'default'})`);
      }

      // If image_id is provided, look up the generated image from the database
      let imageBase64 = toolCall.arguments.image_base64 as string | undefined;
      if (toolCall.arguments.image_id && !imageBase64) {
        const imageId = toolCall.arguments.image_id as string;
        try {
          const genImage = await prisma.generatedImage.findUnique({
            where: { id: imageId },
          });
          if (genImage?.imageUrl) {
            const dataUrl = genImage.imageUrl;
            if (dataUrl.startsWith('data:')) {
              imageBase64 = dataUrl.split(',')[1];
            } else {
              imageBase64 = dataUrl;
            }
            console.log(`   👁️  Loaded generated image ${imageId} from DB for analysis`);
          } else {
            // Stale-image-id guard: list current valid IDs for this Choom.
            const recent = await prisma.generatedImage.findMany({
              where: { choomId: ctx.choomId },
              orderBy: { createdAt: 'desc' },
              take: 5,
              select: { id: true, prompt: true },
            });
            const list = recent.length === 0
              ? '(no images have been generated for this Choom yet)'
              : recent.map(r => `  - ${r.id} :: "${(r.prompt || '').slice(0, 60)}"`).join('\n');
            return this.error(
              toolCall,
              `Image id "${imageId}" was not found — it may be from a previous request or was never created. Current valid image ids for this Choom (most recent first):\n${list}\n\nRetry analyze_image with one of these ids, or use image_path / image_url instead.`
            );
          }
        } catch (dbErr) {
          throw new Error(`Failed to load generated image: ${dbErr instanceof Error ? dbErr.message : 'Unknown error'}`);
        }
      }

      const visionService = new VisionService({
        ...visionSettings,
        maxImageDimension: visionMaxDimension,
        maxImageSizeBytes: visionMaxSizeBytes,
      });
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
