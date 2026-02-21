/**
 * PDF Service
 * Converts markdown content to PDF using pdfkit.
 * Supports embedded images from workspace paths.
 */

import { mkdir } from 'fs/promises';
import path from 'path';

export interface PDFImage {
  path: string;       // Absolute path to the image file
  width?: number;     // Max width in points (default: fit within page margins)
  caption?: string;   // Optional caption below the image
}

export class PDFService {
  /**
   * Convert markdown text to a PDF file.
   * Parses: headers, paragraphs, lists, code blocks, images, horizontal rules.
   * Images can come from:
   *   1. Markdown syntax: ![caption](path) — resolved against workspaceRoot
   *   2. Explicit images array — pre-resolved absolute paths
   */
  static async markdownToPDF(
    markdown: string,
    outputPath: string,
    title?: string,
    options?: { images?: PDFImage[]; workspaceRoot?: string }
  ): Promise<void> {
    // Dynamic import of pdfkit — handle both ESM wrapper (.default) and CJS (direct)
    const pdfkitModule = await import('pdfkit');
    const PDFDocument = (pdfkitModule as any).default || pdfkitModule;

    // Ensure output directory exists
    await mkdir(path.dirname(outputPath), { recursive: true });

    // Build a lookup map for explicit images: filename → PDFImage
    const imageMap = new Map<string, PDFImage>();
    if (options?.images) {
      for (const img of options.images) {
        imageMap.set(path.basename(img.path), img);
        // Also index by relative path segments for flexible matching
        const parts = img.path.split('/');
        if (parts.length >= 2) {
          imageMap.set(parts.slice(-2).join('/'), img);
        }
      }
    }

    return new Promise((resolve, reject) => {
      const { createWriteStream, existsSync } = require('fs');
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 72, bottom: 72, left: 72, right: 72 },
      });

      const stream = createWriteStream(outputPath);
      doc.pipe(stream);

      const pageWidth = 612;  // LETTER width in points
      const marginLeft = 72;
      const marginRight = 72;
      const contentWidth = pageWidth - marginLeft - marginRight; // 468 points

      // Title page
      if (title) {
        doc.fontSize(24).font('Helvetica-Bold').text(title, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(10).font('Helvetica').fillColor('#666666')
          .text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), { align: 'center' });
        doc.fillColor('#000000');
        doc.moveDown(2);
      }

      /**
       * Embed an image into the PDF document.
       * Returns true if the image was successfully embedded.
       */
      function embedImage(imagePath: string, maxWidth?: number, caption?: string): boolean {
        try {
          if (!existsSync(imagePath)) return false;

          // Check if it's a supported image format
          const ext = path.extname(imagePath).toLowerCase();
          if (!['.png', '.jpg', '.jpeg'].includes(ext)) return false;

          const imgWidth = Math.min(maxWidth || contentWidth, contentWidth);

          // Check if we need a new page (leave room for image + caption)
          const pageBottom = 792 - 72; // LETTER height minus bottom margin
          if (doc.y + 100 > pageBottom) {
            doc.addPage();
          }

          doc.moveDown(0.3);
          doc.image(imagePath, {
            fit: [imgWidth, 500],  // max height 500pt to avoid overflow
            align: 'center',
          });
          doc.moveDown(0.3);

          if (caption) {
            doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555')
              .text(caption, { align: 'center' });
            doc.fillColor('#000000');
            doc.moveDown(0.3);
          }

          return true;
        } catch (err) {
          // Image embed failed — skip silently
          return false;
        }
      }

      const lines = markdown.split('\n');
      let inCodeBlock = false;

      for (const line of lines) {
        // Code block toggle
        if (line.startsWith('```')) {
          inCodeBlock = !inCodeBlock;
          if (inCodeBlock) {
            doc.moveDown(0.3);
          } else {
            doc.moveDown(0.3);
          }
          continue;
        }

        // Code block content
        if (inCodeBlock) {
          doc.fontSize(9).font('Courier').fillColor('#333333').text(line, { indent: 20 });
          doc.fillColor('#000000');
          continue;
        }

        // Empty line
        if (line.trim() === '') {
          doc.moveDown(0.5);
          continue;
        }

        // Markdown image: ![alt text](path)
        const imageMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (imageMatch) {
          const altText = imageMatch[1];
          const imgRef = imageMatch[2];

          // Try to resolve the image path
          let resolvedPath: string | null = null;

          // 1. Check explicit images map (by filename or relative path)
          const fromMap = imageMap.get(imgRef) || imageMap.get(path.basename(imgRef));
          if (fromMap) {
            resolvedPath = fromMap.path;
          }

          // 2. Try resolving against workspace root
          if (!resolvedPath && options?.workspaceRoot) {
            const wsPath = path.resolve(options.workspaceRoot, imgRef);
            if (wsPath.startsWith(options.workspaceRoot) && existsSync(wsPath)) {
              resolvedPath = wsPath;
            }
          }

          // 3. Try as absolute path (if it's already absolute)
          if (!resolvedPath && path.isAbsolute(imgRef) && existsSync(imgRef)) {
            resolvedPath = imgRef;
          }

          if (resolvedPath) {
            embedImage(resolvedPath, fromMap?.width, altText || fromMap?.caption);
          } else {
            // Image not found — render as text placeholder
            doc.fontSize(9).font('Helvetica-Oblique').fillColor('#999999')
              .text(`[Image: ${altText || imgRef}]`, { align: 'center' });
            doc.fillColor('#000000');
            doc.moveDown(0.3);
          }
          continue;
        }

        // Headers
        if (line.startsWith('# ')) {
          doc.moveDown(0.5);
          doc.fontSize(20).font('Helvetica-Bold').text(line.slice(2));
          doc.moveDown(0.3);
          continue;
        }
        if (line.startsWith('## ')) {
          doc.moveDown(0.4);
          doc.fontSize(16).font('Helvetica-Bold').text(line.slice(3));
          doc.moveDown(0.2);
          continue;
        }
        if (line.startsWith('### ')) {
          doc.moveDown(0.3);
          doc.fontSize(13).font('Helvetica-Bold').text(line.slice(4));
          doc.moveDown(0.2);
          continue;
        }

        // Bullet list
        if (/^[-*] /.test(line)) {
          const text = line.replace(/^[-*] /, '');
          doc.fontSize(11).font('Helvetica').text(`  \u2022  ${stripMarkdownInline(text)}`, { indent: 10 });
          continue;
        }

        // Numbered list
        if (/^\d+\. /.test(line)) {
          const match = line.match(/^(\d+)\. (.+)/);
          if (match) {
            doc.fontSize(11).font('Helvetica').text(`  ${match[1]}.  ${stripMarkdownInline(match[2])}`, { indent: 10 });
          }
          continue;
        }

        // Horizontal rule
        if (/^---+$/.test(line.trim())) {
          doc.moveDown(0.3);
          const y = doc.y;
          doc.moveTo(72, y).lineTo(540, y).strokeColor('#cccccc').stroke();
          doc.strokeColor('#000000');
          doc.moveDown(0.3);
          continue;
        }

        // Regular paragraph
        doc.fontSize(11).font('Helvetica').text(stripMarkdownInline(line));
      }

      // Append any explicit images that weren't referenced in the markdown
      if (options?.images && options.images.length > 0) {
        // Track which images were already embedded via markdown syntax
        const embeddedPaths = new Set<string>();
        for (const line of lines) {
          const m = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
          if (m) {
            const imgRef = m[2];
            embeddedPaths.add(imgRef);
            embeddedPaths.add(path.basename(imgRef));
          }
        }

        const remaining = options.images.filter(img => {
          const base = path.basename(img.path);
          const rel = img.path.split('/').slice(-2).join('/');
          return !embeddedPaths.has(base) && !embeddedPaths.has(rel) && !embeddedPaths.has(img.path);
        });

        if (remaining.length > 0) {
          doc.addPage();
          doc.fontSize(16).font('Helvetica-Bold').text('Images', { align: 'center' });
          doc.moveDown(0.5);

          for (const img of remaining) {
            embedImage(img.path, img.width, img.caption);
          }
        }
      }

      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }
}

/** Strip inline markdown formatting (bold, italic, code, links) for PDF text */
function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')       // italic
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')         // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');  // links → just text
}
