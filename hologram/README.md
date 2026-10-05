# Choom hologram (Looking Glass Portrait)

The Chooms as live 3D portraits on a Looking Glass Portrait. They show who is talking and speak
replies in each Choom's own voice. This client runs on the machine the Portrait is plugged into
(the NUC with the RTX PRO 6000). It follows the Choom app on the Mac through
`/api/hologram/events` (see `nextjs-app/lib/hologram-bus.ts`).

## Run

```
./launch.sh               # living portraits, full-screen on the Portrait
./launch.sh first-light   # calibration test scene
./launch.sh stop          # close it and hand the voice back to the browsers
```

`launch.sh` finds the Portrait as the display running 1536x2048, starts `server.py` on
127.0.0.1:8765 and opens a Chrome kiosk window on it with its own profile. Set `CHOOM_URL` if the
Choom app is not at `http://donnys-mac-studio-3.local:3000`.

## How it works

- **Rendering:** `lenticular.js` draws 48 views (8x6 quilt, 3360x3360) from an off-axis camera rig
  and interleaves them with the Portrait's factory calibration (`calibration/`), so Looking
  Glass Bridge is not needed. `living.js` shows each Choom as two RGB-D layers (her cut-out in
  front, a background plate with her painted out behind), with idle sway and breathing, her own
  particles, and for Aloy an atom of four orbiting sister orbs on 3D gold threads.
- **3D bodies:** a Choom with `bodies/<id>.glb` (an Avaturn T2 export: rigged, with ARKit and
  Oculus viseme blend shapes) appears as that avatar instead of her relief (`body.js`). Her arms
  come down from the T-pose, she's framed by her eyes on the focal plane, and every material gets
  the light treatment: lit from within, a rim in her colors, scan lines, a fade at the bottom,
  Optic's scan band, Genesis's motes, Eve's wireframe, and a build-up from below as she appears.
  She breathes, sways, blinks, glances around, leans in to listen and looks away to think, and
  HeadAudio's visemes drive her blend shapes directly. B flips between body and relief; Chooms
  without a body borrow `bodies/standin/avaturn.glb` (TalkingHead's Avaturn sample) if you
  download it there. The GLBs aren't committed (the repo is public); each Choom's avatar lives in
  the Avaturn account and re-exports from its editor (Download, Avatar (T-Pose)). Avaturn has no
  photo upload on its phone flow, but hub.avaturn.me/create/upload takes the front and side
  photos directly; pick V2 (face blendshapes), and "Left" is the photo with her nose toward
  image-right. A model with no skeleton (a generated bust, e.g. from Hunyuan3D 2.1) works too: it's
  framed by its bounds and gets the light treatment and sway, but no lips or blinks. Put trial models in
  `bodies/preview/<id>.glb`: B shows them, but they never replace the relief by default.
- **Lip sync:** HeadAudio (`vendor/headaudio`, MIT) reads mouth shapes (visemes) from her voice in
  an audio worklet. A shader opens her jaw, rounds or spreads her lips and fills the opening with
  a mouth tinted from her own lips, at the mouth position found by `tools/make_landmarks.py`. Her
  audio is delayed 80 ms so voice and lips line up. Each spoken turn posts a `latency` entry
  (first text, first voice, gaps between pieces) to `telemetry.log`.
- **Choom app link:** `server.py` relays the Choom app's feed to the page and proxies speech to
  the app's `/api/tts`. She speaks only a conversation a browser at home has open (the app marks
  each sentence `speak`). While the hologram runs it posts a heartbeat to `/api/hologram/voice`, so
  browsers at home stay quiet and every reply is heard once. The web app's mute button stops her.
- **Portrait buttons:** top = previous Choom, middle = next, hold bottom = listening (also
  interrupts her). `server.py` claims the buttons' input device, which needs this udev rule:
  `SUBSYSTEM=="input", KERNEL=="event*", ATTRS{idVendor}=="05df", ATTRS{idProduct}=="16c0", GROUP="plugdev", MODE="0660"`
- **Screens:** the server wakes GNOME's blanked screens when you press a Portrait button or a
  Choom starts talking to you, and puts a monitor back in the layout if GNOME leaves it connected
  but off after an input switch (`HOLOGRAM_DISPLAY_WATCHDOG=0` turns that off).

Keys on the page: arrow keys or 1-4 switch Choom, hold L = listening, M = mute, B = body, `-`/`=` depth,
`[`/`]` calibration center, H = readout.

## Moving reliefs

A Choom can have a moving relief instead of a still one: a seamless idle loop of her own render
(blinks, breathing, a small head tilt) made with Wan2GP's MiniMax H3 first/last-frame model, turned
into `portraits/<id>/alive.mp4` (three stacked panels: color, depth, cut-out) and `alive.json` (frame
rate, focus, her mouth position on every frame, so lip sync follows her face). It plays in empty
glass (the still plate is hidden) with her live particles, atom and lip sync on top.

1. Clean her render (Aloy's gold rings and orbs) with a Flux.2 Klein edit, on black.
2. Make the loop: `wgp.py --process JOB.json` with `model_type` `minimax_h3_fl2va_pdd`,
   `image_prompt_type` `SE` and the clean image as both `image_start` and `image_end`.
3. `U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python tools/make_alive_masks.py <id> LOOP.mp4`
4. `~/pinokio/api/forge-neo/app/venv/bin/python tools/make_alive.py <id> LOOP.mp4`

## Portrait assets

`portraits/` is generated from the concept renders in `sources/`:

```
U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python tools/make_masks.py
~/pinokio/api/forge-neo/app/venv/bin/python tools/make_depth.py
~/pinokio/api/forge-neo/app/venv/bin/python tools/make_landmarks.py
```

`make_masks.py` cuts each Choom out (U2-Net). `make_depth.py` runs Depth Anything V2 Large, shapes
the depth for the panel, builds the background plates, and does Aloy's cleanup (gold threads and
orbs become live 3D). `make_landmarks.py` finds each mouth for lip sync (MediaPipe; writes
`mouth.json` and a `mouth_check.jpg`). `tools/deinterleave.py OUT.jpg [views]` rebuilds views from what the Portrait
is showing, to check depth without being in front of it.
