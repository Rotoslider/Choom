---
name: image-analysis
description: Analyzes images using a vision-capable LLM (Optic). Can read workspace images, URLs, base64 data, or previously generated images by ID.
version: 1.0.0
author: system
tools:
  - analyze_image
dependencies: []
---

# Image Analysis (Optic)

## When to Use
- User asks to look at/describe/analyze an image -> `analyze_image`
- After generating an image, review it -> `analyze_image` with `image_id`

## Input Sources (provide exactly one)
- `image_path`: workspace-relative path
- `image_url`: URL to fetch
- `image_base64`: raw base64 data
- `image_id`: ID from generate_image result

## Important
- Images resized to 768px max before analysis
- 10MB size limit
- MIME type auto-detected from extension
