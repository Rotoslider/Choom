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

- `music_play` — Play an artist, album, track, playlist or genre on a speaker
- `music_control` — Pause, resume, skip, volume, shuffle, repeat
- `music_search` — Find artists, albums, tracks, playlists and genres by name; empty query = what's in the library
- `music_now_playing` — What's currently playing
- `music_players` — List available speakers

**Search matches NAMES, not moods.** "soft acoustic morning music" finds nothing. To play by mood, pick a **genre** and pass it as media: `music_play(media="Folk")` plays an endless shuffled mix of it. `music_search(query="")` lists the library's genres (with track counts) and a random handful of artists.

**Never invent a speaker name.** Omit `player` to use the default; call `music_players` first if the user named a specific one.

**Parameter names matter.** `music_play` takes `media` (not `uri`/`query`); `music_control` takes `action` (not `command`). A uri from `music_search` goes in `media`: `music_play(media="library://track/123")`.

### Level 2 — Usage Patterns

**Play music by name (auto-search):**
```
music_play(media="Tarja Turunen")   # omit player — the default speaker is used
```

**Pick music yourself (by mood, or "play something you like"):**
```
music_search(query="")              # genres with track counts + random artists
music_play(media="Folk")            # a genre = endless shuffled mix, refills until stopped
music_search(query="Jazz")          # which artists and albums are filed under Jazz
music_play(media="<uri from that result>")   # one of them — copy the uri, never type one
```
Choose the genre closest to the mood, preferring one with plenty of tracks (a 5-track genre repeats itself fast): gentle or acoustic → Folk, New Age, Classical, Country; upbeat → Pop, Dance, Rock. One name per call — never string mood words together into a query.

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
