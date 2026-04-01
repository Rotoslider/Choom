/**
 * Playwright Service — JS-rendered web scraping
 *
 * Launches a headless Chromium browser on-demand to scrape pages that
 * require JavaScript rendering. Browser instances are short-lived (one
 * per scrape call) to avoid memory leaks.
 */

import type { Browser, Page } from 'playwright';

const SCRAPE_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 20_000;

interface ScrapedImage {
  url: string;
  alt: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface ScrapeResult {
  title: string;
  url: string;
  text: string;
  wordCount: number;
  images: ScrapedImage[];
  metaDescription: string;
}

/**
 * Scrape a page using Playwright's headless Chromium.
 * Returns extracted text content and images from the fully-rendered DOM.
 */
export async function scrapePage(
  url: string,
  options: {
    waitFor?: string;      // CSS selector to wait for before extracting
    extractImages?: boolean;
    minImageWidth?: number;
    maxImages?: number;
    timeout?: number;
  } = {}
): Promise<ScrapeResult> {
  const {
    waitFor,
    extractImages = true,
    minImageWidth = 80,
    maxImages = 20,
    timeout = SCRAPE_TIMEOUT_MS,
  } = options;

  // Dynamic import — playwright is heavy, only load when needed
  const { chromium } = await import('playwright');

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    // Block heavy resources we don't need
    await context.route('**/*.{mp4,webm,ogg,avi,mov,flv}', route => route.abort());
    await context.route('**/*.{woff,woff2,ttf,eot}', route => route.abort());

    const page: Page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // Navigate and wait for content
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    // Wait for network to settle (most dynamic content loads within 2s of DOMContentLoaded)
    await page.waitForLoadState('networkidle').catch(() => {
      // networkidle can hang on pages with persistent connections — don't fail
    });

    // Optional: wait for a specific element
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {
        console.warn(`   ⚠️ Playwright: waitFor selector "${waitFor}" not found within 10s`);
      });
    }

    // Scroll down to trigger lazy-loaded content
    await autoScroll(page);

    // Extract page title
    const title = await page.title();

    // Extract meta description
    const metaDescription = await page.$eval(
      'meta[name="description"]',
      el => el.getAttribute('content') || ''
    ).catch(() => '');

    // Extract main text content — prefer article/main, fall back to body
    const text = await page.evaluate(() => {
      // Try semantic content containers first
      const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-content', '.entry-content'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim().length > 200) {
          return el.textContent!.trim();
        }
      }
      // Fall back to body, excluding nav/header/footer/script/style
      const body = document.body;
      if (!body) return '';
      const clone = body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('nav, header, footer, script, style, noscript, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .menu, .footer, .header, .ad, .advertisement, .cookie-banner').forEach(el => el.remove());
      return clone.textContent?.trim() || '';
    });

    // Clean up text: collapse whitespace, remove excessive blank lines
    const cleanedText = text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+$/gm, '')
      .trim();

    const wordCount = cleanedText.split(/\s+/).filter(w => w.length > 0).length;

    // Extract images from rendered DOM
    let images: ScrapedImage[] = [];
    if (extractImages) {
      images = await page.evaluate((minW: number) => {
        const imgs: ScrapedImage[] = [];
        const seen = new Set<string>();

        document.querySelectorAll('img').forEach(img => {
          const src = img.currentSrc || img.src;
          if (!src || src.startsWith('data:') || seen.has(src)) return;
          seen.add(src);

          // Get rendered dimensions
          const rect = img.getBoundingClientRect();
          const w = Math.round(rect.width);
          const h = Math.round(rect.height);

          // Filter out tiny images (icons, spacers, tracking pixels)
          if (w < minW && img.naturalWidth < minW) return;
          if (h < 20) return;

          // Skip common non-content patterns
          if (/\b(pixel|tracking|beacon|spacer|blank|1x1|logo|icon|favicon|spinner|loading)\b/i.test(src)) return;
          if (/\.(svg|ico)$/i.test(src)) return;

          imgs.push({
            url: src,
            alt: (img.alt || '').slice(0, 200),
            width: w,
            height: h,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
          });
        });

        // Sort by area (largest first) — product images tend to be bigger
        imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));

        return imgs;
      }, minImageWidth);

      images = images.slice(0, maxImages);
    }

    await context.close();

    return {
      title,
      url,
      text: cleanedText,
      wordCount,
      images,
      metaDescription,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Scroll down the page to trigger lazy-loaded images and content.
 * Scrolls in chunks and waits briefly between scrolls.
 */
async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>(resolve => {
      let totalHeight = 0;
      const distance = 400;
      const maxScrolls = 10;
      let scrolls = 0;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        scrolls++;

        if (totalHeight >= document.body.scrollHeight || scrolls >= maxScrolls) {
          clearInterval(timer);
          window.scrollTo(0, 0); // scroll back to top
          resolve();
        }
      }, 150);
    });
  });
}
