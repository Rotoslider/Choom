---
name: web-scraping
description: Scrapes webpages for text and images using a headless browser (JS-rendered) or static HTML. Downloads images and files from the web.
version: 2.0.0
author: system
tools:
  - scrape_page_content
  - scrape_page_images
  - download_web_image
  - download_web_file
dependencies: []
---

# Web Scraping & Downloads

## When to Use
- Scrape page text + images (JS-rendered) -> `scrape_page_content` (best for modern sites, SPAs, product pages)
- Find images on a simple page -> `scrape_page_images` (faster, static HTML only)
- Download image -> `download_web_image` (after scraping for real URLs)
- Download file (PDF, doc, etc.) -> `download_web_file`

## scrape_page_content vs scrape_page_images
- `scrape_page_content`: Uses headless Chromium, renders JavaScript, extracts text AND images. Use for product pages, SPAs, dynamic content. Returns text + sorted images (largest first).
- `scrape_page_images`: Static HTML fetch, faster but misses JS-loaded content. Use for simple pages with standard img tags.

## Important
- NEVER guess CDN URLs -- always scrape first
- WebP images auto-converted to PNG on download
- Browser User-Agent headers used to avoid 403 blocks
- Image download: 10MB limit, File download: 50MB limit
- scrape_page_content text capped at 15K chars to avoid context bloat
