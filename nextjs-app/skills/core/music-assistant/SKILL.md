---
name: music-assistant
description: Play and control music on speakers via Music Assistant
version: 1.0.0
author: system
tools:
  - music_search
  - music_play
  - music_control
  - music_now_playing
  - music_players
dependencies: []
---

## When to Use

Use these tools when the user wants to play music, control playback, or check what's playing.

### Level 1 — Quick Reference

- `music_play` — Play music by name or URI on a speaker
- `music_control` — Pause, resume, skip, volume, shuffle, repeat
- `music_search` — Find artists, albums, tracks, playlists, radio stations
- `music_now_playing` — What's currently playing
- `music_players` — List available speakers

### Level 2 — Usage Patterns

**Play music by name (auto-search):**
```
music_play(media="Tarja Turunen")
music_play(media="chill jazz", player="living room")
```

**Play specific URI from search results:**
```
results = music_search(query="Ave Maria")
music_play(media="library://track/19899")
```

**Control playback:**
```
music_control(action="pause")
music_control(action="volume_set", value=30)
music_control(action="next")
music_control(action="shuffle")
```

**Enqueue options:**
- `play` — Replace queue and start playing (default)
- `next` — Insert after current track
- `add` — Append to end of queue
- `replace` — Replace queue but don't start
- `replace_next` — Replace upcoming tracks, keep current
