---
name: web-scraping
description: Downloads images and files from the web, and scrapes webpage image URLs. Use scrape_page_images FIRST to find real URLs before downloading.
version: 1.0.0
author: system
tools:
  - scrape_page_images
  - download_web_image
  - download_web_file
dependencies: []
---

# Web Scraping & Downloads

## When to Use
- Find images on a page -> `scrape_page_images` (always use FIRST)
- Download image -> `download_web_image` (after scraping for real URLs)
- Download file (PDF, doc, etc.) -> `download_web_file`

## Important
- NEVER guess CDN URLs -- always scrape first
- WebP images auto-converted to PNG
- Browser User-Agent headers used to avoid 403 blocks
- Image download: 10MB limit, File download: 50MB limit
- Referer header sent automatically
