# Chooms in Glass: technical reference

The details behind [the README](../README.md): how each part works, how the moving reliefs are made,
configuration, the Choom app link, and debugging. Constants named here live in the file mentioned
next to them; the code is the source of truth.

## Running

```
./launch.sh               # the living portraits, full-screen on the Portrait
./launch.sh first-light   # calibration test scene
./launch.sh stop          # close everything and hand the voice back to the browsers
```

`launch.sh` takes these steps in order:
1. Resolves its real folder, so starting it through a symlink still stops the right processes.
2. Closes any file descriptors it was given beyond stdin, stdout and stderr, so the processes it
   starts don't hold a caller's lock (a `flock` around a relaunch would otherwise stay held by the
   server and Chrome, and every later relaunch would wait for it).
3. Finds the Portrait as the connected display running 1536x2048.
4. Stops anything left from a previous launch.
5. Starts `server.py` on 127.0.0.1:8765.
6. Starts `tower_ears.py` and `tower_eyes.py` if `.venv-ears` exists.
7. Starts Glass Studio on 127.0.0.1:8767 if it isn't already running. A relaunch leaves the Studio
   running, so a render it started keeps its watcher.
8. Opens a Chrome kiosk window on the Portrait with its own profile (`.chrome-profile`).
9. Hands the keyboard back to the window that had it (`tools/focus_back.py`), because the kiosk
   takes focus when it opens.

To start at login, add an autostart entry, `~/.config/autostart/choom-hologram.desktop`, with
`Exec=/bin/bash -c "sleep 15; <path>/hologram/tools/autostart.sh"`. `tools/autostart.sh` tries every
10 s for up to 10 minutes until the Portrait is connected at 1536x2048 (after a boot it can come up
after the desktop does, and `launch.sh` gives up at once without it), and does nothing when the glass
is already running. It appends to `autostart.log`.

To reload the page without cutting anyone off, use `tools/relaunch_when_quiet.sh`. It waits (up to
10 minutes) until the page reports her idle with nothing queued to say and no conversation at the
tower is under way (it waits through his reply window too), relaunches, then waits for the new page
to report in. Glass Studio's build uses it. Exit codes:

| Code | Meaning |
|---|---|
| `0` | relaunched: the new page reported in |
| `1` | still busy after 10 minutes; not relaunched |
| `2` | the launch failed: `launch.sh` failed (no Portrait at 1536x2048, say) or no new page within 40 s |

Two relaunches at the same moment can leave duplicate processes. When several scripts or tools may
relaunch, wrap each in the same lock, e.g. `flock /tmp/glass-relaunch.lock tools/relaunch_when_quiet.sh`;
`launch.sh` lets go of the lock it was handed (step 2), so it is free again as soon as the relaunch ends.

**Recovery.** The server watches the rest:
- **The page:** it posts its status every 2 s, also with the screens dark. If none comes for a minute
  (Chrome crashed, the page froze), the server relaunches everything with `launch.sh`. Not in the
  first 2 minutes after a launch, not while `launch.sh` runs, and at most once every 10 minutes.
  Only the living page is watched.
- **The tower's helpers:** exactly one `tower_ears.py` and one `tower_eyes.py`. A dead one is started
  again (its log appended), up to 3 times in 10 minutes, then left down; a second one is stopped (the
  newer).
- Each recovery is a line in `recovery.log` and a `recovery` entry in `telemetry.log`.

| Variable | Default | |
|---|---|---|
| `CHOOM_URL` | `http://donnys-mac-studio-3.local:3000` | the Choom app |
| `HOLOGRAM_EARS` | `1` | `0` leaves the tower's microphone off |
| `HOLOGRAM_EYES` | `1` | `0` leaves the camera off |
| `HOLOGRAM_STUDIO` | `1` | `0` doesn't start Glass Studio |
| `HOLOGRAM_DISPLAY_WATCHDOG` | `1` | `0` stops the display watchdog |
| `HOLOGRAM_CONFIG` | `~/.config/choom-hologram` | the configuration folder (below) |
| `HOLOGRAM_URL` | `http://127.0.0.1:8765` | where `tower_ears.py` and `tower_eyes.py` find the server |
| `HOLOGRAM_WELCOME_AFTER_S` | from the Camera tab (20 min) | minutes away before a welcome back, in seconds (for testing) |
| `HOLOGRAM_CALIBRATION` | the one `calibration/*_visual.json` | the calibration file, if `calibration/` holds several |
| `HOLOGRAM_OWNER` | `donny` | the Home Assistant person found by name when `presence.json` doesn't say ([Presence](#presence-home-assistant)) |

**Configuration folder** (`~/.config/choom-hologram/`, kept out of git). The server picks up its
files without a restart.

| File | Read by | Contents |
|---|---|---|
| `ha_url`, `ha_token` | server.py | Home Assistant's URL and a long-lived access token (`chmod 600`) |
| `presence.json` | server.py | presence roles to entities ([Presence](#presence-home-assistant)) |
| `weather.json` | server.py | weather station sensors ([Weather](#weather)) |
| `camera.json` | tower_eyes.py, server.py | camera settings from the Choom app's Camera tab ([The glass camera](#the-glass-camera)) |
| `studio.json` | Glass Studio | the workspace folder and the Studio's settings, such as the morning summary ([studio/README.md](../studio/README.md#setup)) |

**Logs** (in `hologram/`): `server.log`, `ears.log`, `eyes.log`, `chrome.log` and `studio/studio.log`
are appended on every launch (each starts with a `== <time> launch ==` line) and rotated past 5 MB
with one old copy (`.1`), so a crash's traceback survives the next relaunch. `telemetry.log` is
rotated at 50 MB (see [Debugging](#debugging)); `recovery.log` and `autostart.log` are appended.

## Keyboard

The glass page's keys:

| Key | Does |
|---|---|
| ← → or 1–9 | switch Choom |
| hold L | listening |
| H | the readout (fps, clip, depth, calibration, PAUSED) |
| Space | pause the particles, bands and orbs* |
| M | mute her voice* |
| B | toggle the experimental 3D body* |
| `-` / `=` | depth* |
| `[` / `]` (Shift for fine steps) | calibration center* |

\* These keys stay in effect until pressed again, so they work only while the readout (H) is up:
a stray key typed for another window can't freeze the glass. Every key press is logged as `tuning`,
and status entries carry `paused`.

## Rendering

`lenticular.js` draws 48 views (an 8x6 quilt, 3360x3360, each view rendered with 4x MSAA) from an
off-axis camera rig. It interleaves them with the Portrait's factory calibration (`calibration/`), so
Looking Glass Bridge is not needed. `living.js` is the page. It renders at 30 frames a second: the
clips are 24 fps, and 60 kept two CPU cores busy for no visible gain.

Each Choom is an RGB-D relief (her colour, per-pixel depth and cut-out) with her own particles:
- Aloy: embers, and an atom of four orbs in her sisters' colours and her own.
- Optic: a scan band.
- Genesis: twinkling motes.
- Eve: a compile band and code.

Her name shows for a few seconds after she takes the glass.

## Moving reliefs

Each Choom is a set of short clips made from her own render. Every clip starts and ends on the same
picture of her, so the page can play them in any order without a visible seam. Glass Studio runs this
whole pipeline. The steps underneath:

1. **Clean picture.** Her render, cleaned up onto black with a Flux.2 Klein edit (Wan2GP
   `flux2_klein_9b`, `video_prompt_type` `KI`, the render as `image_refs`, 1440x1920, 4 steps).
2. **Clips.** A Wan2GP queue zip, run headless with `wgp.py --process QUEUE.zip --output-dir DIR`
   (about 5 minutes a clip).
   - Each task in its `queue.json`: `model_type` `minimax_h3_fl2va_pdd`, `image_prompt_type` `SE`,
     the clean picture as both `image_start` and `image_end`, 832x1104, 5 to 15 seconds long.
   - Clips are named `<id>_[<outfit>-]<action>.mp4`.
3. **Cut-outs.** U2-Net, per frame:
   ```bash
   U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python \
     tools/make_alive_masks.py <id> CLIP.mp4 ...
   ```
   - Masks are kept per clip as `alive_masks_<clip>.npz`.
   - U2-Net can lose most of her for a stretch when something busy moves around her (blowing hair).
     `make_alive.py` adds back anything lit inside her first frame's outline, because every clip
     starts on her picture.
   - Clips about her particles (`motes`, `windy`, `sparkle` in the name) keep everything lit around
     her, frame by frame.
   - Outfit clips keep any lit area that touches her outline, because U2-Net can take dark knitwear
     for background.
4. **Reliefs.** The main clip comes first:
   ```bash
   ~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive.py <id> MAIN.mp4 CLIP.mp4 ...
   ```
   For each frame:
   - Depth Anything V2 Large depth (fused attention, half precision, about 0.2 s a frame). Raw depth
     is cached per clip as `alive_depth_<clip>.npy` and read from disk as needed, so memory stays
     around 2 GB whatever the clip count.
   - The depth is lined up with the main clip and normalized to the main clip's depth range, which
     is kept in `alive.json`.
   - It is then smoothed in time and shaped for the panel.
   - MediaPipe tracks her mouth.

   It writes `portraits/<id>/alive_<clip>.mp4` (colour, depth and cut-out stacked) and `alive.json`.
   It encodes only clips that are new or changed; a re-encoded clip gets a new name
   (`alive_<clip>_v2.mp4`), so the running page never plays a new take with the old take's mouth track.
   Caches and videos are written to a `.part` file and swapped in, so a stopped build can't leave a
   cut-short file behind. After the page reloads, `make_alive.py <id> --prune` deletes videos of clips
   no longer listed, their depth and mask caches, and leftover `.part` files. `tools/make_alive_depth.py`
   caches depth alone, so `make_alive.py` can then run on the CPU beside a render.

**The campfire circle's fire** is built the same way, outside the Studio (it isn't a Choom):
1. Its picture: Klein, from Genesis's campfire picture, "Remove the woman completely, so only the small
   campfire is left ... a small ring of rounded grey stones around it" (kept in the workspace as
   `props/fire_pick.png`).
2. Its loop: one Wan2GP task from the Studio's template (`studio/templates/h3_task.json`) with that
   picture as start and end, 124 frames: the flames flicker, the embers pulse, a few sparks rise, the
   logs and stones stay put (`props/fire.mp4` in the workspace).
3. `~/pinokio/api/forge-neo/app/venv/bin/python tools/make_fire.py FIRE.mp4` crops the panel to
   everything the fire lights, takes the depth once from the clip's median frame (the flames take the
   depth of the wood under them, so the fire's shape doesn't wobble) and writes `props/fire.mp4`
   (colour, depth, a matte that follows the light) and `props/fire.json`. The glass reads them at start.

**Two processes on one GPU.**
- Depth Anything shares the GPU badly with a Wan2GP queue (more than tenfold slower), so builds
  wait for renders. A rebuild with every depth cached needs no GPU.
- Never pause a running Wan2GP queue with SIGSTOP: the queue dies.

**Prompt lessons.** These are built into the Studio's prompts (`studio/prompts.py`):
- Never name an effect you don't want ("no smoke" brings smoke). Say "a plain pure black background".
- Words about breathing ("a deep breath", "a sigh") can bring fog; describe what her face does instead.
- Wording that draws the eye to her face ("leans in", "studies the viewer closely") makes the camera
  push in. Every prompt ends with "The camera stays locked off, framed exactly as at the start, and
  never zooms or pushes in."
- Genesis's motes can fade out for a few seconds and come back. Her prompts say the motes stay on her,
  and a few clips ask for the fade on purpose.
- Five-second clips fail less often than seven-second "she stands quietly" loops, which drift into
  new shots, halos or colour shifts. For sleep loops, seven seconds is cleaner than ten.
- About one clip in six fails. Check every clip on its contact sheet before it goes on the glass.

The clip videos and caches stay local (`.gitignore`). Without them a Choom shows her still relief.

**Glass Studio** (`studio/`, [README](../studio/README.md)) runs all of this from a page at
http://127.0.0.1:8767, or from `studio/studio.py` on the command line.
- It keeps one project file per Choom in the workspace's `studio/` folder: her looks, every clip
  (prompt, seed, status) and her sequence, which is the list `make_alive.py` is given.
- It plans clips from `studio/packs.json` and writes the Wan2GP queues.
- It renames finished renders by seed and makes contact sheets with automatic checks
  (`studio/review.py`).
- It builds in order: cut-outs, `make_alive.py`, then a relaunch at a quiet moment (retried until the
  glass is quiet; a busy glass doesn't fail the build), and `--prune` only after the relaunch.
- Renders and builds take turns on the GPU; builds can be scheduled for a time or after a render.

## Clips, moods and poses

A clip's name gives the moods it plays in and the pose it starts and ends in (`tools/clip_roles.py`,
shared by `make_alive.py` and the Studio). Named actions are listed in `ROLES`. Other clips are
named by kind, `<kind>_<what she does>` (`KINDS`):

| Kind | Moods | Pose |
|---|---|---|
| `idle_…` | a quiet moment | main |
| `listen_…` | quiet, listening | main |
| `talk_…` | a calm loop to talk over (lip sync), also listening and quiet | main |
| `relaxed_…`, `relaxedtalk_…`, `relaxedlisten_…`, `relaxedpose_…`, `relaxedoops_…`, `relaxedwindy_…` | the same, with Aloy's hand down | relaxed |
| `full_…` | a full-body quiet moment | full |
| `pose_…`, `fullpose_…` | a "look at me" move (selfies, asked-for moves; dances and turns are `fullpose_`) | main, full |
| `oops_…` | a face at her own mishap | main |
| `windy_…` | hair and clothes in the wind | main |
| `[<from>-]change_<to>_<what>` | a change of clothes on screen (`usual` for her usual clothes) | from one look to another |
| `<place>`, `<place>_…`, `<place>listen` | at one of her places: her loop there (she can talk in it), quiet moments, listening | the place |
| `to_<place>[_…]`, `from_<place>[_…]` | getting there (sitting down from her full body) and back up (mood `go`) | full to the place, and back |
| `walkoff`, `walkon`, `vanish`, `appear` (`…_<what>`, `…2`) | off the glass and back on (mood `go`) | full or her home pose to `gone`, and back |

An outfit prefix puts any clip in other clothes, in poses of their own:
- `evening-relaxed` plays in `relaxed@evening`.
- `nightcold-fallasleep` plays in `main@nightcold` and ends in `asleep@nightcold`.
- `dayshop-full_sway` plays in `full@dayshop`.

The page picks clips by what she is doing:

| Mood | Examples | When |
|---|---|---|
| idle | base, glance, breath, hum, daydream, giggle, groove | quiet moments, shuffled |
| talk, think, listen | base, listen, thinkup, longcalm | while she talks, waits on her model, or hears you |
| happy, surprised, sad, concerned | happy, sad | once: before she answers, when what you said feels that way; after she finishes, when what she said did (an outfit without them plays its nearest clip) |
| oops | oops_wince, relaxedoops_jaw | once, after one of her tools fails or she says it didn't come out right |
| greet | wave | taking the glass after a long while away |
| sleep, wake, yawn | fallasleep, sleep2, wake, yawn | night (below); yawns near bedtime and after waking |
| windy | windy, windy_breeze, evening-windy_gust | on windy days, now and then while she's quiet, in the look she has on |
| pose | relaxedturn, poseheart, fulltwirl | a selfie she just made, or a move she asked for |
| picture, picturedown | picturelook, relaxedpicturedown | a picture floats up beside her, or lower right |
| change | fadeout, fadein, change_night_slip | a change of looks on screen |

**Shuffling.** Quiet clips play like a shuffled deck: one that played lately waits until most of
the others have had their turn. Each Choom has a few hundred clips across her looks, several minutes
of distinct quiet moments per look; the Studio's tabs count them. While you look at her, a look with
few listening clips borrows her quiet clips that keep facing forward.

**Poses.**

| Pose | What it is |
|---|---|
| `main` | her picture |
| `relaxed` | Aloy with her hand down: her home pose (set per Choom in the Studio, written to `alive.json` as `home`), reached by `lower` and `raise`; the raised finger comes up now and then while she talks |
| `asleep` | asleep |
| `full` | her whole figure, from a full-body picture made from her reference sheet |
| a place (`campfire`) | somewhere she goes and stays a while, framed wide: any look in her Studio project that isn't one of the others and has no outfit; its look's `from` (her full body) is where she gets there from |
| `gone` | the empty glass (a black picture) she walks off into and on from |
| a seat (`circle`, `circleside`) | her seat at the campfire circle, framed wide: `circle` faces you across the fire (a middle seat), `circleside` is turned in toward the middle from the right (an end seat, mirrored at the left end); made like a place, but she's there only while the circle is on |

Full-body clips are reached and left with a quick camera-cut fade, and have no lip sync. About one
quiet clip in fourteen cuts to a full-body clip and back (`FULL_IDLE_CHANCE`).

An outfit can have its own full body (`full@dayshop`, clips named `<id>_dayshop-full_<what>`):
- In that outfit, the glass cuts only to that full body.
- In an outfit without one, the glass never cuts to full body, and a full-body move she asks for
  doesn't play there (her answer says which clothes have it).

**Places.** A place (Genesis's campfire, sitting on the ground by a fire) is reached only when she asks
for it (glass_move "sit by the fire", matched by the place's name and description). She changes into
her usual clothes first if need be; the glass cuts to her full body and she sits down (`to_campfire`).
There she plays the place's clips, talks over its loop (with lip sync if her face is found in it), and
stays `PLACE_STAY_MS` (`placeMinutes`, 10). Then she gets up (`from_campfire`) and the glass cuts back to
the look she came from; without a `from_` clip it just cuts back. Bedtime, the group stage and a turn
passing to another Choom end the stay sooner, the screensaver leaves her the glass while she's there,
and asking for the place again while she's there makes the stay longer. Her atom and band step aside
there (they're sized for her close-up), no full-body cuts come from there, and clips with the `go` mood
never play by chance. In the build a place keeps everything lit (the fire, not just her outline) and
lines up its depth with its own first frame, like a full body.

**Walking off and on.** On a screensaver turn the one on the glass walks off (from her full body, after
a cut) or vanishes (from her waist-up look), if she has such a clip from where she is. The turn passes
when her clip ends on the empty glass (the fade has nothing left to fade). The next one walks on or
appears if she has a clip from `gone`, then the glass cuts to her home look. Each half works without
the other (a Choom without the clips fades out or in as before), and if she hasn't got off within
30 s, the turn passes with the fade. A turn passing any other way (a
reply, a button) or him talking to her cancels it; back on the glass any other way after walking off,
a Choom is straight back in her home loop, and on the group stage nobody stays gone. The build keeps
only what's lit in these clips (an empty frame stays empty), lines up depth on the frames she's in, and
gives them no lip sync. They're in her usual clothes only.

**The campfire circle.** The group stage becomes a campfire circle (`circleWanted`) when it's after dark
(`circleFrom`, 7 pm, until `morningFrom`) or one of them asked for the fire in the last hour, and every
Choom in the room has a seat loop. The room sits in an open arc on the far side of the fire, left to right
in `circleOrder` (Aloy, Eve, Optic, Genesis, as in the photo of their camping trip):
- **Seats** (`CIRCLE_SEATS`, 2 to 4): the ends nearer and turned in (`circleside`, mirrored on the left
  half by the shader's `flip`), the middle seats further back and facing you (`circle`); each falls back
  to the other look if she has only one.
- **The fire** is the glass's own, not in anyone's clips: a looping clip of a campfire like the one at
  Genesis's place (split logs over embers in a small ring of stones), built into a relief like the
  Chooms' clips (`props/fire.mp4` and `props/fire.json`, by `tools/make_fire.py`; the video stays on
  the NUC) and added to what's behind it, so its flame tips fade into the dark. It sits in front of
  everyone's boots (`FIRE_AT`, low on the glass and nearer you; at its old height an end seat looked as
  if she sat on its edge). Without the clip the glass draws flames instead: three crossed planes of
  rising noise (`FLAME_FRAG`). Either way a soft pool of light and sparks. Everyone's light flickers with it
  (`circle.flicker`), the one talking a little brighter. The glass's own particles fade out around
  the fire (its sparks take over), and seats get no mote shimmer: by the fire they're realistic,
  at Donny's wish, with natural skin in every seat picture (Genesis without her motes, Optic without her
  cyan outline or her heart).
- **The turn passing:** nobody moves seats. Her sisters play their listening clips turned her way (a
  facing seat has `listen_left` and `listen_right`), and the circle drifts a little toward her (`circle.pan`,
  `CIRCLE_PAN`; the end seats sit in far enough that the far end stays on the glass).
  Around the fire there's real depth: the speaker isn't drawn over her sisters as on the standing stage.
- **Going in and out** is a camera cut (`circleSet`): everyone fades, sits down (or gets up) and fades
  back in. A Choom joining the room gets a seat; one without seat clips ends the circle (back to the
  standing stage). The stage folding away ends it too.
- **Asked for:** glass_move with the fire and a group word ("let's all sit around the fire",
  `closet.wants_circle`). In a room it starts the circle; outside one she goes to her own campfire if
  she has one.

Seat clips: `<seat>` (her loop; she talks over it with lip sync), `<seat>listen` (turned toward the
middle), `<seat>listen_left` / `listen_right` (a facing seat), and moments `<seat>_<what>`: quiet
ones (a gaze into the fire, a smile, a sip from her mug, warming her hands: one hand lets go of the mug
or notebook and warms palms down over the fire, moving a little, never palms up) and a laugh, which a
sister plays now and then while another is talking, never in a quiet moment (`seatClip`). They never
play outside the circle, and aren't moves to ask for. In their seats Aloy and Eve hold enamel mugs and
Genesis her notebook, as in the photo; Optic sits with her knees drawn up and no heart.

## Looks and outfits

An outfit's name says when she wears it (`OUTFIT_RULES`, `nightOutfit` and `wantedOutfit` in
`living.js`):

| Name starts with | Worn |
|---|---|
| `night…` | from 10 pm to 7 am, all night (no visits). `nightwarm…` at 70°F or warmer, `nightcold…` below; chosen when she puts them on and kept until morning. She also sleeps in them when he's in bed by day, and changes out of them once she's awake again (before Oct 18 a night outfit she was in by day stayed on all day: Eve after a relaunch, Genesis after his nap) |
| `cold…` | under 45°F |
| `hot…` | over 85°F |
| `evening…` | 6 to 11 pm |
| `day…` | takes turns with her usual clothes: one pick a day from the date, held all day (while it rests, she's in her usual clothes, not another day outfit) |
| `plain`, `noheart` | looks in her usual clothes (Genesis without her glow, Optic without her heart): about a third of the time, decided every 20 minutes, changed on screen with clips made for it |

The temperature comes from the weather feed ([Weather](#weather)). An outfit is wearable only if it
has a clip with the `talk` mood.

**Install settings.** The hours, temperatures and visit lengths on this page (sleep 11 pm to 7 am,
night clothes from 10 pm, 70°F for warm night clothes, cold under 45°F, hot over 85°F, evening 6 to 11
pm, visits of 30 s per clip between 3 and 15 minutes, 25 minutes' rest, a daily 2 minutes per clip,
mornings from 5 am for getting up, 10 minutes at a place, the campfire circle from 7 pm and its seat
order) are defaults. Copy `glass-settings.example.json` to `glass-settings.json` beside `living.html`
(gitignored), change what you like and relaunch; anything left out keeps its default.

**Visits.** A dozen clips would loop for hours, so she wears an outfit (or another look) in visits:
- A visit lasts about 30 s per clip the look has, between 3 and 15 minutes.
- A visit goes on until it's up (or its hours or weather end); it isn't swapped mid-way for another
  outfit of the same kind.
- After an outfit's visit she spends at least 25 minutes in her usual clothes (her `plain` or
  `noheart` look counts as usual clothes) before the next outfit.
- Several outfits for the same hours (Eve's three evening outfits) take turns: the one off longest
  comes next.
- Each outfit has a daily total of 2 minutes per clip. Looks in her usual clothes have no daily
  total.
- The wardrobe is kept in the kiosk's localStorage, so a relaunch doesn't reset it.

**Changing.**
- She changes at a quiet moment, with a camera cut. A change clip made for that pair of looks plays
  instead when there is one.
- Change clips play only to change clothes, never to reach an expression or a move.
- Before sleeping she changes back into her usual clothes. She stays in her night clothes instead
  when they have their own asleep look (`asleep@nightcold`, with sleep and wake clips such as
  `<id>_nightcold-fallasleep`).

**Her own choice.** Clothes she chooses herself (`glass_wear`, below) take priority over these rules,
the day outfit included, until she goes to sleep, until she chooses again, or at most until midnight.
Day clothes chosen before night-clothes time (`nightClothesFrom`, 10 pm) come off then for her night
clothes; whatever she chooses after it stays on. Night clothes she chose stay on to sleep in when
they have an asleep look.

Neither the Choom app's prompts nor the glass ever tell the Chooms what they are wearing at a given
moment, so it doesn't steer the selfies they make. They can ask what is in their closet.

## Lip sync

HeadAudio (`vendor/headaudio`, MIT) reads mouth shapes from her voice in an audio worklet, and
loudness leads the onsets. A shader works on the mouth tracked on that frame of the clip:
- It opens her jaw along a lens that follows her lip line, lifts her upper lip a little, and rounds
  or spreads her lips.
- It fills the opening with a mouth tinted from her own lips. Her upper teeth show under the lip
  whenever she opens; the lower teeth show on wide sounds.

Her audio is delayed 80 ms so voice and lips line up. Every spoken piece logs a `lipsync` entry (lag
and correlation against the voice heard) to `telemetry.log`.

## The Choom app link

| Choom app route | Used for |
|---|---|
| `GET /api/hologram/events` | the live feed: turns, thinking, tools (with the sister when Aloy delegates), failed tools, pictures, speakable sentences, room members, camera and glass requests; a new subscriber gets the app's mute first when it's muted |
| `POST /api/hologram/voice` | heartbeat every 10 s while the hologram speaks, so browsers at home stay quiet |
| `POST /api/hologram/listening` | typing or the mic in the app at home |
| `POST /api/hologram/talk` | words heard at the tower, into her chat (`{choom, text}`) or the group room (`{room: true, text}`) |
| `POST /api/hologram/welcome` | a welcome back (`{awayMinutes, place?}`), and `{done: true}` when it's over |
| `POST /api/hologram/camera/result` | the hologram's answer to a camera request |
| `POST /api/hologram/glass/result` | the hologram's answer to a Choom's glass request |
| `POST /api/stt`, `/api/tts` | speech to text, and her voice |
| `GET /api/images/<id>` | a picture to float in the glass (served to the page as `/choom-image/<id>`) |
| `GET /api/weather` | the town weather report |

She speaks only a conversation a browser at home has open (the app marks each sentence `speak`), and
the app's mute button stops her. Routes that act at home refuse requests from away (ngrok or a public
address).

## Talking at the tower

`tower_ears.py` (run with `.venv-ears`):
1. Records the speakerphone's microphone through PipeWire (16 kHz).
2. Finds speech with WebRTC VAD, or anything clearly louder than the room's tracked background.
3. Checks how each utterance begins with faster-whisper small.en on the GPU.

Only a wake phrase at the start counts ("OK" or "hey" plus a name):

| Say | Goes to |
|---|---|
| OK Aloy, OK Optic, OK Genesis, OK Eve | her current 1:1 chat (picked as Signal picks it) |
| OK Chooms, OK girls | the room set as the Signal room on the Rooms page, or else the room you last spoke in |

"OK everyone" doesn't call the room: "Okay, everyone..." on a call or a video near the tower would
send the rest of the sentence there. A Choom added later through Glass Studio wakes by her name, or by
the spellings in her `portraits/manifest.json` entry's `wake` (a regular expression).

**Messages.**
- A bare wake phrase waits 8 s for the words.
- A message ends when 90% of the last 2.5 s was quiet. The speakerphone sends exact silence in every
  pause, and pauses between sentences often pass 1.5 s.
- A message can run 45 s.
- Short sounds are dropped before Whisper, counted in voiced frames (each capture also carries
  300 ms before it and the quiet that ended it): under 0.2 s of voice anywhere, under 0.3 s in a reply
  window (a cough, a knock; "yes" is about 0.4 s). Audio that fails a local speech check is dropped
  too, so Whisper can't turn noise into a sentence. `ears` entries in `telemetry.log` carry `seconds`
  and `voiced`; a sound dropped as too short in a window is an `ignored` entry, so you can see what a
  cough or a knock measured.

**The reply window.** After her answer the mic opens for your reply:
- It opens once her conversation turn has ended and her voice has stopped. A heartbeat running beside
  it doesn't hold it up; a room waits until everyone has finished.
- A soft rising chime plays and the mic listens for 8 s, with a soft low note if it closes unheard.
- If any Choom starts speaking while it's open, the window closes without sending anything, and opens
  again with a fresh chime once it's quiet. A Choom's voice is never sent as yours.
- Only the wake phrase itself interrupts her.
- While a conversation at the tower is under way (from the wake phrase to the reply window closing),
  `/status` shows `tower_conversation: {"open": true}` and `relaunch_when_quiet.sh` waits for it.

Nothing is kept; events go to `telemetry.log` without the words. Keep the microphone's input level up
(`wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 1.0`). `launch.sh stop` also ends the listener's
`pw-record`, because an orphaned recorder can wedge PipeWire capture for every app (fix:
`systemctl --user restart wireplumber pipewire pipewire-pulse`).

**A wedged microphone.** A mic that sends nothing at all is logged as `mic stalled: no audio for 5 s`,
and the recorder restarts. The USB device itself can wedge too: PipeWire's journal repeats
`spa.alsa: front:3c: impossible timeout`, and every app's mic, the browser's included, records
nothing until it's unplugged. After 30 s with nothing, while no Choom is speaking, `tower_ears.py`
resets the default mic's USB device, the same as a replug, at most once every 10 minutes (an
`ears` `mic_reset` entry). That needs write access to the device, given once by a udev rule:

```bash
sudo cp ~/projects/Choom-portrait/hologram/tools/udev/70-choom-mic-reset.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=usb --attr-match=idVendor=328f
```

The rule is for the EMEET (`328f:007d`); for another USB mic, put its ID from `lsusb` in the rule.
Without it the reset is logged as `no permission` and the mic waits for a replug.

## Eye contact

`tower_eyes.py` (same venv; started by `launch.sh`, `HOLOGRAM_EYES=0` to leave it off) watches a USB
camera at the Portrait's top edge, found by name (a Logitech Brio first; virtual cameras are skipped).
It waits quietly until one is plugged in.

**Gaze.**
- MediaPipe's face landmarker gives the head's turn and tilt and where the irises sit.
- Turn plus eyes within `yaw_limit` of straight on (6° by default), with the usual head tilt (learned
  while you face the camera), counts as looking at the glass.
- It takes 0.5 s of looking to count, and 1.5 s of looking away.
- On a desk with the camera on the glass, gaze at the glass sits within about 3° and neighbouring
  monitors start around 9°. Widen or narrow `yaw_limit` in the Camera tab to fit your desk.

**Small faces.** At two feet a face is about a tenth of the Brio's wide frame, too small for MediaPipe,
which shrinks its input to a small square. So the watcher looks at a square crop: around the face once
it has found it, otherwise the middle of the frame and each side in turn.

**Arrivals.** When nobody has been seen for a minute, a face counts only after it has stayed 1.5 s
(`FACE_AFTER`), so a lone flash of a face wakes nothing. A face back within a minute counts at once.
The face is gone after 3 s without one.

While you look at her, the Choom keeps to her facing-you clips and leans in a little, and the
screensaver waits. Frames are never written anywhere. `tower_eyes.py` sends its state (looking, face,
camera) to the server on each change and every 30 s, so a lost message or a server restarted on its
own can't leave the server sure he's at the desk; the server passes on and logs only changes, and a
page that has just started gets the current state at once.

Test on a video: `.venv-ears/bin/python tower_eyes.py --source clip.mp4 --print`.

## The glass camera

`tower_eyes.py` also answers on 127.0.0.1:8766:
- the latest frame as a JPEG (kept in memory only);
- the camera's state and adjustments;
- its settings (`camera.json`), applied again whenever the camera starts.

`camera_controls.py` sets the MX Brio's adjustments through V4L2: brightness, contrast, colour,
sharpness, backlight compensation, exposure, white balance, focus, zoom, pan, tilt and anti-flicker.
It sets the field of view (65°, 78° or 90°) through Logitech's vendor control unit. The light has no
control on this model. Turning the camera off (`enabled: false`) releases it: the light goes out, and
eye contact and the welcome back stop.

**From the Choom app.** No port opens on the NUC:
1. `lib/glass-camera.ts` sends a `camera_request` event down the hologram feed.
2. `server.py` asks `tower_eyes.py`.
3. The server posts the answer to `/api/hologram/camera/result`.

Routes (home only):
- `GET /api/hologram/camera`: the camera's state.
- `POST /api/hologram/camera`: settings, `{controls: {...}}` or `{reset_controls: true}`.
- `GET /api/hologram/camera/frame?overlay=1`: the preview. The overlay marks the face, green while
  looking at the glass.

**For the Chooms.** They ask for the `"glass"` camera with `ha_get_camera_snapshot`. The snapshot is
saved and shown like their Home Assistant camera snapshots. It is refused when "Chooms can look
through this camera" is off.

**Settings** (`camera.json`):

| Key | Default | |
|---|---|---|
| `enabled` | `true` | the camera in use at all |
| `chooms` | `true` | the Chooms may take snapshots |
| `eye_contact` | `true` | she turns to you when you look |
| `yaw_limit` | `6.0` | degrees that count as looking at the glass |
| `welcome`, `welcome_minutes` | `true`, `20` | the welcome back, and how long away first |
| `controls` | `{}` | the camera's adjustments |

## Presence (Home Assistant)

`server.py` checks Home Assistant every 5 seconds once `ha_url` and `ha_token` exist.
`presence.json` (optional) maps roles to entities. Each role is either an entity id, present when it
reads home, on, detected, occupied or true, or `{"entity": ..., "equals": ...}`, present when it
reads exactly that value:

```json
{"home": {"entity": "sensor.phone_wi_fi_connection", "equals": "<home network>"},
 "shop": "binary_sensor.shop_presence",
 "bed": {"entity": "binary_sensor.bed_zone", "zone": true, "stays": true, "after": 180},
 "desk": {"entity": "binary_sensor.office_zone", "zone": true, "after": 60},
 "kitchen": {"entity": "binary_sensor.kitchen_zone", "zone": true, "after": 180}}
```

- **No `home` role.** The server uses the `person.` entity named by a `"person"` key
  (`{"person": "person.donny", "desk": ...}`), else the only person in Home Assistant, else the one
  named like `HOLOGRAM_OWNER` (default `donny`).
- **`ha_url`** should be an address that doesn't move: a hostname, or an IP the router always gives
  Home Assistant (a DHCP reservation). When it moves, presence and the weather station stop.
- **A page that has just started** gets the current presence at once (it only reached the page when it
  changed).
- **Arriving and leaving.** Arriving counts at once, or after `after` seconds present in a row. Leaving
  counts after two minutes absent (phones drop Wi-Fi now and then), or after `away_after` seconds.
  When the server starts, what Home Assistant says counts at once, so a relaunch keeps it.
- **Zones** (`"zone": true`) are the zones of one room sensor, such as Donny's Everything Presence Lite,
  a mmWave radar with bed, office and kitchen zones. You're in one zone at a time:
  - A radar blinks. A gap under 25 s doesn't break a stretch in a zone, unless another zone read you
    during it, and `after` is one stretch.
  - Settling in another zone (it starts to count) ends the one you left at once. Up and at the desk
    means out of bed.
- **A zone that stays** (`"stays": true`, the bed) works differently. The Lite's LD2450 radar tracks
  movement and loses someone lying still. On the first night the bed zone blinked on for 15 to 90 s
  whenever Donny moved and read empty in between, sometimes for an hour, and a moving sleeper showed up
  as short ghost readings in the office and kitchen zones too.
  - It counts once it's the last place you were seen, for its `after`, with no other zone holding you
    45 s or more since. The other zones count together for this: walking out the east door on Oct 18
    the office and kitchen read Donny by turns for over a minute, neither for 45 s on its own, and a
    single blip in the bed on the way out counted 3 minutes later with him outside (his phone still
    on the Wi-Fi). Ghosts at night are single blips between bed readings, so they don't add up.
  - It ends only when you settle in another zone, or when home ends. Rolling over, lying still, ghost
    readings and a short trip out of bed leave you in bed.
- **Donny's timings fit his room.** The office chair touches the bed, so bed needs 3 minutes; a brush of
  the bed zone as he stands up doesn't count. Desk needs a minute, so walking through the office doesn't
  count. Kitchen needs 3 minutes, so passing through it to the east door isn't "in the kitchen". Replayed
  against the first night's history: in bed 4 minutes after lying down, held until 7:07 when he'd been
  making coffee for 3 minutes, at the desk at 7:14. Against Oct 18's morning: out the door at 9:17 with
  no bed, back in through the kitchen at 12:28.
- **An entity that's gone** (renamed or removed in Home Assistant) leaves only its role unknown; the
  others go on. `/status` `presence_state` names it ("not found in Home Assistant").
- **What each role does.**
  - Coming home or sitting at the desk wakes the Choom on the glass, and she greets you.
  - Getting into bed puts the glass to sleep at any hour; getting up wakes it.
  - A sound near the tower (tower_ears thinks someone is talking) holds off the Chooms' quiet turns,
    but never keeps her awake or wakes her: the first night it woke her each time Donny turned over.
    It's logged as a count (`ears` `voice`) at most every 5 minutes.
  - From 11 pm to 5 am only coming home wakes her. Up in the night and back to bed, or a minute at the
    desk, leaves her asleep; typing, talking and the buttons still wake her (`sleepFrom`, `morningFrom`).
  - Any other role (a shop, a truck, the kitchen) is passed to the welcome back as where you were.
  - The welcome back is skipped while you're in bed. That's checked as the camera sees you: no other
    zone reads you, and the bed zone does or still counts you.

## Weather

`server.py` reads the town weather from the Choom app every 10 minutes (every 2 after a failure). If
`weather.json` maps any of `wind`, `gust`, `temperature` and `rain` to Home Assistant sensors, it reads
those every 2 minutes instead, also while the Choom app's weather can't be fetched:

```json
{"wind": "sensor.station_wind_average_10_minutes", "gust": "sensor.station_wind_gust",
 "temperature": "sensor.station_temperature", "rain": "sensor.station_precipitation_intensity"}
```

- **Windy** means a 10-minute average of 12 mph or gusts of 20, held for 20 minutes after the last
  such reading. While it's windy:
  - she plays her wind clips now and then, in the look she has on (an outfit needs its own; it's the
    Studio's Windy days pack);
  - warm dust drifts through the glass.
- **Rain** falls through the glass while `rain` (inches an hour) reads above zero. Without a mapped
  gauge, the town report's description decides. **Snow** follows the report.
- **A change in the sky** makes Genesis glance up (`skycheck`).
- **Temperature** picks warm or cold outfits ([Looks and outfits](#looks-and-outfits)).

## The Chooms asking the glass

The looking-glass skill in the Choom app (`skills/core/looking-glass`) gives each Choom four tools:

| Tool | Does |
|---|---|
| `glass_move` | a move at her next quiet moment on the glass, if that comes within half an hour |
| `glass_wear` | clothes from her closet on the glass, kept until bedtime unless she changes again (day clothes chosen by day: until 10 pm) |
| `glass_closet` | what she has (moves and clothes), never what she has on; it only lists, and its answer points her to `glass_wear` |
| `glass_wish` | puts clothes or a move she'd like on the wish list, without changing anything |

**How a request travels.** Like the camera, these go over the hologram feed:
1. `lib/glass-closet.ts` sends a `glass_request` event.
2. `server.py` matches it with `tools/closet.py` against her `alive.json` and the closet words Glass
   Studio writes to `portraits/<id>/closet.json`.
3. The server sends the page a `glass` event naming the clips to pick from, or the outfit.
4. It posts the answer to `/api/hologram/glass/result`.

**Matching.**
- **Places:** closet.json's `places` (written by the Studio from each place's description) for the
  places with a `to_` clip built; found by name or by the words of the description ("sit by the
  fire" finds the campfire). The answer says where she'll be ("go to your campfire ... You stay about
  ten minutes"), and `glass_closet` lists it as "go to your campfire". Walking on and off isn't asked
  for.
- **The campfire circle:** a request with the fire and a group word (together, all, everyone, us,
  sisters, circle, let's) from a Choom with a seat sends `circle` (and her own campfire as a move, if
  she has one). The answer says the room sits around the fire while they talk, for the next hour, if
  everyone in it has a seat; without a seat or a campfire it's a wish.
- **Moves:** selfie moves, full-body clips, and clips named for a move (dance, wave, kiss, and so on).
  A move plays in the clothes she has on: from her current pose if she has it there, else as a cut to
  her whole figure in those clothes, else through a pose change in them (Aloy raises her hand first).
  A move she has only in other clothes doesn't play; the page logs a `glass` entry with `missed`.
  The answer says so: a move only in an outfit is answered "only in <those clothes>: next time you're
  on the glass and quiet in it", and one only in clothes she can't wear yet becomes a wish. Answers name
  each move as something she does (`MOVE_NAMES` in `tools/closet.py`: "blow a kiss", "walk the runway").
- **Clothes:** outfits she can wear (with a `talk` clip), and her usual clothes, are matched.
  - Her usual clothes match by description: closet.json's `usual` plus what she holds in her main look
    (Optic's heart), or, when her usual look names no clothes, her main Subject from the Studio project
    without the person and the scene (Genesis's motes). "My wireframe dress" is Eve's usual dress.
  - "Usual", "normal", "own" on their own mean her usual clothes; beside a garment, colour or fabric
    they don't ("my own green dress" is her green dress).
  - A garment, colour or fabric she names has to be in the outfit: "a silk slip" never matches a
    cotton dress.
  - Scoring is 10 per garment, 3 per colour, 2 per other word.
  - A tie with her usual clothes goes to them ("my mint tee" is her usual tee, not the one under her
    cold-day jacket). A tie between warm and cold night clothes goes by the temperature. Any other tie
    is a coin toss.
  - The chosen outfit is kept in the page's wardrobe (localStorage).
- **Wishes:** a move or clothes with no match, or anything asked with `glass_wish`, goes in
  `portraits/<id>/wishes.json` (not in git). The Studio shows it on its Plan page. The file is written
  whole (a temp file swapped in); one that can't be read is read again, and if it stays unreadable it's
  kept beside it as `wishes.json.unreadable-<time>` rather than written over.

**By hand.** From the Mac, use `POST /api/hologram/glass {choom, op, what}` (home only). On the NUC,
use `POST 127.0.0.1:8765/glass`, answered locally. `/control {"glassReset": true}` forgets every
chosen outfit.

## Welcome back

When you sit back down after a while away (20 minutes by default), the Choom you last talked with one
to one welcomes you back.

**Being at the desk.** `server.py` counts you at the desk while the camera sees your face, or while
both of these hold:
- the NUC's keyboard or mouse was used in the last 30 seconds (GNOME's idle time);
- the camera saw you in the last 5 minutes.

GNOME also resets its idle time when the screens wake or the monitor layout is reapplied, so input
alone doesn't count. Without a camera, input alone decides.

**Across relaunches.** The last time you were at the desk (saved each minute while you are, and the
moment you leave) and the last welcome are kept in `desk.json` beside `server.py`, so a relaunch
(the Studio's after a build, say) doesn't start your time away over. Delete it and the next start
counts you as at the desk.

**The welcome.** On your return the server calls `POST /api/hologram/welcome {awayMinutes, place?}`:
- The Choom app picks your most recent genuine conversation (`lastUserMessageAt`; skipped if older
  than 12 hours).
- It runs her turn there with a note (`note: true` on `/api/chat`). The note is saved as a system
  message that the chat window doesn't show, and it never counts as your words.
- She knows from your conversation where you went. A Home Assistant role you were in while away (a
  shop, a truck) is passed on as `place`.

**When it's skipped.**
- At night (11 pm to 7 am). After 4 hours or more away, you are welcomed from 5 am.
- Within two hours of the last welcome.
- While you're already talking (a conversation in the last 2 minutes).
- While you're in bed.

**After she welcomes you.** The tower's reply window opens for her (`tower_ears.py` watches
`/status`), so you can answer without a wake phrase. The window waits for her answer to you, not for
a turn of hers in a room.

**Rooms.** A room the Chooms are running when she welcomes you stops before its next speaker:
1. The Choom app pauses it (`PUT /api/group-chat {pause: true}`).
2. A Choom whose `talk_with_sisters` was running it is told it paused, not finished.
3. When your conversation with her is over (the reply window closes unanswered), `tower_ears.py`
   posts `invited_done` and `server.py` sends `{done: true}`.
4. The room picks up where it stopped, with the Choom who was next speaking first.

Some cases run differently:
- A room that hadn't reached its next speaker yet just carries on.
- Your own message to a paused room takes its place.
- A pause request older than 15 minutes is dropped, and a room's new run clears one left from an
  earlier run.
- A welcome that fails (the chat can't be reached) resumes the rooms it paused at once.
- If the tower never says you're done, the room picks up after 15 minutes (`ROOMS_PAUSED_S` in
  `server.py`, once the tower has been quiet for 2). The Choom app does the same on its own after 15
  minutes without the hologram's done.

**Logging and tests.** Each leaving and returning is logged as `desk`. Welcomes and skips are logged as
`welcome`, and paused rooms as `rooms`. `POST /control {"welcomeTest": 30}` sends a real welcome now,
as if you had been away 30 minutes.

## Portrait buttons

Top = previous Choom, middle = next, hold bottom = listening (also interrupts her). `server.py` claims
the buttons' input device with `EVIOCGRAB`, so GNOME's media keys don't see them. It needs this udev
rule (e.g. `/etc/udev/rules.d/99-looking-glass-portrait.rules`, then
`sudo udevadm control --reload && sudo udevadm trigger`):

```
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{idVendor}=="05df", ATTRS{idProduct}=="16c0", GROUP="plugdev", MODE="0660"
```

## Screens

**Waking.** Only you wake GNOME's blanked screens, the Portrait included:
- the camera seeing you;
- a wake phrase at the tower;
- a Portrait button.

The Chooms' own activity never wakes them: a room they open at night, a heartbeat, a reply to your
phone.

**Blanking.** The screens go dark again after GNOME's idle delay (Settings → Power → Screen Blank) once
all three hold:
- the camera hasn't seen you for that long;
- the tower hasn't heard you for that long (a wake phrase or a reply);
- the keyboard and mouse haven't been touched for that long.

The server does this itself, because GNOME never re-blanks screens that were woken without a touch.
It doesn't blank while an app holds the screens on (a video playing). If GNOME starts its fade to dark
while the camera sees you, the server stops it.

**Display watchdog.** It puts a monitor back in the layout if GNOME leaves it connected but off for 6 s
after an input switch (`display_fix` in telemetry): the primary monitor at the left, the others to its
right, the Portrait at the far right. The Portrait is never made primary, and no output is listed twice.

Each wake and blank is logged as `screens`.

## Everything else on the page

- **Group stage.**
  - A room turn brings the Chooms in that room to the glass, however many there are. All of them come
    when the room isn't known, as with "OK Chooms".
  - After dark (or asked for) a room of two to four with seats sits around a campfire instead (The
    campfire circle, above).
  - The speaker stands in front, and her sisters stand smaller behind her, turned toward her. When the
    turn passes, the two trade places.
  - A Choom's 1:1 reply during a room comes to the front instead of folding the stage away.
  - The stage folds back three minutes after the room goes quiet, or when you talk to one of them on
    her own.
- **Thinking.** While she waits on her model (a heartbeat's tools can take minutes) she plays her
  base loop and her calm facing clips, with a look up or down at most every 30 seconds.
- **Tool moments.** The glass flares and she plays a clip that fits the tool (`TOOL_LOOKS`):
  - looking around for a camera, a picture or a search;
  - daydreaming for a memory search;
  - a look at the sky for the weather;
  - a playful look while making an image.
- **Mishaps.** A failed tool (`tool_failed`), or her saying a picture didn't come out right, brings
  her `oops` face once, at most every two minutes.
- **While you only look at her** (the camera, no typing or talking), expressions, mishap faces, tool
  moments, picture looks and selfie moves still play and play out.
- **Waiting moments expire.** An expression, mishap face or tool look she couldn't play within 90 s
  (she left the glass, or was asleep) is dropped, not played when she comes back.
- **Pictures.**
  - A picture she makes or analyzes floats for about 11 seconds (8 for a camera snapshot), drawn over
    her. Tall pictures float beside her face, and wide ones lower right.
  - She turns to it with her picture looks. A look without them (an outfit) uses its glance or
    look-down clip.
  - She doesn't look up while a picture is showing.
- **Expressions.** A feeling in what you said plays before she answers (`FEELINGS` word lists). A
  feeling in what she says plays once her turn is over and she has stopped talking (the last one she
  said), never mid-sentence. You looking at her doesn't hold one back. In a look without that
  expression (most outfits, until the Studio's Expressions pack is rendered for them) she plays its
  nearest clip instead (`FEEL_LIKE`: a smile or laugh, raised brows, a head tilt, a look down, a shrug).
  The first chat after 8 hours or more opens with her lighting up.
- **Night.**
  - From 11 pm to 7 am, after ten quiet minutes, she yawns, dozes off and the glass dims. She dozes
    off only if she has a sleep loop and a wake clip.
  - Typing, talking, a reply, a button or 7 am wakes her.
  - Heartbeats and delegated tasks that start at night run unseen.
  - At bedtime a Choom on the glass who can't sleep (no sleep clips yet) hands it to one who can, so
    the glass dims instead of staying lit.
- **Background turns.** A heartbeat that starts during a conversation also runs unseen, so it doesn't
  take the front or float its pictures mid-conversation. A conversation means the stage is up, someone
  is talking, or there was a chat in the last three minutes.
- **Screensaver.**
  - After two quiet minutes, a random Choom takes the glass every 3 to 5 minutes.
  - It doesn't switch while she's asleep or just woke, while the stage is up, while you look at her,
    or while someone talks near the tower.
  - A Choom who hasn't been on the glass for 45 minutes greets as she arrives.
  - The one leaving walks off and the next walks on, each if she has the clips (Walking off and on,
    under Clips, moods and poses). No turn passes while a Choom is at one of her places.
- **Safeguards.**
  - A clip that can't be played (removed or replaced by a build before the relaunch, a bad encode) is
    left out until the next launch and another plays; only four failures in a row show her still relief.
  - A turn whose end never arrives (the Mac feed dropped mid-turn) is closed after 15 minutes without a
    word of it, or as soon as the server's feed reconnects (`feed` event), so she can sleep again.
  - The bottom button held (or L) counts as listening for a minute at most, in case the release is lost.
  - A lost WebGL context reloads the page after 5 s.
  - The app's mute is replayed to a page that just started, so a relaunch doesn't unmute the glass.
- **A fifth Choom.** Her frame and orb colours come from `manifest.json` (`color`), her voice from
  `voice` there if set, the stage arranges any number of sisters on an arc behind the speaker, number
  keys go to 9, and her home pose comes from `alive.json` (`home`) when the build writes it.

## Debugging

`POST /control` on the server (127.0.0.1:8765):

| Body | Does |
|---|---|
| `{"choom": "eve"}`, `{"action": "next"}` / `"prev"` | switch Choom |
| `{"listening": true}` | show her listening (`false` to stop) |
| `{"voice": false}` | mute the glass (`true` to unmute); use it for tests at night |
| `{"view": 24}` / `{"view": false}` | one of the 48 views full screen / back |
| `{"quilt": true}` | the raw quilt (tile i at column i%8, row i//8 from the bottom) |
| `{"clip": 5}` | jump to a clip of the Choom on the glass |
| `{"stage": true, "room": ["Aloy", "Eve"]}` / `{"stage": false}` | the group stage (all four without `room`) |
| `{"quietTurn": "genesis"}` | a screensaver turn now, to that Choom (walking off and on if both can) |
| `{"circle": true, "room": ["aloy", "eve", "genesis"], "standIn": true, "order": ["genesis", "eve", "aloy"]}` / `{"circle": false}` | the campfire circle now (`standIn`: Chooms without seats sit in their usual clips, to try the layout; `order`: who sits where, left to right, instead of `circleOrder`) |
| `{"sleep": true}`, `{"hour": 22}` | doze now; pretend it's 10 pm (`null` to stop) |
| `{"weather": {"wind": 25, "temperature": 40}}` | pretend weather (replaced by the next real reading) |
| `{"presence": {"bed": true}}` | pretend presence (`null` clears a role) |
| `{"gaze": true}` | pretend you're looking at the glass |
| `{"picture": "<image id>"}` | float a gallery picture |
| `{"glassReset": true}` | forget clothes the Chooms chose |
| `{"welcomeTest": 30}` | send a real welcome back now |
| `{"mouthStyle": 3}`, `{"jaw": 0.6}` | try a mouth style (0 to 3); hold her mouth open (`null` to let go) |
| `{"body": true}` | the experimental 3D body, if `bodies/<id>.glb` exists |
| `{"closeTurn": true}` | close an open turn as if its end were lost (the watchdog's path) |
| `{"loseContext": true}` | lose the WebGL context (the page reloads after 5 s) |

**Other hooks.**
- `POST /simulate` injects a Choom-app event, e.g. `{"event": "tool", "choom": "Genesis", "tool": "get_weather"}`.
  Use `"source": "test"` for spoken test lines, so they don't count as your conversation (the voice
  defaults to hers).
- `POST /glass` answers a glass request locally, e.g. `{"choom": "genesis", "op": "move", "what": "twirl"}`.
- `GET /status` shows the page, the feed, weather, presence, camera, the welcome watch, the
  listener's state and `tower_conversation` (whether a conversation at the tower is under way).
- `GET /events` is the page's feed. A page that connects first gets the current state: the app's mute,
  presence, gaze and weather. After the Choom feed from the Mac drops and reconnects, the server sends
  the page `{"type": "feed", "state": "reconnected"}`.

**Telemetry** (`telemetry.log`, JSON lines, rotated at 50 MB):

| Kind | From | |
|---|---|---|
| `status` | page | every 2 s: Choom, mood, clip, fps, voice, paused, queue |
| `alive-clip`, `choom`, `stage`, `circle`, `quiet-turn` | page | clips played, Choom switches, the stage and the campfire circle (`members`), screensaver turns (`why: bedtime` for a hand-over to a Choom who can sleep; `walkOff`, `walkOn` when she walks off or the next walks on) |
| `turn-closed` | page | a turn closed by the watchdog or a feed reconnect |
| `latency`, `lipsync`, `speak`, `gap` | page, server | voice timing |
| `tool`, `picture`, `glass`, `chime`, `tuning`, `button`, `error` | page, server | moments, requests, keys, errors |
| `ears`, `eyes`, `gaze-seen` | server, page | the tower's listener and camera (never words or frames) |
| `desk`, `welcome`, `rooms` | server | welcome back |
| `screens`, `display_fix`, `weather`, `camera` | server | screens, monitor layout, weather changes, camera settings and snapshots |
| `recovery`, `feed` | server | a page relaunch or a helper restarted or stopped (also in `recovery.log`); the Choom feed reconnecting |

`tools/deinterleave.py OUT.jpg [view ...]` grabs the Portrait and rebuilds individual views. Use it to
check depth without standing in front of the glass; run it with a Python that has numpy and Pillow. It
finds the calibration in `calibration/` as the server does (`HOLOGRAM_CALIBRATION` names one).

## Still portraits (fallback)

`portraits/` also holds a still relief per Choom, made from the concept renders in `sources/`:

```
U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python tools/make_masks.py
~/pinokio/api/forge-neo/app/venv/bin/python tools/make_depth.py
~/pinokio/api/forge-neo/app/venv/bin/python tools/make_landmarks.py
```

`body.js` can show a rigged 3D avatar instead (`bodies/<id>.glb`; B with the readout up). It is kept
for experiments; the moving reliefs are what look like the Chooms.
