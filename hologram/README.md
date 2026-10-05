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

Keys on the page: arrow keys or 1-4 switch Choom, hold L = listening, M = mute, `-`/`=` depth,
`[`/`]` calibration center, H = readout.

## Portrait assets

`portraits/` is generated from the concept renders in `sources/`:

```
U2NET_HOME=~/pinokio/api/wan2gp/app/ckpts/rembg ~/pinokio/api/wan2gp/app/venv/bin/python tools/make_masks.py
~/pinokio/api/forge-neo/app/venv/bin/python tools/make_depth.py
```

`make_masks.py` cuts each Choom out (U2-Net). `make_depth.py` runs Depth Anything V2 Large, shapes
the depth for the panel, builds the background plates, and does Aloy's cleanup (gold threads and
orbs become live 3D). `tools/deinterleave.py OUT.jpg [views]` rebuilds views from what the Portrait
is showing, to check depth without being in front of it.
