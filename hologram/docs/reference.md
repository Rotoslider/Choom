# Chooms in Glass: technical reference

The details behind [the README](../README.md): how each part works, how the moving reliefs are made,
configuration, and debugging.

## Running

```
./launch.sh               # the living portraits, full-screen on the Portrait
./launch.sh first-light   # calibration test scene
./launch.sh stop          # close everything and hand the voice back to the browsers
```

`launch.sh` finds the Portrait as the display running 1536x2048, starts `server.py` on
127.0.0.1:8765, starts `tower_ears.py` if its venv exists, and opens a Chrome kiosk window on the
Portrait with its own profile. Environment:

| Variable | Default | |
|---|---|---|
| `CHOOM_URL` | `http://donnys-mac-studio-3.local:3000` | the Choom app |
| `HOLOGRAM_EARS` | `1` | `0` leaves the tower's microphone off |
| `HOLOGRAM_EYES` | `1` | `0` leaves the camera off |
| `HOLOGRAM_DISPLAY_WATCHDOG` | `1` | `0` stops the display watchdog |
| `HOLOGRAM_CONFIG` | `~/.config/choom-hologram` | Home Assistant files (below) |

Keys on the page: arrow keys or 1-4 switch Choom, hold L = listening, M = mute, `-`/`=` depth,
`[`/`]` calibration center, H = readout.

## Rendering

`lenticular.js` draws 48 views (an 8x6 quilt, 3360x3360) from an off-axis camera rig and interleaves
them with the Portrait's factory calibration (`calibration/`, copied from the Portrait's USB drive), so
Looking Glass Bridge is not needed. `living.js` is the page: each Choom is an RGB-D relief (her color,
per-pixel depth and cut-out), with idle sway and breathing, her own particles (Aloy's embers and her
atom of sister orbs, Optic's scan band, Genesis's motes, Eve's code band), and her name for a few
seconds after she takes the glass.

## Moving reliefs

Each Choom is a set of short clips made from her own render, every clip starting and ending on the
same picture of her, so the page can play them in any order without a visible seam.

1. **Clean picture.** Her render cleaned up on black with a Flux.2 Klein edit (Wan2GP
   `flux2_klein_9b`, `video_prompt_type` `KI`, the render as `image_refs`, 1440x1920, 4 steps).
2. **Clips.** A Wan2GP queue zip (`queue.json` of tasks with `model_type` `minimax_h3_fl2va_pdd`,
   `image_prompt_type` `SE`, the clean picture as `image_start` and `image_end`, 832x1104, 124 to 243
   frames), run headless with `wgp.py --process QUEUE.zip --output-dir DIR`. About 5 minutes a clip.
   Name each clip `<id>_<action>.mp4`. In prompts, never name an effect you don't want ("no smoke"
   brings smoke); say "a plain pure black background". Seven-second sleep loops come out cleaner than
   ten-second ones.
3. **Cut-outs.** `U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python tools/make_alive_masks.py <id> CLIP.mp4 ...`
   (U2-Net per frame, kept per clip as `alive_masks_<clip>.npz`). U2-Net can lose most of her for a
   stretch when something busy moves around her (blowing hair); `make_alive.py` adds back anything
   lit inside her first frame's outline, since every clip starts on her picture.
4. **Reliefs.** `~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive.py <id> MAIN.mp4 CLIP.mp4 ...`
   (main clip first): Depth Anything V2 Large per frame (fused attention, half precision, about 0.2 s a
   frame; raw depth cached per clip as `alive_depth_<clip>.npy`), lined up with the main clip and
   normalized across all of them, smoothed in time, shaped for the panel, plus MediaPipe mouth tracking
   per frame. It writes `portraits/<id>/alive_<k>.mp4` (color, depth and cut-out stacked) and
   `alive.json`. Don't run it while a Wan2GP queue renders: sharing the GPU slows it more than tenfold.

The clip videos and caches stay local (`.gitignore`); without them a Choom shows her still relief.

**Roles.** A clip's action name gives its moods and the pose it starts and ends in (`ROLES` in
`tools/make_alive.py`). The page picks clips by what she is doing:

| Mood | Examples | When |
|---|---|---|
| idle | base, glance, breath, hum, daydream, giggle, groove | quiet moments, shuffled |
| talk, think, listen | base, listen, thinkup, longcalm | while she talks, writes, or hears you |
| happy, surprised, sad, concerned | happy, sad | once, when what you said (or, after she finishes, what she said) feels that way |
| greet | wave | taking the glass after a while away |
| sleep, wake, yawn | fallasleep, sleep2, wake, yawn | 11 pm to 7 am after ten quiet minutes; yawns near bedtime |
| windy | windy | Genesis, on windy days |
| pose | relaxedturn, poseheart, fulltwirl | a selfie she just made |

Poses: `main` (her picture), `relaxed` (Aloy with her hand down, reached by `lower`/`raise`),
`asleep`, and `full` (full-body clips made from a full-body picture built from her reference sheet;
reached and left with a quick camera-cut fade, no lip sync).

## Lip sync

HeadAudio (`vendor/headaudio`, MIT) reads mouth shapes from her voice in an audio worklet; loudness
leads the onsets. A shader opens her jaw along a lens that follows her lip line, rounds or spreads
her lips and fills the opening with a mouth tinted from her own lips, at the mouth tracked on that
frame of the clip. Her audio is delayed 80 ms so voice and lips line up. Every spoken piece logs a
`lipsync` entry (lag and correlation against the voice heard) to `telemetry.log`.

## The Choom app link

| Choom app route | Used for |
|---|---|
| `GET /api/hologram/events` | the live feed: turns, thinking, tools (with the sister when Aloy delegates), pictures, speakable sentences |
| `POST /api/hologram/voice` | heartbeat while the hologram speaks, so browsers at home stay quiet |
| `POST /api/hologram/listening` | typing or the mic in the app at home |
| `POST /api/hologram/talk` | words heard at the tower, into her chat or the group room |
| `POST /api/stt`, `/api/tts` | speech to text, and her voice |
| `GET /api/images/<id>` | a picture to float in the glass (served to the page as `/choom-image/<id>`) |

She speaks only a conversation a browser at home has open (the app marks each sentence `speak`),
and the app's mute button stops her.

## Talking at the tower

`tower_ears.py` (run with `.venv-ears`) records the speakerphone's microphone through PipeWire,
finds speech with WebRTC VAD (or anything clearly louder than the room's tracked background), and
checks how each utterance begins with faster-whisper small.en on the GPU. Only a wake phrase at the
start counts:

| Say | Goes to |
|---|---|
| OK Aloy, OK Optic, OK Genesis, OK Eve | her current 1:1 chat (picked as Signal picks it) |
| OK Chooms, OK girls, OK everyone | the room set as the Signal room on the Rooms page, or else the room you last spoke in |

A sentence ends when 90% of the last 1.6 s was quiet; a message can run 45 s. After her answer the
mic stays open six seconds for a reply (a room: once everyone has finished). Short sounds and clips
that fail a local speech check are dropped, so Whisper can't turn noise into a sentence. Only the
wake phrase itself interrupts her. Nothing is kept; events go to `telemetry.log` without the words.

Setup: `python3 -m venv .venv-ears && .venv-ears/bin/pip install faster-whisper==1.2.1 ctranslate2==4.8.2 webrtcvad-wheels`.
Keep the microphone's input level up (`wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 1.0`).

## Eye contact

`tower_eyes.py` (same venv; started by `launch.sh`, `HOLOGRAM_EYES=0` to leave it off) watches a USB
camera mounted at the Portrait's top edge, found by name (a Logitech Brio first; virtual cameras are
skipped), and waits quietly until one is plugged in. MediaPipe's face landmarker gives his head's
turn and tilt and where his irises sit; turn plus eyes within 15° of straight on, with his usual tilt
(learned while he faces the camera), counts as looking at the glass (after 0.5 s; away after 1.5 s).
While he looks, the Choom keeps to her facing-you clips and leans in a little, sometimes with a smile
as he first looks, and the screensaver waits. Frames are never kept; only changes are sent and logged.
Test on a video: `.venv-ears/bin/python tower_eyes.py --source clip.mp4 --print`. Setup:
`.venv-ears/bin/pip install mediapipe opencv-python-headless`.

## Presence (Home Assistant)

`server.py` checks Home Assistant every 5 seconds once these files exist in `~/.config/choom-hologram`
(no restart needed; they stay out of git):

- `ha_url`: e.g. `http://homeassistant.local:8123`
- `ha_token`: a long-lived access token (HA profile, Security tab), `chmod 600`
- `presence.json` (optional): roles to entities, each an entity id (present when it reads home, on,
  detected or occupied) or `{"entity": ..., "equals": ...}`:

```json
{"home": {"entity": "sensor.phone_wi_fi_connection", "equals": "Home WiFi"},
 "desk": "binary_sensor.desk_zone", "bed": "binary_sensor.bed_zone"}
```

Coming home or sitting at the desk wakes the Choom on the glass and she greets you; getting into bed
puts the glass to sleep at any hour, getting up wakes it. Leaving counts only after two minutes away.

## Everything else on the page

- **Group stage:** a group-room turn brings all four into the glass, the speaker in front, her
  sisters behind her turned toward her; the turn passes by trading places. It folds back after three
  quiet minutes or a 1:1 chat.
- **Tool moments:** the glass flares and she plays a clip that fits the tool (`TOOL_LOOKS`): looking
  around for a camera or picture, daydreaming for a memory search, a look at the sky for the weather.
- **Pictures:** a picture she makes or analyzes floats beside her face for about ten seconds.
- **Screensaver:** after two quiet minutes, a random Choom takes the glass every 3 to 5 minutes (not
  while she sleeps, on the stage, or when someone is talking near the tower).
- **Weather:** wind brings Genesis's wind clips and drifting dust; rain and snow fall through the glass.
- **Background turns:** heartbeats and delegated tasks that start at night run unseen.

## Portrait buttons and screens

Top = previous Choom, middle = next, hold bottom = listening (also interrupts her). `server.py` claims
the buttons' input device, which needs this udev rule:

```
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{idVendor}=="05df", ATTRS{idProduct}=="16c0", GROUP="plugdev", MODE="0660"
```

The server wakes GNOME's blanked screens when a Choom starts talking to you, and puts a monitor
back in the layout if GNOME leaves it connected but off after an input switch.

## Debugging

`POST /control` on the server:

| Body | Does |
|---|---|
| `{"choom": "eve"}` | switch Choom |
| `{"view": 24}` / `{"view": false}` | one of the 48 views full screen / back |
| `{"quilt": true}` | the raw quilt |
| `{"clip": 5}` | jump to a clip |
| `{"stage": true}` | the group stage |
| `{"sleep": true}`, `{"hour": 22}` | doze now, pretend it's 10 pm (`null` to stop) |
| `{"weather": {"wind": 25}}` | pretend weather |
| `{"presence": {"bed": true}}` | pretend presence (`null` clears a role) |
| `{"picture": "<image id>"}` | float a gallery picture |
| `{"gaze": true}` | pretend he's looking at the glass |
| `{"mouthStyle": 3}`, `{"jaw": 0.6}` | try a mouth style (0 to 3), hold her mouth open (`null` to let go) |

`POST /simulate` injects a Choom-app event, e.g. `{"event": "tool", "choom": "Genesis", "tool": "get_weather"}`.
`GET /status` shows the page, the feed, weather, presence and the listener's state. `telemetry.log`
(rotated at 50 MB) records clips, lip sync, latency and listener events. `tools/deinterleave.py`
rebuilds views from a screen grab, to check depth without standing in front of the Portrait.

## Still portraits (fallback)

`portraits/` also holds a still relief per Choom, made from the concept renders in `sources/`:

```
U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python tools/make_masks.py
~/pinokio/api/forge-neo/app/venv/bin/python tools/make_depth.py
~/pinokio/api/forge-neo/app/venv/bin/python tools/make_landmarks.py
```

`body.js` can show a rigged 3D avatar instead (`bodies/<id>.glb`, B toggles); it is kept for
experiments, but the moving reliefs are what look like the Chooms.
