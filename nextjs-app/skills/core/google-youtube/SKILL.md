---
name: google-youtube
description: Search YouTube videos, get video/channel details, and browse playlists. Use when the user asks about YouTube content.
version: 1.0.0
author: system
tools:
  - search_youtube
  - get_video_details
  - get_channel_info
  - get_playlist_items
dependencies: []
---

# Google YouTube

## When to Use
- Search videos -> `search_youtube` (search by query, filter by type)
- Video details -> `get_video_details` (needs video_id)
- Channel info -> `get_channel_info` (needs channel_id)
- Playlist contents -> `get_playlist_items` (needs playlist_id)

## Important
- Requires YouTube Data API v3 enabled in Google Cloud Console
- OAuth scopes: youtube.readonly
- Video IDs from search results or URLs (e.g. dQw4w9WgXcQ)
- Channel IDs start with UC (e.g. UCxxxxxx)
- Playlist IDs start with PL (e.g. PLxxxxxx)
- API has daily quota limits (10,000 units/day)
