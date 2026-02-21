import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { WorkspaceService } from '@/lib/workspace-service';
import { WORKSPACE_ROOT } from '@/lib/config';
const WORKSPACE_MAX_FILE_SIZE_KB = 1024;
const WORKSPACE_ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.py', '.ts', '.js', '.html', '.css', '.csv'];
const WORKSPACE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
const WORKSPACE_DOWNLOAD_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx', '.zip', '.tar', '.gz', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sh', '.bash', '.sql', '.r', '.R', '.ipynb'];

const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TOOL_NAMES = new Set([
  'scrape_page_images',
  'download_web_image',
  'download_web_file',
]);

export default class WebScrapingHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TOOL_NAMES.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'scrape_page_images':
        return this.scrapePageImages(toolCall);
      case 'download_web_image':
        return this.downloadWebImage(toolCall, ctx);
      case 'download_web_file':
        return this.downloadWebFile(toolCall, ctx);
      default:
        return this.error(toolCall, `Unknown web-scraping tool: ${toolCall.name}`);
    }
  }

  // ===========================================================================
  // scrape_page_images
  // ===========================================================================

  private async scrapePageImages(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const pageUrl = toolCall.arguments.url as string;
      const minWidth = (toolCall.arguments.min_width as number) || 100;
      const limit = (toolCall.arguments.limit as number) || 20;

      // Validate URL
      const parsedPageUrl = new URL(pageUrl);
      if (!['http:', 'https:'].includes(parsedPageUrl.protocol)) {
        throw new Error('Only http/https URLs are allowed');
      }

      // Fetch the page HTML with browser-like headers
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(pageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const imageUrls: string[] = [];
      const seen = new Set<string>();

      // Helper: resolve relative URLs and deduplicate
      function addUrl(src: string) {
        if (!src || src.startsWith('data:')) return;
        try {
          const resolved = new URL(src, pageUrl).href;
          // Skip tiny tracking pixels and common non-content patterns
          if (seen.has(resolved)) return;
          if (/\b(pixel|tracking|beacon|spacer|blank|1x1)\b/i.test(resolved)) return;
          seen.add(resolved);
          imageUrls.push(resolved);
        } catch { /* invalid URL */ }
      }

      // 1. Extract <img src="..."> and <img data-src="..." (lazy loading)>
      const imgSrcRegex = /<img\s[^>]*?(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
      let match;
      while ((match = imgSrcRegex.exec(html)) !== null) {
        addUrl(match[1]);
      }

      // 2. Extract srcset URLs (responsive images -- pick the largest)
      const srcsetRegex = /srcset\s*=\s*["']([^"']+)["']/gi;
      while ((match = srcsetRegex.exec(html)) !== null) {
        const entries = match[1].split(',').map(s => s.trim());
        for (const entry of entries) {
          const parts = entry.split(/\s+/);
          if (parts[0]) addUrl(parts[0]);
        }
      }

      // 3. Extract og:image and twitter:image meta tags
      const metaRegex = /<meta\s[^>]*?(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*?content\s*=\s*["']([^"']+)["'][^>]*>/gi;
      while ((match = metaRegex.exec(html)) !== null) {
        addUrl(match[1]);
      }
      // Also match reverse order: content before property
      const metaRegex2 = /<meta\s[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>/gi;
      while ((match = metaRegex2.exec(html)) !== null) {
        addUrl(match[1]);
      }

      // 4. Extract background-image CSS urls
      const bgRegex = /background(?:-image)?\s*:\s*url\(["']?([^"')]+)["']?\)/gi;
      while ((match = bgRegex.exec(html)) !== null) {
        addUrl(match[1]);
      }

      // 5. Extract JSON-LD product images
      const jsonLdRegex = /<script\s[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      while ((match = jsonLdRegex.exec(html)) !== null) {
        try {
          const data = JSON.parse(match[1]);
          // Handle both single objects and arrays
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item.image) {
              const imgs = Array.isArray(item.image) ? item.image : [item.image];
              for (const img of imgs) {
                if (typeof img === 'string') addUrl(img);
                else if (img?.url) addUrl(img.url);
              }
            }
          }
        } catch { /* invalid JSON-LD */ }
      }

      // Filter: attempt to guess dimensions from URL params and skip small images
      const filtered = imageUrls.filter(u => {
        // Check for dimension hints in the URL
        const widthMatch = u.match(/[?&](?:w|width)=(\d+)/i) || u.match(/(\d+)x\d+/);
        if (widthMatch) {
          const w = parseInt(widthMatch[1]);
          if (w < minWidth) return false;
        }
        // Skip common non-content image patterns
        if (/\.(svg|ico)$/i.test(u)) return false;
        return true;
      });

      const results = filtered.slice(0, limit);
      console.log(`   🔍 Scraped ${pageUrl}: found ${imageUrls.length} images, filtered to ${results.length}`);

      return this.success(toolCall, {
        success: true,
        pageUrl,
        totalFound: imageUrls.length,
        returned: results.length,
        images: results.map((u, i) => {
          const pathname = new URL(u).pathname;
          const dotIdx = pathname.lastIndexOf('.');
          const ext = dotIdx >= 0 ? pathname.slice(dotIdx).toLowerCase() : '(unknown)';
          return { index: i, url: u, extension: ext };
        }),
      });
    } catch (err) {
      return this.error(toolCall, `Page scrape failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // ===========================================================================
  // download_web_image
  // ===========================================================================

  private async downloadWebImage(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const url = toolCall.arguments.url as string;
      const savePath = toolCall.arguments.save_path as string;
      const resizeMax = toolCall.arguments.resize_max as number | undefined;

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error('Only http/https URLs are allowed');
        }
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }

      const { sessionFileCount } = ctx;
      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        throw new Error(`Session file limit reached (${sessionFileCount.maxAllowed}). Cannot download more files.`);
      }

      // Fetch with timeout and browser-like headers to avoid 403 blocks
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': parsedUrl.origin + '/',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Validate content type
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        throw new Error(`Not an image: content-type is "${contentType}"`);
      }

      // Read body and enforce 10MB limit
      const arrayBuffer = await response.arrayBuffer();
      const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
      if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum: 10MB`);
      }

      let imageBuffer: Buffer = Buffer.from(arrayBuffer) as Buffer;
      let finalSavePath = savePath;

      // Auto-convert WebP to PNG (better compatibility with PDFs, viewers, etc.)
      const isWebP = contentType.includes('webp') || url.toLowerCase().endsWith('.webp');
      if (isWebP) {
        try {
          const sharp = (await import('sharp')).default;
          imageBuffer = await sharp(imageBuffer).png().toBuffer();
          // Update save path extension to .png if it was .webp
          if (finalSavePath.toLowerCase().endsWith('.webp')) {
            finalSavePath = finalSavePath.replace(/\.webp$/i, '.png');
          } else if (!finalSavePath.toLowerCase().endsWith('.png')) {
            finalSavePath = finalSavePath + '.png';
          }
          console.log(`   🔄 Converted WebP to PNG (${(arrayBuffer.byteLength / 1024).toFixed(0)}KB → ${(imageBuffer.length / 1024).toFixed(0)}KB)`);
        } catch (convertErr) {
          console.warn(`   ⚠️ WebP conversion failed, saving as-is:`, convertErr);
        }
      }

      // Optional resize via sharp
      if (resizeMax && resizeMax > 0) {
        try {
          const sharp = (await import('sharp')).default;
          imageBuffer = await sharp(imageBuffer)
            .resize(resizeMax, resizeMax, { fit: 'inside', withoutEnlargement: true })
            .toBuffer();
        } catch (resizeErr) {
          console.warn(`   ⚠️ Image resize failed, saving original:`, resizeErr);
        }
      }

      // Write to workspace with image extensions allowed
      const ws = new WorkspaceService(WORKSPACE_ROOT, MAX_IMAGE_BYTES / 1024, [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS]);
      const result = await ws.writeFileBuffer(finalSavePath, imageBuffer, [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS]);
      sessionFileCount.created++;
      ctx.send({ type: 'file_created', path: finalSavePath });
      const webpNote = isWebP ? ' (converted from WebP to PNG)' : '';
      console.log(`   🖼️ Downloaded image: ${url} → ${finalSavePath} (${(imageBuffer.length / 1024).toFixed(1)}KB)${webpNote}`);

      return this.success(toolCall, { success: true, message: result + webpNote, path: finalSavePath, sizeKB: Math.round(imageBuffer.length / 1024) });
    } catch (err) {
      return this.error(toolCall, `Image download failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // ===========================================================================
  // download_web_file
  // ===========================================================================

  private async downloadWebFile(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const url = toolCall.arguments.url as string;
      const savePath = toolCall.arguments.save_path as string;

      // Validate URL
      let fileParsedUrl: URL;
      try {
        fileParsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(fileParsedUrl.protocol)) {
          throw new Error('Only http/https URLs are allowed');
        }
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }

      const { sessionFileCount } = ctx;
      if (sessionFileCount.created >= sessionFileCount.maxAllowed) {
        throw new Error(`Session file limit reached (${sessionFileCount.maxAllowed}). Cannot download more files.`);
      }

      // Fetch with timeout and browser-like headers
      const fileController = new AbortController();
      const timeout = setTimeout(() => fileController.abort(), 60000); // 60s for larger files
      const response = await fetch(url, {
        signal: fileController.signal,
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': fileParsedUrl.origin + '/',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Read body and enforce 50MB limit
      const arrayBuffer = await response.arrayBuffer();
      const MAX_FILE_BYTES = 50 * 1024 * 1024;
      if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
        throw new Error(`File too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum: 50MB`);
      }

      const fileBuffer = Buffer.from(arrayBuffer) as Buffer;
      const allDownloadExtensions = [...WORKSPACE_ALLOWED_EXTENSIONS, ...WORKSPACE_IMAGE_EXTENSIONS, ...WORKSPACE_DOWNLOAD_EXTENSIONS];
      const ws = new WorkspaceService(WORKSPACE_ROOT, MAX_FILE_BYTES / 1024, allDownloadExtensions);
      const result = await ws.writeFileBuffer(savePath, fileBuffer, allDownloadExtensions);
      sessionFileCount.created++;
      ctx.send({ type: 'file_created', path: savePath });
      console.log(`   📥 Downloaded file: ${url} → ${savePath} (${(fileBuffer.length / 1024).toFixed(1)}KB)`);

      return this.success(toolCall, { success: true, message: result, path: savePath, sizeKB: Math.round(fileBuffer.length / 1024) });
    } catch (err) {
      return this.error(toolCall, `File download failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}
