---
name: web-searching
description: Searches the web for current information using Brave Search or SearXNG. Use for recent events, current information, or factual lookups.
version: 1.0.0
author: system
tools:
  - web_search
dependencies: []
---

# Web Searching

## When to Use
- User asks about current events or recent news → `web_search`
- User says "search for", "look up", "find out" → `web_search`

## Important
- Supported providers: Brave Search (needs API key) and SearXNG (self-hosted)
- Default max results: 5
- Results include title, URL, and snippet
