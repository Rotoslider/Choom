import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'scrape_page_images',
    description:
      'Fetch a webpage and extract all image URLs from the HTML. Use this BEFORE download_web_image to find real image URLs — never guess CDN URLs. Returns a list of image URLs found on the page (from img src, srcset, og:image meta tags, etc.).',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the webpage to scrape for images (e.g. a product page, article, gallery)',
        },
        min_width: {
          type: 'number',
          description: 'Optional minimum image width to filter (ignores tiny icons/spacers). Default: 100',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of image URLs to return (default 20)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'download_web_image',
    description:
      'Download an image from a URL and save it to the project workspace. Use during research to save reference images, diagrams, screenshots, or other visual assets. The image will be validated (must be image/* content-type) and optionally resized.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the image to download (must serve image/* content-type)',
        },
        save_path: {
          type: 'string',
          description: 'Relative path in workspace to save the image (e.g. "research/diagram.png", "images/reference.jpg")',
        },
        resize_max: {
          type: 'number',
          description: 'Optional: maximum dimension in pixels. Image will be resized to fit within this size while maintaining aspect ratio.',
        },
      },
      required: ['url', 'save_path'],
    },
  },
  {
    name: 'scrape_page_content',
    description:
      'Scrape a webpage with full JavaScript rendering using a headless browser. Returns the page\'s text content AND images. Use this instead of scrape_page_images when the page uses JavaScript to load content (SPAs, product pages, dynamic sites). For static HTML pages, scrape_page_images is faster.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the webpage to scrape',
        },
        wait_for: {
          type: 'string',
          description: 'Optional CSS selector to wait for before extracting content (e.g. ".product-list", "#results")',
        },
        include_images: {
          type: 'boolean',
          description: 'Whether to extract images from the page (default: true)',
        },
        max_images: {
          type: 'number',
          description: 'Maximum number of images to return, sorted by size (default: 15)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'download_web_file',
    description:
      'Download any file from a URL and save it to the project workspace. Use for PDFs, documents, archives, data files, or any non-image file. For images, prefer download_web_image instead (it supports resizing). The file extension in save_path must match the content being downloaded.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the file to download',
        },
        save_path: {
          type: 'string',
          description: 'Relative path in workspace to save the file (e.g. "research/paper.pdf", "data/dataset.csv")',
        },
      },
      required: ['url', 'save_path'],
    },
  },
];
