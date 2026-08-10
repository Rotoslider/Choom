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
      // GUI settings persist server-side in bridge-config.json. Requests
      // that carry no client settings (delegation, cron, heartbeat) must
      // still honor what the user set in the GUI — bridge-config is the
      // authority for them; VISION_ENDPOINT env is a bootstrap default,
      // not an override. (2026-08-09: delegated vision silently ran on a
      // stale env endpoint whose server answered with a different model.)
      let bridgeCfg: Record<string, unknown> = {};
      try {
        const bridgePath = path.join(process.cwd(), 'services', 'signal-bridge', 'bridge-config.json');
        if (fs.existsSync(bridgePath)) {
          bridgeCfg = JSON.parse(fs.readFileSync(bridgePath, 'utf-8'));
        }
      } catch { /* ignore */ }
      const visionCfg = (ctx.settings?.vision as Record<string, unknown>)
        || (bridgeCfg.vision as Record<string, unknown>) || {};
      const visionProviderId = visionCfg.visionProviderId as string | undefined;
      let visionApiKey = visionCfg.apiKey as string | undefined;
      let visionEndpoint = (visionCfg.endpoint as string) || process.env.VISION_ENDPOINT || 'http://localhost:1234';

      const visionProviders: LLMProviderConfig[] =
        (ctx.settings?.providers as LLMProviderConfig[])
        || (bridgeCfg.providers as LLMProviderConfig[]) || [];
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
      const rawVisionModel = visionCfg.model as string;
      const fallbackModel = ((ctx.settings?.llm as Record<string, unknown>)?.model as string)
        || ((bridgeCfg.llm as Record<string, unknown>)?.model as string)
        || 'qwen2.5-7b-instruct';
      const visionModel = (rawVisionModel && rawVisionModel !== 'vision-model')
        ? rawVisionModel
        : fallbackModel;

      const visionSettings: VisionSettings = {
        endpoint: visionEndpoint,
        model: visionModel,
        maxTokens: visionCfg.maxTokens as number || 1024,
        temperature: visionCfg.temperature as number || 0.3,
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
      const raw = err instanceof Error ? err.message : 'Unknown error';

      // Never dead-end on a wrong filename. analyze_image was 90 of the 309
      // "not found, no list, no way to find one" errors in the trace corpus:
      // the Choom names an image that does not exist, gets a bare ENOENT,
      // retries the same fantasy path and burns the per-tool cap. In one real
      // case the file was "chant_shadow_afternoon.png" and she asked for
      // "chants_..." — one character off, unrecoverable without a listing.
      // workspace_read_file already solves this; do the same here.
      // Shared with route.ts's own copy of analyze_image — see
      // formatImageNotFoundError. Two implementations of this tool exist and
      // only this one used to list the directory (C-50).
      if (/ENOENT|no such file/i.test(raw)) {
        const wanted = (toolCall.arguments?.image_path as string) || '';
        const { formatImageNotFoundError } = await import('../../../lib/dir-suggest');
        const friendly = await formatImageNotFoundError(wanted);
        if (friendly) {
          console.log(`   🖼️  ${wanted} not found — auto-listed nearest directory`);
          return this.error(toolCall, friendly);
        }
      }

      // "fetch failed" = the vision endpoint is unreachable, not a bad request.
      // Say so, so she stops rewording the prompt and reports the real problem.
      if (/fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(raw)) {
        return this.error(toolCall,
          `Vision service unreachable (${raw}). This is an availability problem, not a bad request — retrying with a different prompt or path will not help. Tell Donny the vision endpoint is down.`);
      }

      // LM Studio reachable but no model loaded: the upstream 400 body says
      // "use the 'lms load' command", which reads like an instruction the
      // Choom should follow — she can't, and the raw JSON blob taught nothing
      // except to retry (Genesis 08-02, 3 rewordings against the same wall).
      // Translate to what it IS: a machine-config problem only Donny can fix.
      if (/No models loaded/i.test(raw)) {
        return this.error(toolCall,
          `Vision model is not loaded on the server (LM Studio has no vision model active). ` +
          `This is a machine configuration problem — no tool call or reworded prompt can fix it. ` +
          `Tell Donny the vision model needs loading, and work from context (image filenames, what was said about them) in the meantime.`);
      }

      console.error('   ❌ Vision error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Vision analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
