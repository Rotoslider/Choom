---
name: pdf-processing
description: Generates PDFs from markdown content and extracts text from existing PDFs. Supports embedded images via markdown syntax or explicit images array.
version: 1.0.0
author: system
tools:
  - workspace_generate_pdf
  - workspace_read_pdf
dependencies: []
---

# PDF Processing

## When to Use
- Convert markdown to PDF → `workspace_generate_pdf`
- Read/extract text from PDF → `workspace_read_pdf`

## Important
- Embed images via `![caption](path)` in markdown or `images` array
- Images resolved from workspace root
- For large PDFs, use page_start/page_end for specific sections
