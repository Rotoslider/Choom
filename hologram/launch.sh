#!/usr/bin/env bash
# Opens a hologram page full-screen on the Looking Glass Portrait.
#   ./launch.sh               living portraits (default)
#   ./launch.sh first-light   the calibration test scene
#   ./launch.sh stop          close everything
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
PROFILE="$DIR/.chrome-profile"
PAGE="${1:-living}"

CHOOM_URL="${CHOOM_URL:-http://donnys-mac-studio-3.local:3000}"

stop_all() {
  pkill -f -- "--user-data-dir=$PROFILE" || true
  pkill -f -- "$DIR/server.py" || true
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
nohup python3 "$DIR/server.py" --port "$PORT" > "$DIR/server.log" 2>&1 &
sleep 0.5

nohup google-chrome \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --noerrdialogs --disable-session-crashed-bubble \
  --window-position="$X,$Y" --window-size=1536,2048 --kiosk \
  --force-device-scale-factor=1 \
  --ignore-gpu-blocklist \
  --disable-features=HardwareMediaKeyHandling,Translate \
  --autoplay-policy=no-user-gesture-required \
  "http://127.0.0.1:$PORT/$PAGE.html" > "$DIR/chrome.log" 2>&1 &

echo "Opening $PAGE on the Portrait at +$X+$Y"
