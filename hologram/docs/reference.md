# Chooms in Glass: technical reference

The details behind [the README](../README.md): how each part works, how the moving reliefs are made,
configuration, and debugging.

## Running

```
./launch.sh               # the living portraits, full-screen on the Portrait
./launch.sh first-light   # calibration test scene
./launch.sh stop          # close everything and hand the voice back to the browsers
```

At login, `~/.config/autostart/choom-hologram.desktop` runs `launch.sh living` (after 15 s); its
output goes to `autostart.log`. `launch.sh` finds the Portrait as the display running 1536x2048, starts `server.py` on
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
   brings smoke); say "a plain pure black background". Words about breathing ("a deep breath", "a
   sigh") can bring a cloud of fog; describe what her face does instead. Wording that draws the eye to
   her face ("leans in", "studies the viewer closely", "scrunches her nose at the viewer") makes the
   camera push in; end every prompt with "The camera stays locked off, framed exactly as at the start,
   and never zooms or pushes in." Genesis's motes sometimes fade out for a few seconds and come back
   (closing her eyes, a pout); Donny likes that as an occasional moment, so her prompts say the motes
   stay on her, and a few clips ask for the fade on purpose. Five-second clips
   fail less than seven-second "she stands quietly" loops, which drift into new shots, halos or
   colour shifts. Seven-second sleep loops come out cleaner than ten-second ones. About one clip in six
   fails; check every clip on a contact sheet (`idle_sheet.py`: eight frames a row) before using it.
3. **Cut-outs.** `U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python tools/make_alive_masks.py <id> CLIP.mp4 ...`
   (U2-Net per frame, kept per clip as `alive_masks_<clip>.npz`). U2-Net can lose most of her for a
   stretch when something busy moves around her (blowing hair); `make_alive.py` adds back anything
   lit inside her first frame's outline, since every clip starts on her picture. Clips about her
   particles (`motes`, `windy`, `sparkle` in the name) keep everything lit around her too, frame by
   frame, so motes that drift off Genesis aren't clipped away.
4. **Reliefs.** `~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive.py <id> MAIN.mp4 CLIP.mp4 ...`
   (main clip first): Depth Anything V2 Large per frame (fused attention, half precision, about 0.2 s a
   frame; raw depth cached per clip as `alive_depth_<clip>.npy` and read from disk as needed, so
   memory stays around 2 GB however many clips she has), lined up with the main clip, normalized to
   the main clip's depth range (kept in `alive.json`), smoothed in time, shaped for the panel, plus
   MediaPipe mouth tracking per frame. It writes `portraits/<id>/alive_<clip>.mp4` (color, depth and
   cut-out stacked) and `alive.json`, and only encodes clips that are new or changed, so adding clips
   costs only the new ones. After the page reloads, `make_alive.py <id> --prune` deletes videos of
   clips no longer listed. Depth Anything shares the GPU badly with a Wan2GP queue (more than tenfold
   slower), so new clips are built between queues; a rebuild with every depth cached needs no GPU.

The clip videos and caches stay local (`.gitignore`); without them a Choom shows her still relief.

**Glass Studio** (`studio/`, [README](../studio/README.md)) runs these steps from a page at
http://127.0.0.1:8767. It keeps one project file per Choom in the workspace's `studio/` folder (her
looks, every clip with its prompt, seed and status, and her sequence, the list `make_alive.py` is
given). It plans clips from `studio/packs.json` with the prompt lessons above built in
(`studio/prompts.py`), writes Wan2GP queues and renames their outputs by seed, makes each clip's
contact sheet with automatic checks (`studio/review.py`), and builds a sequence: cut-outs, then
`make_alive.py`, then `tools/relaunch_when_quiet.sh`, then `--prune`. Renders and builds take turns
on the GPU. The four Chooms' first 784 clips were adopted with `studio/import_existing.py` from the
old queues and their seed plans.

**Roles.** A clip's action name gives its moods and the pose it starts and ends in (`ROLES` in
`tools/clip_roles.py`, shared by `make_alive.py` and Glass Studio), or its kind prefix does: `idle_…` (a quiet moment), `relaxed_…` (one with
Aloy's hand down), `full_…` (a full-body quiet moment), `pose_…` / `fullpose_…` (selfie moves). An
outfit prefix puts it in other clothes: `evening-relaxed`, `cold-relaxed_glance`. The page picks clips
by what she is doing:

| Mood | Examples | When |
|---|---|---|
| idle | base, glance, breath, hum, daydream, giggle, groove | quiet moments, shuffled |
| talk, think, listen | base, listen, thinkup, longcalm | while she talks, writes, or hears you |
| happy, surprised, sad, concerned | happy, sad | once, when what you said (or, after she finishes, what she said) feels that way |
| oops | oops_wince, relaxedoops_jaw | once, after one of her tools fails or she says it didn't come out right (a wince, a frown at herself, an eye roll at the tool; not her sad face) |
| greet | wave | taking the glass after a while away |
| sleep, wake, yawn | fallasleep, sleep2, wake, yawn | 11 pm to 7 am after ten quiet minutes; yawns near bedtime |
| windy | windy | Genesis, on windy days |
| pose | relaxedturn, poseheart, fulltwirl | a selfie she just made |
| picture, picturedown | picturelook, relaxedpicturedown | a picture floats up: she turns to it beside her, or glances down at one lower right |
| change | fadeout, fadein | an outfit change made on screen (Genesis's motes fading away and back) |

Quiet clips play like a shuffled deck: one that played lately waits until most of the others have had
their turn. As of October 9 each Choom has 135 to 158 clips, about five to six minutes of distinct
quiet moments in her usual clothes before anything repeats, plus her outfits.

Poses: `main` (her picture), `relaxed` (Aloy with her hand down, reached by `lower`/`raise`; her
home pose, the raised finger comes up now and then while she talks), `asleep`, and `full` (full-body
clips made from a full-body picture built from her reference sheet; reached and left with a quick
camera-cut fade, no lip sync). About one quiet clip in fourteen cuts to a full-body one and back.

Outfits: clips in other clothes live in poses of their own (`relaxed@evening`), made from a Klein edit
of her clean picture. The outfit's name says when she wears it (`OUTFIT_RULES` in `living.js`):
`cold…` under 45°F, `hot…` over 85°F, `evening…` from 6 to 11 pm, and `day…` outfits take turns with
her usual clothes, a different one each day. She changes with a camera cut at a quiet moment, and back
into her usual clothes before she sleeps. An outfit needs at least a base loop with the `talk` mood.
So a dozen clips don't loop for hours, she wears an outfit (or another look) in visits: about 30 s per
clip it has (3 to 15 minutes), then at least 25 minutes in her usual clothes, and an outfit for at
most 2 minutes per clip a day. Kept in the kiosk's localStorage across relaunches. While he looks at
her, a look with few listening clips borrows her quiet clips that keep facing forward, and listening
clips shuffle like the quiet ones. Outfit clips keep any lit area touching her outline (U2-Net took
the dark knit of Genesis's sweater for background).
The Chooms aren't told what they're wearing in the glass, so it doesn't steer their selfies.
An outfit change can also happen on screen instead of by a cut: a clip that starts in one look and
ends in the other (Wan2GP's start and end pictures differ) is played for the change. Genesis's plain
look (`main@plain`, no glowing motes) works this way: `fadeout` / `fadein` clips fade her motes away
and back, and in her usual clothes she is plain about a third of the time, decided every 20 minutes.

## Lip sync

HeadAudio (`vendor/headaudio`, MIT) reads mouth shapes from her voice in an audio worklet; loudness
leads the onsets. A shader opens her jaw along a lens that follows her lip line, lifts her upper lip a
little, rounds or spreads her lips, and fills the opening with a mouth tinted from her own lips, at
the mouth tracked on that frame of the clip. Her upper teeth show under the lip whenever she opens
(shaded, with faint gaps between the front teeth, in her own light), the lower ones on wide sounds. Her audio is delayed 80 ms so voice and lips line up. Every spoken piece logs a
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

A message ends when 90% of the last 2.5 s was quiet (the speakerphone sends exact silence in every
pause, and pauses between sentences often pass 1.5 s); it can run 45 s. After her answer the
mic opens for a reply: once her conversation turn has ended and her voice has stopped (a heartbeat
running beside it doesn't hold it up; a room waits until everyone has finished), a soft rising chime
plays and the mic listens for 8 s, with a soft low note if it closes unheard. If any Choom starts
speaking while it's open (her next thought, a sister in the room), the window closes without sending
anything and opens again with a fresh chime once it's quiet, so a Choom's voice is never sent as his. Short sounds and clips
that fail a local speech check are dropped, so Whisper can't turn noise into a sentence. Only the
wake phrase itself interrupts her. Nothing is kept; events go to `telemetry.log` without the words.

Setup: `python3 -m venv .venv-ears && .venv-ears/bin/pip install faster-whisper==1.2.1 ctranslate2==4.8.2 webrtcvad-wheels`.
Keep the microphone's input level up (`wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 1.0`).

## Eye contact

`tower_eyes.py` (same venv; started by `launch.sh`, `HOLOGRAM_EYES=0` to leave it off) watches a USB
camera mounted at the Portrait's top edge, found by name (a Logitech Brio first; virtual cameras are
skipped), and waits quietly until one is plugged in. MediaPipe's face landmarker gives his head's
turn and tilt and where his irises sit; turn plus eyes within 6° of straight on, with his usual tilt
(learned while he faces the camera), counts as looking at the glass (after 0.5 s; away after 1.5 s).
Measured at the desk: on the glass his gaze sits within about 3°, the monitors start 9° and 15° out.
At two feet his face is only a tenth of the Brio's wide frame, too small for MediaPipe (which shrinks
its input to a small square), so the watcher looks at a square crop: around his face once it has
found it, else the middle of the frame and each side in turn.
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

## The glass camera (Settings → Camera)

`tower_eyes.py` also answers on 127.0.0.1:8766: the latest frame as a JPEG (kept in memory only), the
camera's state and adjustments, and its settings, kept in `camera.json` in the config folder and
applied again whenever the camera starts. `camera_controls.py` sets the MX Brio's adjustments through
V4L2 (brightness, contrast, color, sharpness, backlight compensation, exposure, white balance, focus,
zoom, pan, tilt, anti-flicker) and its field of view (65°, 78° or 90°) through Logitech's vendor
control unit. Its light has no control on this model; turning the camera off (`enabled: false`) lets
go of it, which turns the light off and stops eye contact and the welcome back.

The Choom app reaches it without any port opening on the NUC: `lib/glass-camera.ts` sends a
`camera_request` event down the hologram feed, `server.py` asks `tower_eyes.py` and posts the answer
to `/api/hologram/camera/result`. Routes (home only): `GET /api/hologram/camera` (state),
`POST /api/hologram/camera` (settings, `{controls: {...}}`, `{reset_controls: true}`),
`GET /api/hologram/camera/frame?overlay=1` (the preview; the overlay marks his face, green while he's
looking at the glass). The Chooms ask for the `"glass"` camera with `ha_get_camera_snapshot`; it's
saved and shown like their Home Assistant camera snapshots, and refused when the Camera tab's
"Chooms can look through this camera" is off. Settings also hold eye contact on or off, how wide
counts as looking (`yaw_limit`), and the welcome back's switch and minutes (read by `server.py`).

## Welcome back

When Donny sits back down after 20 minutes or more away, the Choom he last talked with one to one
welcomes him back. `server.py` counts him at the desk while the camera sees his face, or the NUC's
keyboard or mouse was used in the last 30 seconds (GNOME's idle time) and the camera saw him in the
last 5 minutes: GNOME also resets its idle time when the screens wake or the monitor layout is
reapplied, which faked his return while he was out. On his return it asks the
Choom app's `POST /api/hologram/welcome {awayMinutes, place?}`. The app picks his most recent genuine
conversation (`lastUserMessageAt`, skipped if older than 12 hours) and runs her turn there with a note
(`note: true` on `/api/chat`): saved as a system message the chat window doesn't show, never counted
as his words. She knows from their conversation where he went ("how did the shop check go?"). Not at
night (11 pm to 7 am), at most every two hours, not while he's already talking, not in bed. A Home
Assistant role he was in while away (a shop or truck sensor) is passed on as `place`. Every leaving
and coming back is logged as `desk` in `telemetry.log`; `HOLOGRAM_WELCOME_AFTER_S` changes the 20
minutes (for testing); `POST /control {"welcomeTest": 30}` sends one now. After her welcome, the
tower's mic opens its reply window for her (`tower_ears.py` watches `/status` for it), so he
can answer without "OK" and her name.

## Everything else on the page

- **Group stage:** a group-room turn brings all four into the glass, the speaker in front (always the
  one on the glass, drawn over her sisters); while the room is talking, a Choom's 1:1 reply comes to
  the front of the stage instead of folding it away. Her
  sisters behind her turned toward her; the turn passes by trading places. It folds back after three
  quiet minutes or a 1:1 chat.
- **Tool moments:** the glass flares and she plays a clip that fits the tool (`TOOL_LOOKS`): looking
  around for a camera or picture, daydreaming for a memory search, a look at the sky for the weather.
- **Pictures:** a picture she makes or analyzes floats beside her face for about ten seconds.
- **Screensaver:** after two quiet minutes, a random Choom takes the glass every 3 to 5 minutes (not
  while she sleeps, on the stage, or when someone is talking near the tower).
- **Weather:** wind brings Genesis's wind clips and drifting dust; rain and snow fall through the glass.
  Windy means a 10-minute average of 12 mph or gusts of 20, read every 2 minutes from Donny's own
  weather station when `weather.json` in the config folder maps `wind`, `gust` and `temperature` to
  Home Assistant sensors (OpenWeather's town readings ran low and never reported gusts).
- **Background turns:** heartbeats and delegated tasks that start at night run unseen, and so does a
  heartbeat that starts during a conversation (the stage is up, someone is talking, or a chat in the
  last three minutes), so it doesn't take the front or float its pictures in the middle of it.

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
