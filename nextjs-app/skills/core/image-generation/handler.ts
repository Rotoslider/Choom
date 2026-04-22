import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { ImageGenClient, buildPromptWithLoras } from '@/lib/image-gen-client';
import { WorkspaceService } from '@/lib/workspace-service';
import prisma from '@/lib/db';
import { computeImageDimensions } from '@/lib/types';
import type { ImageSize, ImageAspect, ImageGenSettings, ToolCall, ToolResult } from '@/lib/types';
import { WORKSPACE_ROOT } from '@/lib/config';
import { waitForGpu } from '@/lib/gpu-lock';

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
const WORKSPACE_ALL_EXTENSIONS = ['.md', '.txt', '.json', '.py', '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.csv', '.sh', '.bash', '.yaml', '.yml', '.xml', '.sql', '.toml', '.ini', '.cfg', '.r', '.R', '.ipynb', '.log', ...WORKSPACE_IMAGE_EXTENSIONS];
const MAX_IMAGE_FILE_SIZE_KB = 10 * 1024; // 10MB

/**
 * Redact base64-encoded image data from a string. Prisma errors and other
 * upstream exceptions sometimes include the full `data:image/...;base64,...`
 * URL in their messages, which leaks multi-KB blobs into logs, traces, and
 * the terminal. Replace any such URL with a short placeholder.
 */
function redactBase64(s: string): string {
  if (!s) return s;
  return s
    .replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]{40,}/g, 'data:image/...[base64 redacted]')
    .replace(/"imageUrl"\s*:\s*"[^"]{200,}"/g, '"imageUrl":"[redacted]"');
}

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
    // Wait for GPU if it's occupied by a long-running command (training, inference).
    // Polls every 10s for up to 3 minutes before giving up.
    const gpuWait = await waitForGpu(180_000, 10_000);
    if (!gpuWait.free) {
      console.log(`   🚫 Image generation skipped — GPU still busy after ${Math.round(gpuWait.waitedMs / 1000)}s: ${gpuWait.reason}`);
      return this.error(toolCall, `GPU is busy with: ${gpuWait.reason}. Waited ${Math.round(gpuWait.waitedMs / 1000)}s but it didn't free up. Try again later.`);
    }

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
      // Selfie anti-repetition: inject diversity for self-portraits
      // -------------------------------------------------------------------
      let selfieDiversityNote = '';
      let selfieNegativeKeywords = '';
      if (isSelfPortrait) {
        try {
          const recentImages = await prisma.generatedImage.findMany({
            where: { choomId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { prompt: true },
          });

          if (recentImages.length > 0) {
            const stopWords = new Set([
              'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
              'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
              'should', 'may', 'might', 'can', 'need', 'to', 'of', 'in', 'for',
              'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
              'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
              'under', 'and', 'but', 'or', 'not', 'so', 'yet', 'both', 'each',
              'few', 'more', 'most', 'other', 'some', 'such', 'very', 'just',
              'because', 'if', 'when', 'where', 'how', 'all', 'any', 'every',
              'this', 'that', 'these', 'those', 'who', 'which', 'what',
              'image', 'photo', 'picture', 'portrait', 'self', 'selfie', 'woman',
              'man', 'person', 'looking', 'wearing', 'standing', 'sitting', 'style',
              'her', 'his', 'she', 'him', 'its', 'they', 'them', 'their', 'your',
            ]);

            const wordCounts = new Map<string, number>();
            for (const img of recentImages) {
              const words = img.prompt.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
              const seen = new Set<string>();
              for (const w of words) {
                if (w.length > 2 && !stopWords.has(w) && !seen.has(w)) {
                  seen.add(w);
                  wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
                }
              }
            }

            // Keywords appearing in 2+ recent prompts are "overused"
            const repeatedKeywords = [...wordCounts.entries()]
              .filter(([, count]) => count >= 2)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 20)
              .map(([word]) => word);

            if (repeatedKeywords.length > 0) {
              selfieDiversityNote = `. DIVERSITY: Make this selfie visually DISTINCT from recent ones. Overused concepts to AVOID: ${repeatedKeywords.join(', ')}. Try a completely different setting, outfit, lighting, mood, or activity`;
              selfieNegativeKeywords = repeatedKeywords.slice(0, 10).join(', ');
              console.log(`   🎲 Selfie diversity: excluding ${repeatedKeywords.length} overused keywords: ${repeatedKeywords.slice(0, 8).join(', ')}...`);
            }
          }
        } catch (diversityErr) {
          console.warn(`   ⚠️ Selfie diversity check failed:`, diversityErr instanceof Error ? diversityErr.message : diversityErr);
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

      // Required-parameter guard: some weak models (Gemma 4 26B observed)
      // emit generate_image calls with empty or missing `prompt`. Fail fast
      // with a clear, actionable error BEFORE reserving the GPU lock or
      // hitting Stable Diffusion. Without this guard, the call proceeds,
      // SD generates random imagery from an undefined prompt, and the
      // database insert fails — leaking the base64 imageUrl into the
      // Prisma error message.
      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        const argKeys = Object.keys(toolCall.arguments || {});
        return this.error(
          toolCall,
          `generate_image requires a 'prompt' argument describing the image to create. You called it with ${argKeys.length === 0 ? 'no arguments' : `args: [${argKeys.join(', ')}]`}. Retry with {"prompt": "a detailed description of the image", "aspect": "portrait"} (or another aspect). Do NOT call generate_image again without a prompt.`
        );
      }

      // Append selfie diversity instruction (before character/prefix additions)
      if (selfieDiversityNote) {
        prompt = prompt + selfieDiversityNote;
      }

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
        // Strip stray quotes/backslashes some models leak in via XML tool-call
        // parsing bleed (e.g. aspect="wide\""). Coerce to a known key or fall through.
        const cleanEnum = (v: unknown): string => typeof v === 'string' ? v.replace(/["\\\s]/g, '').toLowerCase() : '';
        const rawSize = cleanEnum(toolCall.arguments.size) || cleanEnum(modeSettings.size) || 'medium';
        const rawAspect = cleanEnum(toolCall.arguments.aspect) || cleanEnum(modeSettings.aspect) || (isSelfPortrait ? 'portrait' : 'square');
        const size = rawSize as ImageSize;
        const aspect = rawAspect as ImageAspect;

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
          negativePrompt: (toolCall.arguments.negative_prompt as string || (modeSettings.negativePrompt as string) || imageGenSettings.defaultNegativePrompt)
            + (selfieNegativeKeywords && checkpointType !== 'flux' ? `, ${selfieNegativeKeywords}` : ''),
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
        // Reclaim disk space from deleted image blobs
        await prisma.$queryRawUnsafe('PRAGMA incremental_vacuum');
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
      // Redact base64 data URLs from error messages. Prisma's invalid-args
      // error dumps the full call arguments including imageUrl, and that
      // imageUrl is a `data:image/...base64,...` blob that leaks multi-KB
      // of base64 into logs, traces, terminal, and the model's next iteration.
      const rawMsg = imageError instanceof Error ? imageError.message : String(imageError);
      const safeMsg = redactBase64(rawMsg);
      console.error(`   ❌ Image generation FAILED:`, safeMsg);
      return this.error(toolCall, `Image generation failed: ${safeMsg}`);
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
        // Stale-image-id guard: list current valid IDs for this Choom so the model
        // can pick the right one instead of retrying a fantasy/expired id.
        const recent = await prisma.generatedImage.findMany({
          where: { choomId: ctx.choomId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, prompt: true, createdAt: true },
        });
        const list = recent.length === 0
          ? '(no images have been generated for this Choom yet — call generate_image first)'
          : recent.map(r => `  - ${r.id} :: "${(r.prompt || '').slice(0, 60)}"`).join('\n');
        return this.error(
          toolCall,
          `Image id "${imageId}" was not found — it may be from a previous request or was never created. Current valid image ids for this Choom (most recent first):\n${list}\n\nCall save_generated_image again with one of these ids, or call generate_image first if you meant to create a new image.`
        );
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
