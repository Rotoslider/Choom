import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { ImageGenClient, buildPromptWithLoras } from '@/lib/image-gen-client';
import { WorkspaceService } from '@/lib/workspace-service';
import prisma from '@/lib/db';
import { computeImageDimensions } from '@/lib/types';
import type { ImageSize, ImageAspect, ImageGenSettings, ToolCall, ToolResult } from '@/lib/types';
import { WORKSPACE_ROOT } from '@/lib/config';

// ============================================================================
// Module-level image generation lock (serializes checkpoint switching)
// ============================================================================

let imageGenLock: Promise<void> = Promise.resolve();

function withImageGenLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = imageGenLock;
  let resolve: () => void;
  imageGenLock = new Promise<void>(r => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

function detectCheckpointType(checkpointName: string): 'pony' | 'flux' | 'other' {
  const lower = checkpointName.toLowerCase();
  if (lower.includes('pony') || lower.includes('cyberrealistic')) return 'pony';
  if (lower.includes('flux')) return 'flux';
  return 'other';
}

// ============================================================================
// Default settings
// ============================================================================

const DEFAULT_IMAGE_GEN_ENDPOINT = process.env.IMAGE_GEN_ENDPOINT || 'http://localhost:7860';

const defaultImageGenSettings: ImageGenSettings = {
  endpoint: DEFAULT_IMAGE_GEN_ENDPOINT,
  defaultCheckpoint: '',
  defaultSampler: 'Euler a',
  defaultScheduler: 'Normal',
  defaultSteps: 20,
  defaultCfgScale: 7,
  defaultDistilledCfg: 3.5,
  defaultWidth: 1024,
  defaultHeight: 1024,
  defaultNegativePrompt: 'ugly, blurry, low quality, deformed, disfigured',
  selfPortrait: {
    enabled: false,
    checkpoint: '',
    sampler: 'Euler a',
    scheduler: 'Normal',
    steps: 25,
    cfgScale: 7,
    distilledCfg: 3.5,
    width: 1024,
    height: 1024,
    negativePrompt: '',
    loras: [],
    promptPrefix: '',
    promptSuffix: '',
  },
};

const WORKSPACE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const WORKSPACE_ALL_EXTENSIONS = ['.md', '.txt', '.json', '.py', '.ts', '.js', '.html', '.css', '.csv', ...WORKSPACE_IMAGE_EXTENSIONS];
const MAX_IMAGE_FILE_SIZE_KB = 10 * 1024; // 10MB

const TOOL_NAMES = new Set(['generate_image', 'save_generated_image']);

export default class ImageGenerationHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'generate_image':
        return this.handleGenerateImage(toolCall, ctx);
      case 'save_generated_image':
        return this.handleSaveGeneratedImage(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown image generation tool: ${toolCall.name}`);
    }
  }

  private async handleGenerateImage(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const { choomId, message, settings, send } = ctx;
      // choom.imageSettings is stored as a JSON string in the DB — must parse it
      const rawImageSettings = ctx.choom?.imageSettings;
      const choomImageSettings = rawImageSettings
        ? (typeof rawImageSettings === 'string' ? JSON.parse(rawImageSettings) : rawImageSettings) as Record<string, unknown>
        : null;

      const imageGenEndpoint = (settings?.imageGen as Record<string, unknown>)?.endpoint as string || DEFAULT_IMAGE_GEN_ENDPOINT;
      const imageGenSettings: ImageGenSettings = {
        ...defaultImageGenSettings,
        ...(settings?.imageGen as object),
        endpoint: imageGenEndpoint,
      };
      const imageGenClient = new ImageGenClient(imageGenSettings);

      // -------------------------------------------------------------------
      // Determine if this is a self-portrait or general image
      // -------------------------------------------------------------------
      let isSelfPortrait = toolCall.arguments.self_portrait === true;
      if (!isSelfPortrait) {
        const promptLower = ((toolCall.arguments.prompt as string) || '').toLowerCase();
        const messageLower = message.toLowerCase();
        const selfiePatterns = [
          /\bself[- ]?portrait\b/, /\bselfie\b/,
          /\bpicture of (?:you|yourself)\b/, /\bphoto of (?:you|yourself)\b/,
          /\bdraw (?:you|yourself)\b/, /\bshow me (?:you|yourself|what you look like)\b/,
          /\bwhat (?:do )?you look like\b/, /\byour (?:face|appearance|look)\b/,
        ];
        // Only check the user message, not the LLM-generated prompt (which may contain unrelated "image of" phrases)
        const isSelfieRequest = selfiePatterns.some(p => p.test(messageLower));
        if (isSelfieRequest && choomImageSettings?.selfPortrait) {
          console.log(`   🔄 Self-portrait override: LLM said self_portrait=false but detected selfie request in prompt/message`);
          isSelfPortrait = true;
        }
      }

      // -------------------------------------------------------------------
      // Get the appropriate mode settings
      // -------------------------------------------------------------------
      const modeSettings = isSelfPortrait
        ? (choomImageSettings?.selfPortrait as Record<string, unknown>) || {}
        : (choomImageSettings?.general as Record<string, unknown>) || {};

      // -------------------------------------------------------------------
      // Set checkpoint based on mode (Layer 3 Choom > Layer 2 settings panel > none)
      // -------------------------------------------------------------------
      const checkpoint = (modeSettings.checkpoint as string) || (settings?.imageGen as Record<string, unknown>)?.defaultCheckpoint as string;
      console.log(`   🖼️  Image Checkpoint Resolution:`);
      console.log(`      Mode (${isSelfPortrait ? 'selfPortrait' : 'general'}): checkpoint=${(modeSettings.checkpoint as string) || '(not set)'}`);
      console.log(`      Settings panel default: checkpoint=${(settings?.imageGen as Record<string, unknown>)?.defaultCheckpoint || '(not set)'}`);
      console.log(`      ✅ RESOLVED checkpoint: ${checkpoint || '(none - using current)'}`);

      // Auto-detect checkpoint type from name if not explicitly set
      const checkpointType = (modeSettings.checkpointType as string) || (checkpoint ? detectCheckpointType(checkpoint) : 'other');

      // -------------------------------------------------------------------
      // Build the prompt (before lock, since this is CPU-only)
      // -------------------------------------------------------------------
      let prompt = toolCall.arguments.prompt as string;

      if (isSelfPortrait && modeSettings.characterPrompt) {
        prompt = `${modeSettings.characterPrompt}, ${prompt}`;
      }
      if (modeSettings.promptPrefix) {
        prompt = `${modeSettings.promptPrefix}, ${prompt}`;
      }
      if (modeSettings.promptSuffix) {
        prompt = `${prompt}, ${modeSettings.promptSuffix}`;
      }

      const validLoras = ((modeSettings.loras as Array<{ name: string; weight: number }>) || []).filter((l) => l.name && l.name.trim() !== '');
      if (validLoras.length > 0) {
        prompt = buildPromptWithLoras(prompt, validLoras);
        console.log(`   🎨 Applied ${validLoras.length} LoRA(s): ${validLoras.map((l) => `${l.name}:${l.weight}`).join(', ')}`);
      }

      // -------------------------------------------------------------------
      // Resolve dimensions
      // -------------------------------------------------------------------
      let genWidth: number;
      let genHeight: number;

      // Filter out "None"/null string values that some models pass for optional int params
      const argWidth = typeof toolCall.arguments.width === 'number' ? toolCall.arguments.width : parseInt(toolCall.arguments.width as string);
      const argHeight = typeof toolCall.arguments.height === 'number' ? toolCall.arguments.height : parseInt(toolCall.arguments.height as string);
      if (argWidth > 0 && argHeight > 0) {
        genWidth = argWidth;
        genHeight = argHeight;
      } else {
        const size = (toolCall.arguments.size as ImageSize) || (modeSettings.size as ImageSize) || 'medium';
        const aspect = (toolCall.arguments.aspect as ImageAspect) || (modeSettings.aspect as ImageAspect)
          || (isSelfPortrait ? 'portrait' : 'square');

        const dims = computeImageDimensions(size, aspect);
        genWidth = dims.width;
        genHeight = dims.height;
      }

      console.log(`   📐 Image dimensions: ${genWidth}x${genHeight} (self_portrait=${isSelfPortrait})`);

      // -------------------------------------------------------------------
      // Select CFG parameters based on checkpoint type
      // -------------------------------------------------------------------
      let genCfgScale: number;
      let genDistilledCfg: number;

      if (checkpointType === 'flux') {
        genCfgScale = 1;
        genDistilledCfg = (modeSettings.distilledCfg as number) || imageGenSettings.defaultDistilledCfg;
      } else if (checkpointType === 'pony') {
        genCfgScale = (modeSettings.cfgScale as number) || imageGenSettings.defaultCfgScale;
        genDistilledCfg = 0;
      } else {
        genCfgScale = (modeSettings.cfgScale as number) || imageGenSettings.defaultCfgScale;
        genDistilledCfg = (modeSettings.distilledCfg as number) || imageGenSettings.defaultDistilledCfg;
      }

      console.log(`   🔧 Generation params: type=${checkpointType}, cfgScale=${genCfgScale}, distilledCfg=${genDistilledCfg}`);

      // -------------------------------------------------------------------
      // Use image generation lock to serialize checkpoint switch + generation
      // -------------------------------------------------------------------
      const { genResult, finalImageUrl } = await withImageGenLock(async () => {
        if (checkpoint) {
          console.log(`   ⏳ Switching checkpoint to: ${checkpoint} (type: ${checkpointType})`);
          await imageGenClient.setCheckpointWithModules(checkpoint, checkpointType as 'pony' | 'flux' | 'other');
          const stripHash = (s: string) => s.replace(/\s*\[[\da-f]+\]$/i, '').trim();
          const maxWait = 120000;
          const pollInterval = 2000;
          const startTime = Date.now();
          let loaded = false;
          while (Date.now() - startTime < maxWait) {
            const opts = await imageGenClient.getOptions();
            const currentModel = stripHash(opts.sd_model_checkpoint as string || '');
            const targetModel = stripHash(checkpoint);
            if (currentModel === targetModel) {
              loaded = true;
              break;
            }
            console.log(`   ⏳ Waiting for checkpoint load... (current: ${currentModel}, target: ${targetModel})`);
            await new Promise(r => setTimeout(r, pollInterval));
          }
          if (loaded) {
            console.log(`   ✅ Checkpoint loaded in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
          } else {
            console.warn(`   ⚠️ Checkpoint may not have loaded after ${maxWait / 1000}s, proceeding anyway`);
          }
        }

        const result = await imageGenClient.generate({
          prompt,
          negativePrompt: toolCall.arguments.negative_prompt as string || (modeSettings.negativePrompt as string) || imageGenSettings.defaultNegativePrompt,
          width: genWidth,
          height: genHeight,
          steps: (typeof toolCall.arguments.steps === 'number' ? toolCall.arguments.steps : parseInt(toolCall.arguments.steps as string)) || (modeSettings.steps as number) || imageGenSettings.defaultSteps,
          cfgScale: genCfgScale,
          distilledCfg: genDistilledCfg,
          sampler: (modeSettings.sampler as string) || imageGenSettings.defaultSampler,
          scheduler: (modeSettings.scheduler as string) || imageGenSettings.defaultScheduler,
          isSelfPortrait,
        });

        // Upscale if configured or user requested (still inside lock)
        const userPromptLower = (toolCall.arguments.prompt as string || '').toLowerCase();
        const userRequestedUpscale = /\b(upscale|high[- ]?res|2x|hires)\b/.test(userPromptLower);
        let imageUrl = result.imageUrl;
        if (modeSettings.upscale || userRequestedUpscale) {
          try {
            console.log(`   🔍 Upscaling image 2x with Lanczos...`);
            const base64Data = result.imageUrl.split(',')[1] || result.imageUrl;
            imageUrl = await imageGenClient.upscaleImage(base64Data);
            console.log(`   ✅ Upscale complete`);
          } catch (upscaleError) {
            console.warn(`   ⚠️ Upscale failed, using original:`, upscaleError instanceof Error ? upscaleError.message : upscaleError);
          }
        }

        return { genResult: result, finalImageUrl: imageUrl };
      });

      // -------------------------------------------------------------------
      // Save generated image to database
      // -------------------------------------------------------------------
      const savedImage = await prisma.generatedImage.create({
        data: {
          choomId,
          prompt,
          imageUrl: finalImageUrl,
          settings: JSON.stringify(genResult.settings),
        },
      });

      // Enforce per-Choom image limit (keep last 50)
      const MAX_IMAGES_PER_CHOOM = 50;
      const allImages = await prisma.generatedImage.findMany({
        where: { choomId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (allImages.length > MAX_IMAGES_PER_CHOOM) {
        const idsToDelete = allImages.slice(MAX_IMAGES_PER_CHOOM).map((img) => img.id);
        await prisma.generatedImage.deleteMany({
          where: { id: { in: idsToDelete } },
        });
      }

      // -------------------------------------------------------------------
      // Send the image to the client for display
      // -------------------------------------------------------------------
      send({
        type: 'image_generated',
        imageUrl: finalImageUrl,
        imageId: savedImage.id,
        prompt,
      });

      return this.success(toolCall, {
        success: true,
        message: `Image generated successfully with seed ${genResult.seed}${modeSettings.upscale ? ' (upscaled 2x)' : ''}. The image has been displayed to the user. To analyze this image, call analyze_image with image_id="${savedImage.id}". To save this image to a project folder, call save_generated_image with image_id="${savedImage.id}" and a save_path like "project_name/images/filename.png".`,
        imageId: savedImage.id,
      });
    } catch (imageError) {
      console.error(`   ❌ Image generation FAILED:`, imageError instanceof Error ? imageError.message : imageError);
      return this.error(toolCall, `Image generation failed: ${imageError instanceof Error ? imageError.message : 'Unknown error'}`);
    }
  }

  private async handleSaveGeneratedImage(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const imageId = toolCall.arguments.image_id as string;
      const savePath = toolCall.arguments.save_path as string;

      if (!imageId) return this.error(toolCall, 'image_id is required');
      if (!savePath) return this.error(toolCall, 'save_path is required');

      // Look up the image in the database
      const genImage = await prisma.generatedImage.findUnique({
        where: { id: imageId },
      });

      if (!genImage?.imageUrl) {
        return this.error(toolCall, `Image not found with id "${imageId}". Make sure to use the imageId returned by generate_image.`);
      }

      // Extract base64 data from data URL
      const dataUrl = genImage.imageUrl;
      let base64Data: string;
      if (dataUrl.startsWith('data:')) {
        base64Data = dataUrl.split(',')[1];
      } else {
        base64Data = dataUrl;
      }

      if (!base64Data) {
        return this.error(toolCall, 'Image data is empty or corrupted');
      }

      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Write to workspace with image extensions allowed
      const ws = new WorkspaceService(WORKSPACE_ROOT, MAX_IMAGE_FILE_SIZE_KB, WORKSPACE_ALL_EXTENSIONS);
      const result = await ws.writeFileBuffer(savePath, imageBuffer, WORKSPACE_ALL_EXTENSIONS);

      ctx.sessionFileCount.created++;
      ctx.send({ type: 'file_created', path: savePath });

      console.log(`   💾 Saved generated image: ${imageId} → ${savePath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);
      return this.success(toolCall, { success: true, message: result, path: savePath, sizeKB: Math.round(imageBuffer.length / 1024) });
    } catch (err) {
      console.error('   ❌ Save generated image error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to save image: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
