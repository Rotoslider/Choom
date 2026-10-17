#!/usr/bin/env bash
# Opens a hologram page full-screen on the Looking Glass Portrait.
#   ./launch.sh               living portraits (default)
#   ./launch.sh first-light   the calibration test scene
#   ./launch.sh stop          close everything
set -euo pipefail
# The real folder, not a symlink to it (~/projects/looking _glass_choom/hologram): started through the
# link, the processes carried its path, stop_all's patterns missed them, and a second mic listener
# heard Donny's words and sent them to Genesis twice (2026-10-11).
DIR="$(cd "$(dirname "$0")" && pwd -P)"
PORT=8765
PROFILE="$DIR/.chrome-profile"
PAGE="${1:-living}"

CHOOM_URL="${CHOOM_URL:-http://donnys-mac-studio-3.local:3000}"

# Hand the processes started below none of the file descriptors we were given: a caller's lock (flock
# around relaunch_when_quiet.sh) went to the server, the mic, the camera and Chrome, and no later relaunch
# could take it while they ran.
for fd in /proc/$$/fd/*; do
  fd=${fd##*/}
  if (( fd > 2 && fd != 255 )); then eval "exec $fd>&-" 2>/dev/null || true; fi
done

# Logs are appended, so a crash's traceback survives the next relaunch (they were emptied on every one,
# 44 a week), and each is rotated past 5 MB with one old copy kept. Prints the path for a redirect.
logto() {
  local f="$DIR/$1"
  if [[ -f "$f" && $(stat -c %s "$f") -gt 5000000 ]]; then mv -f "$f" "$f.1"; fi
  printf '\n== %s launch ==\n' "$(date '+%F %T')" >> "$f"
  echo "$f"
}

stop_all() {
  pkill -f -- "--user-data-dir=$PROFILE" || true
  pkill -f -- "$DIR/server.py" || true
  pkill -f -- "$DIR/tower_ears.py" || true
  pkill -f -- "$DIR/tower_eyes.py" || true
  pkill -f -- "pw-record --rate (16000|48000) --channels 1 --format s16 -" || true  # its recorder
  # Hand the voice back to the browsers right away instead of waiting for the heartbeat to lapse.
  curl -s -m 3 -X POST -H 'Content-Type: application/json' -d '{"voice":false}' \
    "$CHOOM_URL/api/hologram/voice" > /dev/null || true
  # Chrome reuses a still-running instance for a new launch; wait until the old one is gone.
  for _ in $(seq 20); do pgrep -f -- "--user-data-dir=$PROFILE" > /dev/null || break; sleep 0.25; done
}

if [[ "$PAGE" == "stop" ]]; then
  stop_all
  exit 0
fi
if [[ ! -f "$DIR/$PAGE.html" ]]; then
  echo "No page named $PAGE ($DIR/$PAGE.html)" >&2
  exit 1
fi

# The Portrait is the connected output running at its native 1536x2048.
GEOM=$(xrandr --query | grep " connected" | grep -o "1536x2048+[0-9]*+[0-9]*" | head -1 || true)
if [[ -z "$GEOM" ]]; then
  echo "Portrait not found: no connected display is running 1536x2048." >&2
  exit 1
fi
POS=${GEOM#1536x2048+}
X=${POS%+*}
Y=${POS#*+}

stop_all
sleep 0.5
nohup python3 "$DIR/server.py" --port "$PORT" >> "$(logto server.log)" 2>&1 &
sleep 0.5
# The tower's ears ("OK Aloy"), when their venv is set up (see README); HOLOGRAM_EARS=0 turns them off.
if [[ -x "$DIR/.venv-ears/bin/python" && "${HOLOGRAM_EARS:-1}" != 0 ]]; then
  nohup "$DIR/.venv-ears/bin/python" "$DIR/tower_ears.py" >> "$(logto ears.log)" 2>&1 &
fi
# The tower's eyes (is he looking at the glass?); they wait quietly until a camera is plugged in.
if [[ -x "$DIR/.venv-ears/bin/python" && "${HOLOGRAM_EYES:-1}" != 0 ]]; then
  nohup "$DIR/.venv-ears/bin/python" "$DIR/tower_eyes.py" >> "$(logto eyes.log)" 2>&1 &
fi
# Glass Studio (studio/README.md) on port 8767, if it isn't already up. Relaunches leave it running,
# so a render it started keeps its watcher; HOLOGRAM_STUDIO=0 turns it off.
if [[ "${HOLOGRAM_STUDIO:-1}" != 0 ]] && ! pgrep -f -- "^python3 .*studio/studio\.py serve" > /dev/null; then
  setsid nohup python3 "$DIR/studio/studio.py" serve >> "$(logto studio/studio.log)" 2>&1 < /dev/null &
fi

# The glass takes the keyboard when its window opens; give it back to the window that had it (a space
# typed for the terminal reached the glass and paused her particles, 2026-10-15).
FOCUSED=$(xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | grep -o '0x[0-9a-f]*' || true)
if [[ -n "$FOCUSED" && "$FOCUSED" != 0x0 ]]; then
  setsid nohup python3 "$DIR/tools/focus_back.py" "$FOCUSED" "$PROFILE" > /dev/null 2>&1 < /dev/null &
fi

nohup google-chrome \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --noerrdialogs --disable-session-crashed-bubble \
  --window-position="$X,$Y" --window-size=1536,2048 --kiosk \
  --force-device-scale-factor=1 \
  --ignore-gpu-blocklist \
  --disable-features=HardwareMediaKeyHandling,Translate \
  --autoplay-policy=no-user-gesture-required \
  "http://127.0.0.1:$PORT/$PAGE.html" >> "$(logto chrome.log)" 2>&1 &

echo "Opening $PAGE on the Portrait at +$X+$Y"
