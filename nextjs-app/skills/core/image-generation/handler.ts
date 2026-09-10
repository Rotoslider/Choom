import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { ImageGenClient, buildPromptWithLoras } from '@/lib/image-gen-client';
import { WorkspaceService } from '@/lib/workspace-service';
import prisma from '@/lib/db';
import { computeImageDimensions } from '@/lib/types';
import type { ImageSize, ImageAspect, ImageGenSettings, ToolCall, ToolResult } from '@/lib/types';
import { REFERENCE_IMAGE_DEFAULT_MAX_DIM, WORKSPACE_ROOT, WORKSPACE_ALLOWED_EXTENSIONS, WORKSPACE_IMAGE_EXTENSIONS } from '@/lib/config';
import { waitForGpu } from '@/lib/gpu-lock';
import { detectCheckpointType } from '@/lib/checkpoint-modules';
import { loadReferenceImagesBase64 } from '@/lib/reference-images';
import { resolveReferences } from '@/lib/reference-library';
import type { CheckpointType, ReferenceImage } from '@/lib/types';

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
// Canonical lists from lib/config — no local shadow copies (they drift and
// silently reject extensions the workspace policy actually allows).

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
      const checkpointType = ((modeSettings.checkpointType as CheckpointType) || (checkpoint ? detectCheckpointType(checkpoint) : 'other')) as CheckpointType;

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

      // Applied on self-portraits, and on any image where the Choom named her own
      // subject — "Genesis and Donny on the porch" is a general-mode image that
      // still needs Genesis to look like Genesis. Without this the Choom's own
      // wording is the only description of her in the prompt, and an invented
      // "long dark wavy hair" overrides a blonde reference.
      // library is resolved later, so ask the DB directly: did the model name this
      // Choom's own subject? Matching is loose because the model's spelling is.
      const requestedNames = Array.isArray(toolCall.arguments.references)
        ? (toolCall.arguments.references as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];
      let ownSubjectReferenced = false;
      if (requestedNames.length > 0) {
        const own = await prisma.referenceSubject.findFirst({
          where: { choomId, enabled: true },
          select: { slug: true, name: true },
        });
        if (own) {
          const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '');
          const wanted = new Set(requestedNames.map(norm));
          ownSubjectReferenced = wanted.has(norm(own.slug)) || wanted.has(norm(own.name));
        }
      }
      const characterPrompt =
        (modeSettings.characterPrompt as string) ||
        ((choomImageSettings?.selfPortrait as Record<string, unknown> | undefined)
          ?.characterPrompt as string) ||
        '';
      if ((isSelfPortrait || ownSubjectReferenced) && characterPrompt) {
        prompt = `${characterPrompt}, ${prompt}`;
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

      if (checkpointType === 'klein') {
        // Flux.2 Klein is guidance-distilled: CFG 1 and no distilled-CFG knob.
        genCfgScale = 1;
        genDistilledCfg = 0;
      } else if (checkpointType === 'flux') {
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
      // Reference images (character sheets etc.) — read from disk before taking
      // the GPU lock, since this is pure file IO.
      // -------------------------------------------------------------------
      // Two layers, library first so the subject of the image leads: subjects the
      // model named (plus this Choom's own on a self-portrait), then the
      // always-on extras pinned in this mode's settings.
      const requestedReferences = Array.isArray(toolCall.arguments.references)
        ? (toolCall.arguments.references as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];
      const library = await resolveReferences({
        choomId,
        requested: requestedReferences,
        isSelfPortrait,
        prompt,
      });
      const pinned = await loadReferenceImagesBase64(
        choomId,
        modeSettings.referenceImages as ReferenceImage[] | undefined
      );
      const referenceImages = [...library.images, ...pinned];

      // Lead with who the references actually depict. Models describe other
      // people from imagination — a three-person scene came back with Genesis
      // dark-haired and un-bespectacled and Eve a different race, because the
      // prompt said "a woman with dark hair" and "dark curly hair and warm brown
      // skin" and never named either of them. Klein weights the front of the
      // prompt most, and prepending the speaker's own characterPrompt already
      // proved it fixes exactly this, so state every referenced subject up front
      // in the order their reference images are supplied.
      if (library.used.length > 1) {
        const roster = library.used
          .map((u, i) => {
            let look = (u.appearance || '').replace(/\s+/g, ' ').trim();
            // Descriptions often open with the name ("Donny — Donny, a tall...").
            const lead = new RegExp(`^${u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,.:—–-]*\\s*`, 'i');
            look = look.replace(lead, '').slice(0, 160);
            return `${i + 1}. ${u.name}${look ? ` — ${look}` : ''}`;
          })
          .join(' ');
        // The speaker's characterPrompt was prepended earlier; the roster now
        // carries it, so drop the duplicate rather than stating her twice.
        if (characterPrompt && prompt.includes(`${characterPrompt}, `)) {
          prompt = prompt.replace(`${characterPrompt}, `, '');
        }
        // "left to right" is literal: reference order is where people land in the
        // frame, and the roster is read the same way.
        prompt = `People in this image, left to right, matching the reference images in order: ${roster}. ${prompt}`;
      }
      const referenceMaxDim = (modeSettings.referenceMaxDim as number) || REFERENCE_IMAGE_DEFAULT_MAX_DIM;
      if (referenceImages.length > 0) {
        const named = library.used.map(u => u.slug).join(', ') || 'none';
        console.log(`   🖼️  ${referenceImages.length} reference image(s) @ max ${referenceMaxDim}px — subjects: ${named}${pinned.length ? `, +${pinned.length} pinned` : ''}`);
      }
      if (library.unknown.length > 0) {
        console.warn(`   ⚠️ Unknown reference(s) ignored: ${library.unknown.join(', ')}`);
      }
      if (library.truncated) {
        console.warn(`   ⚠️ Reference list trimmed to stay within the per-image cap`);
      }

      // -------------------------------------------------------------------
      // Use image generation lock to serialize checkpoint switch + generation
      // -------------------------------------------------------------------
      const { genResult, finalImageUrl } = await withImageGenLock(async () => {
        if (checkpoint) {
          console.log(`   ⏳ Switching checkpoint to: ${checkpoint} (type: ${checkpointType})`);
          await imageGenClient.setCheckpointWithModules(
            checkpoint,
            checkpointType,
            modeSettings.modules as string[] | undefined
          );
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
          negativePrompt: (toolCall.arguments.negative_prompt as string || (modeSettings.negativePrompt as string) || imageGenSettings.defaultNegativePrompt),
          width: genWidth,
          height: genHeight,
          steps: (typeof toolCall.arguments.steps === 'number' ? toolCall.arguments.steps : parseInt(toolCall.arguments.steps as string)) || (modeSettings.steps as number) || imageGenSettings.defaultSteps,
          cfgScale: genCfgScale,
          distilledCfg: genDistilledCfg,
          sampler: (modeSettings.sampler as string) || imageGenSettings.defaultSampler,
          scheduler: (modeSettings.scheduler as string) || imageGenSettings.defaultScheduler,
          referenceImages,
          referenceMaxDim,
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
        message: `Image generated successfully with seed ${genResult.seed}${modeSettings.upscale ? ' (upscaled 2x)' : ''}.${library.used.length > 0 ? ` References used: ${library.used.map(u => u.slug).join(', ')}.` : ''}${library.unknown.length > 0 ? ` No reference exists named: ${library.unknown.join(', ')} — ask the user to add it to the reference library if it should.` : ''} The image has been displayed to the user. To analyze this image, call analyze_image with image_id="${savedImage.id}". To save this image to a project folder, call save_generated_image with image_id="${savedImage.id}" and a save_path like "project_name/images/filename.png".`,
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

      // Models routinely pass a save_path with NO extension (or a non-image one),
      // which the workspace rejects with `Extension "" not allowed`. Generated
      // images are PNG, so default to .png when no image extension is present.
      let normalizedPath = savePath.trim();
      const lower = normalizedPath.toLowerCase();
      if (!WORKSPACE_IMAGE_EXTENSIONS.some(e => lower.endsWith(e))) {
        normalizedPath = normalizedPath.replace(/\.+$/, '') + '.png';
      }

      // Write to workspace with image extensions allowed
      const ws = new WorkspaceService(WORKSPACE_ROOT, MAX_IMAGE_FILE_SIZE_KB, [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS]);
      const result = await ws.writeFileBuffer(normalizedPath, imageBuffer, [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS]);

      ctx.sessionFileCount.created++;
      ctx.send({ type: 'file_created', path: normalizedPath });

      console.log(`   💾 Saved generated image: ${imageId} → ${normalizedPath} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);
      return this.success(toolCall, { success: true, message: result, path: normalizedPath, sizeKB: Math.round(imageBuffer.length / 1024) });
    } catch (err) {
      console.error('   ❌ Save generated image error:', err instanceof Error ? err.message : err);
      return this.error(toolCall, `Failed to save image: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
